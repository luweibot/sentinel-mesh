import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { z, ZodError } from "zod";
import { createLogger, type Logger } from "@sentinel-mesh/logger";
import type { AppConfig } from "@sentinel-mesh/config";
import {
  AgentTask,
  EventCatalog,
  createEnvelope,
  findManifest,
  MOCK_AGENT_MANIFESTS,
  SignalCreatedPayload,
  type PolicyDecision,
} from "@sentinel-mesh/contracts";
import type { EventPublisher } from "@sentinel-mesh/queue";
import type { PolicyEngine } from "@sentinel-mesh/policy-engine";
import { randomUUID } from "node:crypto";
import { registerExplorerRoutes } from "./explorer.js";

/**
 * Fastify application factory.
 *
 * The factory takes every external dependency as an argument (config, logger,
 * publisher, policy engine, probes, clock, uuid). This keeps the HTTP layer
 * fully testable in-process with fastify.inject() and no I/O.
 */

export const API_VERSION = "0.1.0";

export interface AppDeps {
  config: AppConfig;
  logger?: Logger;
  publisher: EventPublisher;
  policyEngine: PolicyEngine;
  /** "in-memory" or "bullmq"; reported by /health/ready. */
  busMode: string;
  /** Optional database probe used by /health/ready when DATABASE_URL is set. */
  dbProbe?: () => Promise<void>;
  /** Injectable clock/uuid for tests. */
  now?: () => Date;
  uuid?: () => string;
  /** Skip the GET /api/v1/payments stub (merged orchestrator serves real records). */
  skipPaymentsStub?: boolean;
}

/**
 * Shared route registration for the merged deployment.
 *
 * Registers the agent registry, the guarded signal pipeline, and the
 * explorer routes on an EXISTING Fastify instance (no CORS/error handlers
 * of its own — the host app owns those). The merged orchestrator service
 * calls this to serve the full API surface from one process.
 *
 * Not included here: health endpoints and the standalone POST /api/v1/tasks
 * event-publish variant — the merged orchestrator has engine-backed
 * equivalents.
 */
export function registerApiRoutes(app: FastifyInstance, deps: AppDeps): void {
  const logger =
    deps.logger ?? createLogger({ service: "api", level: deps.config.logLevel });
  const now = deps.now ?? (() => new Date());
  const uuid = deps.uuid ?? (() => randomUUID());

  /** Recent signals with their policy decisions (in-memory, dev-scale). */
  const signalBuffer: Array<{ signal: unknown; decision: PolicyDecision; recordedAt: string }> = [];

  // Agent registry
  // -------------------------------------------------------------------------

  app.get("/api/v1/agents", async () => ({
    agents: MOCK_AGENT_MANIFESTS,
    total: MOCK_AGENT_MANIFESTS.length,
  }));

  // -------------------------------------------------------------------------
  // Guarded signal pipeline: POST /api/v1/signals
  // -------------------------------------------------------------------------

  const CreateSignalBody = z
    .object({
      chain: z.enum(["base", "ethereum", "solana"]),
      kind: z.enum(["copy-trade", "trend-entry", "manual"]).optional(),
      tokenIn: z.string().min(1),
      tokenOut: z.string().min(1),
      notionalUsdCents: z.number().int().positive(),
      sourceWallet: z.string().min(1).optional(),
    })
    .strict();

  app.post("/api/v1/signals", async (request, reply) => {
    const body = CreateSignalBody.parse(request.body ?? {});

    const signal = SignalCreatedPayload.parse({
      signalId: uuid(),
      chain: body.chain,
      kind: body.kind ?? "copy-trade",
      tokenIn: body.tokenIn,
      tokenOut: body.tokenOut,
      notionalUsdCents: body.notionalUsdCents,
      sourceWallet: body.sourceWallet,
    });

    const signalEnvelope = createEnvelope(EventCatalog["signal.created"], signal, {
      actor: { kind: "system", id: "sentinel-mesh-api" },
      correlationId: signal.signalId,
    });
    await deps.publisher.publish(signalEnvelope);

    const decision: PolicyDecision = await deps.policyEngine.evaluate({
      schemaVersion: 1,
      signalId: signal.signalId,
      chain: signal.chain,
      tokenIn: signal.tokenIn,
      tokenOut: signal.tokenOut,
      notionalUsdCents: signal.notionalUsdCents,
      requestedAt: signalEnvelope.occurredAt,
    });

    const decisionEnvelope = createEnvelope(EventCatalog["policy.decision.recorded"], decision, {
      actor: { kind: "agent", id: "policy-guard" },
      correlationId: signal.signalId,
    });
    await deps.publisher.publish(decisionEnvelope);

    signalBuffer.unshift({ signal, decision, recordedAt: now().toISOString() });
    if (signalBuffer.length > 50) {
      signalBuffer.pop();
    }
    logger.info(
      { signalId: signal.signalId, verdict: decision.verdict, executionMode: decision.executionMode },
      "signal_evaluated",
    );

    return reply.code(202).send({
      signal,
      decision,
      execution: {
        status: "not-executed",
        reason:
          "phase 0 runs in simulation mode; no trade execution exists in this build, so no swap, transfer or signature was ever produced",
      },
    });
  });

  /** GET /api/v1/signals — recent attributed signals (dev in-memory buffer). */
  app.get("/api/v1/signals", async () => ({
    dataSource: "in-memory",
    signals: signalBuffer,
    detail:
      "Signals posted to POST /api/v1/signals, kept in an in-memory dev buffer (last 50). Each row is attributed to its source wallet and carries the policy decision. No signal executes anything in this phase.",
  }));

  registerExplorerRoutes(app, logger, now, deps.skipPaymentsStub ? { skipPaymentsStub: true } : {});

}

export function buildApp(deps: AppDeps): FastifyInstance {
  const logger =
    deps.logger ??
    createLogger({ service: "api", level: deps.config.logLevel });
  const now = deps.now ?? (() => new Date());
  const uuid = deps.uuid ?? (() => randomUUID());

  const app = Fastify({ logger: false });

  // CORS: browsers (web dashboard) are only allowed from configured
  // origins; server-to-server and zero-trust-proxy callers are unaffected.
  if (deps.config.allowedOrigins.length > 0) {
    app.register(cors, { origin: deps.config.allowedOrigins, credentials: false });
  }


  app.addHook("onRequest", async (request) => {
    logger.debug(
      { method: request.method, url: request.url, requestId: request.id },
      "http_request",
    );
  });

  app.setErrorHandler((error: FastifyError, _request, reply) => {
    if (error instanceof ZodError) {
      reply.code(400).send({ error: "VALIDATION_FAILED", issues: error.issues });
      return;
    }
    logger.error(
      { err: error.message, statusCode: error.statusCode ?? 500 },
      "unhandled_error",
    );
    reply.code(error.statusCode ?? 500).send({
      error: "INTERNAL_ERROR",
      message: deps.config.nodeEnv === "production" ? "internal error" : error.message,
    });
  });

  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send({ error: "NOT_FOUND" });
  });

  // -------------------------------------------------------------------------
  // Health endpoints
  // -------------------------------------------------------------------------

  app.get("/health", async () => ({
    status: "ok",
    service: "sentinel-mesh-api",
    version: API_VERSION,
    uptimeSec: Math.round(process.uptime()),
    time: now().toISOString(),
  }));

  app.get("/health/ready", async (_request, reply) => {
    const checks: Record<string, unknown> = {
      events: { mode: deps.busMode },
      policy: { mode: deps.config.policyMode, executionMode: deps.config.executionMode },
    };

    if (deps.config.databaseUrl && deps.dbProbe) {
      try {
        await deps.dbProbe();
        checks.database = { configured: true, status: "ok" };
      } catch (error) {
        checks.database = { configured: true, status: "unreachable" };
        return reply.code(503).send({
          status: "degraded",
          checks,
          detail: error instanceof Error ? error.message : "database unreachable",
        });
      }
    } else {
      checks.database = {
        configured: Boolean(deps.config.databaseUrl),
        status: "skipped",
      };
    }

    return {
      status: "ok",
      service: "sentinel-mesh-api",
      version: API_VERSION,
      checks,
    };
  });

  // -------------------------------------------------------------------------  // -------------------------------------------------------------------------
  // Task issuing: POST /api/v1/tasks (standalone API only; the merged
  // orchestrator serves the engine-backed equivalent)
  // -------------------------------------------------------------------------

  const CreateTaskBody = z
    .object({
      agentId: z.string().min(1),
      taskType: z.enum(["scan-trending", "monitor-wallet", "evaluate-signal", "simulate-trade"]),
      input: z.unknown().optional(),
      priority: z.enum(["low", "normal", "high"]).optional(),
    })
    .strict();

  app.post("/api/v1/tasks", async (request, reply) => {
    const body = CreateTaskBody.parse(request.body ?? {});

    const manifest = findManifest(body.agentId);
    if (!manifest) {
      return reply.code(404).send({
        error: "AGENT_NOT_FOUND",
        message: `no manifest registered for agentId '${body.agentId}'`,
      });
    }
    if (!manifest.supportedTaskTypes.includes(body.taskType)) {
      return reply.code(400).send({
        error: "TASK_TYPE_NOT_SUPPORTED",
        message: `agent '${manifest.agentId}' does not support task type '${body.taskType}'`,
      });
    }

    const task = AgentTask.parse({
      schemaVersion: 1,
      taskId: uuid(),
      assignedAgentId: manifest.agentId,
      taskType: body.taskType,
      input: body.input ?? null,
      issuedAt: now().toISOString(),
      priority: body.priority ?? "normal",
    });

    const envelope = createEnvelope(EventCatalog["agent.task.issued"], task, {
      actor: { kind: "system", id: "sentinel-mesh-api" },
    });
    await deps.publisher.publish(envelope);

    logger.info({ taskId: task.taskId, agentId: manifest.agentId }, "task_issued");
    return reply.code(202).send({ task });
  });

  // -------------------------------------------------------------------------
  // Shared API routes (agent registry, signal pipeline, explorer)
  // -------------------------------------------------------------------------
  registerApiRoutes(app, deps);

  return app;
}
