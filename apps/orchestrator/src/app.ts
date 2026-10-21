import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { timingSafeEqual } from "node:crypto";
import { z, ZodError } from "zod";
import { createLogger, type Logger } from "@sentinel-mesh/logger";
import type { AppConfig } from "@sentinel-mesh/config";
import { TaskType, WorkflowTransitionError, type AgentTask, type SkillRecord } from "@sentinel-mesh/contracts";
import type { OrchestrationEngine } from "@sentinel-mesh/orchestrator";
import { researchWorkflowPlan } from "@sentinel-mesh/agents";
import { TradeIntent, type ExecutionReceipt } from "@sentinel-mesh/contracts";
import type { ExecutionStack } from "./execution.js";
import type { PaymentsStack } from "./skills-payments.js";
import type { TreasuryStack } from "./treasury.js";
import { SkillIntakeRejectedError, SkillRegistryError, type SkillRegistry } from "@sentinel-mesh/skills";
import { registerApiRoutes } from "@sentinel-mesh/api";
import { buildProviders } from "@sentinel-mesh/chain-data";
import { FREE_ROUTES, SERVICE_CATALOG, findServiceByRoute, requirementForService } from "@sentinel-mesh/payments";
import { SUPPORTED_X402_VERSION, X402_VERSION_HEADER } from "@sentinel-mesh/contracts";
import type { EventPublisher } from "@sentinel-mesh/queue";
import type { PolicyEngine } from "@sentinel-mesh/policy-engine";

/**
 * Orchestrator service HTTP surface.
 *
 * Every dependency (engine, config, logger) is injected in buildApp, so the
 * whole service is integration-testable with fastify.inject() and no I/O.
 *
 * Endpoints:
 *  - GET  /health, GET /health/ready
 *  - POST /api/v1/tasks                       issue a single task
 *  - GET  /api/v1/tasks/:taskId               inspect a task record
 *  - POST /api/v1/workflows/research           run the 3-agent research workflow
 *  - GET  /api/v1/workflows/:runId             inspect a run + its tasks
 *  - POST /api/v1/workflows/:runId/cancel      cancel a run
 *  - GET  /api/v1/trace/:traceId              collaboration trace (event stream)
 */

export const ORCHESTRATOR_VERSION = "0.1.0";

export interface AppDeps {
  config: AppConfig;
  logger?: Logger;
  engine: OrchestrationEngine;
  /** Storage mode reported by /health/ready: "in-memory" | "postgres". */
  storageMode: string;
  dbProbe?: () => Promise<void>;
  /** Guarded execution stack; when absent, execution endpoints 503. */
  execution?: ExecutionStack;
  /** Skill registry; when absent, skills endpoints 503. */
  skills?: SkillRegistry;
  /** x402 payment guard; when absent, payment endpoints 503. */
  payments?: PaymentsStack;
  /**
   * Shared API routes (agent registry, signal pipeline, explorer). When
   * present, this single service also serves the retired API service's
   * surface — one process, one public URL, one set of instance hours.
   */
  api?: {
    publisher: EventPublisher;
    policyEngine: PolicyEngine;
    /** "in-memory" | "bullmq" — reported by /health/ready. */
    busMode: string;
  };
  /**
   * Treasury gas top-up. When enabled, every NEW settled x402 payment
   * (not an idempotent replay) schedules a deficit-only conversion of
   * the received USDC into ETH (Base) and — once its oracle is wired —
   * SOL (Solana) gas. Settlement never depends on the top-up: it runs
   * detached, and its failure is logged, never surfaced to the payer.
   */
  treasury?: TreasuryStack;
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const logger = deps.logger ?? createLogger({ service: "orchestrator", level: deps.config.logLevel });
  const app = Fastify({ logger: false });

  // CORS: browsers (web dashboard) are only allowed from configured
  // origins; server-to-server and zero-trust-proxy callers are unaffected.
  if (deps.config.allowedOrigins.length > 0) {
    app.register(cors, { origin: deps.config.allowedOrigins, credentials: false });
  }

  app.addHook("onRequest", async (request) => {
    logger.debug({ method: request.method, url: request.url, requestId: request.id }, "http_request");
  });

  app.setErrorHandler((error: FastifyError, _request, reply) => {
    if (error instanceof ZodError) {
      reply.code(400).send({ error: "VALIDATION_FAILED", issues: error.issues });
      return;
    }
    if (error instanceof WorkflowTransitionError) {
      reply.code(409).send({ error: "INVALID_STATE_TRANSITION", message: error.message });
      return;
    }
    if (error.statusCode === 404 || (error as { code?: string }).code === "FST_ERR_NOT_FOUND") {
      reply.code(404).send({ error: "NOT_FOUND" });
      return;
    }
    logger.error({ err: error.message, stack: error.stack }, "unhandled_error");
    // TEMP DIAGNOSTIC (remove after the merged-deploy task-issue 500 is
    // root-caused): EXPOSE_INTERNAL_ERRORS=true surfaces error details.
    const expose =
      process.env.EXPOSE_INTERNAL_ERRORS === "true" || deps.config.nodeEnv !== "production";
    reply.code(error.statusCode ?? 500).send({
      error: "INTERNAL_ERROR",
      message: expose ? `${error.message} [${(error as { code?: string }).code ?? "no-code"}]` : "internal error",
    });
  });

  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send({ error: "NOT_FOUND" });
  });

  // -------------------------------------------------------------------
  // Health
  // -------------------------------------------------------------------

  app.get("/health", async () => ({
    status: "ok",
    service: "sentinel-mesh-orchestrator",
    version: ORCHESTRATOR_VERSION,
    uptimeSec: Math.round(process.uptime()),
    time: new Date().toISOString(),
  }));

  app.get("/health/ready", async (_request, reply) => {
    const checks: Record<string, unknown> = {
      storage: { mode: deps.storageMode },
      policy: { mode: deps.config.policyMode, executionMode: deps.config.executionMode },
    };
    if (deps.api) {
      checks.queue = { mode: deps.api.busMode };
    }
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
      checks.database = { configured: Boolean(deps.config.databaseUrl), status: "skipped" };
    }
    return { status: "ok", service: "sentinel-mesh-orchestrator", version: ORCHESTRATOR_VERSION, checks };
  });

  // -------------------------------------------------------------------
  // Single tasks
  // -------------------------------------------------------------------

  const CreateTaskBody = z
    .object({
      agentId: z.string().min(1),
      taskType: TaskType,
      input: z.unknown().optional(),
      /** Deadline in milliseconds from now. */
      deadlineMs: z.number().int().positive().max(3_600_000).optional(),
      budgetMs: z.number().int().positive().max(3_600_000).optional(),
      idempotencyKey: z.string().min(1).max(128).optional(),
    })
    .strict();

  app.post("/api/v1/tasks", async (request, reply) => {
    const body = CreateTaskBody.parse(request.body ?? {});
    const task: AgentTask = await deps.engine.issueTask({
      agentId: body.agentId,
      taskType: body.taskType,
      input: body.input ?? null,
      deadlineAt: body.deadlineMs ? new Date(Date.now() + body.deadlineMs).toISOString() : undefined,
      budgetMs: body.budgetMs,
      idempotencyKey: body.idempotencyKey,
    });
    logger.info({ taskId: task.taskId, agentId: body.agentId }, "task_issued_via_http");
    return reply.code(202).send({ task });
  });

  app.get("/api/v1/tasks/:taskId", async (request, reply) => {
    const record = await deps.engine.getTask((request.params as { taskId: string }).taskId);
    if (!record) {
      return reply.code(404).send({ error: "TASK_NOT_FOUND" });
    }
    return { task: record };
  });

  // -------------------------------------------------------------------
  // Research workflow
  // -------------------------------------------------------------------

  const StartResearchBody = z
    .object({
      topic: z.string().min(1).max(200),
      maxDocuments: z.number().int().min(1).max(5).optional(),
      /** Wait for the workflow to settle before responding (default true). */
      awaitSettle: z.boolean().default(true),
    })
    .strict();

  app.post("/api/v1/workflows/research", async (request, reply) => {
    const body = StartResearchBody.parse(request.body ?? {});
    const plan = researchWorkflowPlan({ topic: body.topic, maxDocuments: body.maxDocuments });
    const { run, traceId } = await deps.engine.startWorkflow(plan);
    if (body.awaitSettle) {
      await deps.engine.settle();
    }
    const finalRun = (await deps.engine.getRun(run.runId)) ?? run;
    logger.info({ runId: finalRun.runId, traceId, status: finalRun.status }, "research_workflow_executed");
    return reply.code(200).send({
      run: finalRun,
      traceId,
    });
  });

  app.get("/api/v1/workflows/:runId", async (request, reply) => {
    const runId = (request.params as { runId: string }).runId;
    const run = await deps.engine.getRun(runId);
    if (!run) {
      return reply.code(404).send({ error: "RUN_NOT_FOUND" });
    }
    const tasks = await deps.engine.listTasks().then((all) => all.filter((t) => t.task.workflowRunId === runId));
    return { run, tasks };
  });

  app.post("/api/v1/workflows/:runId/cancel", async (request, reply) => {
    const runId = (request.params as { runId: string }).runId;
    const run = await deps.engine.cancelRun(runId);
    if (!run) {
      return reply.code(404).send({ error: "RUN_NOT_FOUND" });
    }
    return reply.code(202).send({ run });
  });

  // -------------------------------------------------------------------
  // Traces
  // -------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Guarded execution (paper only)
  // -------------------------------------------------------------------------

  const execution = deps.execution;
  if (execution) {
    /** DEV HARNESS: mint a short-lived authorization for one intent.
     *  In production this is a human/governance approver; the endpoint exists
     *  so the fail-closed flow can be exercised end to end. */
    app.post("/api/v1/execution/authorizations", async (request, reply) => {
      const { intent } = request.body as { intent?: unknown };
      const authorization = await execution.authorizations.issue(
        TradeIntent.parse(intent),
        "dev-harness-approver",
      );
      reply.code(201).send({ authorization });
    });

    /** Submit an authorized intent to the guarded paper executor. */
    app.post("/api/v1/execution/intents", async (request, reply) => {
      const body = request.body as { intent?: unknown; authorization?: unknown };
      const intent = TradeIntent.parse(body.intent);
      execution.submittedIntentIds.add(intent.intentId);
      const receipt: ExecutionReceipt = await execution.executor.submitIntent(intent, body.authorization as never);
      reply.code(200).send({ receipt });
    });

    /** Receipts for an intent, or the whole paper journal when no intentId. */
    app.get("/api/v1/execution/receipts", async (request) => {
      const intentId = (request.query as { intentId?: string }).intentId;
      const receipts = intentId
        ? await execution.executor.receiptsForIntent(intentId)
        : execution.ledger.all();
      return { receipts };
    });

    /** Kill-switch states (read-only snapshot). */
    app.get("/api/v1/execution/kill-switch", async () => ({
      snapshot: execution.killSwitch.snapshot(),
      semantics: "anything other than an explicit clear rejects execution; unknown fails closed",
    }));

    /** Reconciliation: ledger vs submitted intents. */
    app.get("/api/v1/execution/reconcile", async () => {
      const report = execution.ledger.reconcile([...execution.submittedIntentIds], () => new Date());
      return { report };
    });

    /** Uncertain live broadcasts: locked pending operator resolution
     * (audit 2026-10-21). The in-flight idempotency lock and the cap
     * reservation are RETAINED until resolve, so the tx cannot be
     * double-broadcast while it may still land onchain. */
    app.get("/api/v1/execution/uncertain", async () => ({
      uncertain: execution.executor.listUncertain(),
      semantics: "a live broadcast with an unknown outcome; the lock is retained until POST /api/v1/execution/uncertain/resolve after onchain reconciliation",
    }));

    /** Resolve an uncertain broadcast AFTER onchain reconciliation. */
    app.post("/api/v1/execution/uncertain/resolve", async (request, reply) => {
      const body = request.body as { intentId?: string; landed?: boolean; txHash?: string; executedOutRaw?: string; feeUsdCents?: number };
      if (!body.intentId) {
        reply.code(400).send({ error: "VALIDATION_FAILED", message: "intentId is required" });
        return;
      }
      if (typeof body.landed !== "boolean") {
        reply.code(400).send({ error: "VALIDATION_FAILED", message: "landed (boolean) is required" });
        return;
      }
      if (body.landed && !body.txHash) {
        reply.code(400).send({ error: "VALIDATION_FAILED", message: "landed=true requires the onchain txHash" });
        return;
      }
      try {
        const receipt = await execution.executor.resolveUncertain(body.intentId, {
          landed: body.landed,
          txHash: body.txHash,
          executedOutRaw: body.executedOutRaw,
          feeUsdCents: body.feeUsdCents,
        });
        reply.code(200).send({ resolved: true, landed: body.landed, receipt });
      } catch (error) {
        reply.code(404).send({ error: "NOT_FOUND", message: String(error) });
      }
    });

    /** Kill switch control: global, user, or strategy scope. */
    app.post("/api/v1/execution/kill-switch", async (request, reply) => {
      const body = request.body as { scope?: string; id?: string; state?: string };
      const scope = body.scope ?? "global";
      if (scope !== "global" && scope !== "user" && scope !== "strategy") {
        reply.code(400).send({ error: "VALIDATION_FAILED", message: "scope must be global|user|strategy" });
        return;
      }
      const state = body.state as "clear" | "engaged" | "unknown";
      if (!["clear", "engaged", "unknown"].includes(state)) {
        reply.code(400).send({ error: "VALIDATION_FAILED", message: "state must be clear|engaged|unknown" });
        return;
      }
      if (scope !== "global" && !body.id) {
        reply.code(400).send({ error: "VALIDATION_FAILED", message: "scope user|strategy requires id" });
        return;
      }
      // SECURITY (audit 2026-10-19): durable set — the state is journaled
      // (when storage is wired) BEFORE it is applied, so a restart can
      // never lose an ENGAGED switch.
      await execution.setKillSwitch(scope, body.id ?? null, state);
      reply.code(200).send({ scope, id: body.id ?? null, state });
    });
  }

  /** Recent workflow runs, newest first (dashboard traces page). */
  app.get("/api/v1/workflows", async () => {
    const runs = await deps.engine.recentRuns(20);
    return { runs };
  });

  app.get("/api/v1/trace/:traceId", async (request, reply) => {
    const traceId = (request.params as { traceId: string }).traceId;
    const events = deps.engine.getTrace(traceId);
    if (events.length === 0) {
      return reply.code(404).send({ error: "TRACE_NOT_FOUND" });
    }
    return {
      traceId,
      eventCount: events.length,
      events,
    };
  });

  // -------------------------------------------------------------------------
  // Skill registry (review-gated; nothing installs without approval)
  // -------------------------------------------------------------------------

  const skills = deps.skills;
  if (skills) {
    /** Registry listing: versions, review states, active flags, history. */
    app.get("/api/v1/skills", async () => ({
      skills: skills.list().map((record: SkillRecord) => ({
        skillId: record.manifest.skillId,
        name: record.manifest.name,
        version: record.manifest.version,
        reviewStatus: record.reviewStatus,
        testStatus: record.testStatus,
        contentFlaggedSuspicious: record.contentFlaggedSuspicious,
        isActive: record.isActive,
        declaredCapabilities: record.manifest.declaredCapabilities,
      })),
    }));

    /** Submit a candidate for review. NEVER installs anything: the record
     *  lands as "submitted" and awaits an explicit human approval. */
    app.post("/api/v1/skills/submit", async (request, reply) => {
      const body = request.body as { manifest?: unknown; content?: unknown };
      try {
        const { record, report } = skills.submit({ manifest: body.manifest, content: body.content });
        reply.code(201).send({ record, report });
      } catch (error: unknown) {
        if (error instanceof SkillIntakeRejectedError) {
          reply.code(422).send({ error: "SKILL_INTAKE_REJECTED", report: error.report });
          return;
        }
        if (error instanceof SkillRegistryError) {
          reply.code(409).send({ error: "SKILL_REGISTRY_ERROR", code: error.code, message: error.message });
          return;
        }
        throw error;
      }
    });

    /** Explicit human approval (and rejection). */
    app.post("/api/v1/skills/approve", async (request, reply) => {
      const body = request.body as { skillId?: string; version?: string; reviewerId?: string };
      try {
        if (!body.skillId || !body.version || !body.reviewerId) {
          reply.code(400).send({ error: "VALIDATION_FAILED", message: "skillId, version, reviewerId are required" });
          return;
        }
        const record = skills.approve(body.skillId, body.version, body.reviewerId);
        reply.code(200).send({ record });
      } catch (error: unknown) {
        if (error instanceof SkillRegistryError) {
          reply.code(409).send({ error: "SKILL_REGISTRY_ERROR", code: error.code, message: error.message });
          return;
        }
        throw error;
      }
    });

    app.post("/api/v1/skills/reject", async (request, reply) => {
      const body = request.body as { skillId?: string; version?: string; reviewerId?: string; reason?: string };
      try {
        if (!body.skillId || !body.version || !body.reviewerId) {
          reply.code(400).send({ error: "VALIDATION_FAILED", message: "skillId, version, reviewerId are required" });
          return;
        }
        const record = skills.reject(body.skillId, body.version, body.reviewerId, body.reason ?? "no reason given");
        reply.code(200).send({ record });
      } catch (error: unknown) {
        if (error instanceof SkillRegistryError) {
          reply.code(409).send({ error: "SKILL_REGISTRY_ERROR", code: error.code, message: error.message });
          return;
        }
        throw error;
      }
    });

    /** Install (activate) an APPROVED version. Explicit only. */
    app.post("/api/v1/skills/install", async (request, reply) => {
      const body = request.body as { skillId?: string; version?: string; reviewerId?: string };
      try {
        if (!body.skillId || !body.version || !body.reviewerId) {
          reply.code(400).send({ error: "VALIDATION_FAILED", message: "skillId, version, reviewerId are required" });
          return;
        }
        const record = skills.install(body.skillId, body.version, body.reviewerId);
        reply.code(200).send({ record });
      } catch (error: unknown) {
        if (error instanceof SkillRegistryError) {
          reply.code(409).send({ error: "SKILL_REGISTRY_ERROR", code: error.code, message: error.message });
          return;
        }
        throw error;
      }
    });

    /** Rollback to the previous approved version. */
    app.post("/api/v1/skills/rollback", async (request, reply) => {
      const body = request.body as { skillId?: string; reviewerId?: string };
      try {
        if (!body.skillId || !body.reviewerId) {
          reply.code(400).send({ error: "VALIDATION_FAILED", message: "skillId, reviewerId are required" });
          return;
        }
        const result = skills.rollback(body.skillId, body.reviewerId);
        reply.code(200).send(result);
      } catch (error: unknown) {
        if (error instanceof SkillRegistryError) {
          reply.code(409).send({ error: "SKILL_REGISTRY_ERROR", code: error.code, message: error.message });
          return;
        }
        throw error;
      }
    });
  }

  // -------------------------------------------------------------------------
  // x402 payments (mock facilitator; content access only, never trading)
  // -------------------------------------------------------------------------

    // -------------------------------------------------------------------
    // Shared API routes (merged deployment)
    // -------------------------------------------------------------------
    if (deps.api) {
      registerApiRoutes(app, {
        config: deps.config,
        publisher: deps.api.publisher,
        policyEngine: deps.api.policyEngine,
        busMode: deps.api.busMode,
        logger,
        skipPaymentsStub: true,
        providers: buildProviders(deps.config.dataSource),
        // policyMode=enforce (ADR-016): an "allow" policy verdict with
        // explicit amounts authorizes and submits a guarded intent.
        // Wired only when the execution stack exists; the endpoint fails
        // closed when the posture is enforce and this port is absent.
        ...(deps.execution
          ? {
              enforcement: {
                authorizeAndSubmit: async (request) => {
                  const intent = TradeIntent.parse({
                    schemaVersion: 1,
                    intentId: request.signalId,
                    userId: request.userId,
                    strategyId: request.strategyId,
                    chain: request.chain,
                    tokenIn: request.tokenIn,
                    tokenOut: request.tokenOut,
                    amountInRaw: request.amountInRaw,
                    minAmountOutRaw: request.minAmountOutRaw,
                    maxFeeUsdCents: request.maxFeeUsdCents,
                    maxPriceImpactBps: request.maxPriceImpactBps,
                    deadline: new Date(Date.now() + 5 * 60_000).toISOString(),
                  });
                  const authorization = await deps.execution!.authorizations.issue(intent, "signal-policy-enforcer");
                  const receipt = await deps.execution!.port.submitIntent(intent, authorization);
                  return {
                    receiptId: receipt.receiptId,
                    intentId: receipt.intentId,
                    status: receipt.status,
                    executionMode: receipt.executionMode,
                    txHash: receipt.txHash,
                    paperTxHash: receipt.paperTxHash,
                    rejectionCode: receipt.rejectionCode,
                    rejectionDetail: receipt.rejectionDetail,
                  };
                },
              },
            }
          : {}),
      });
    }


  // -----------------------------------------------------------------
  // Operator authentication for state-changing routes (audit 2026-10-21):
  // the x402 gate below grants CONTENT access only — execution control
  // (intents, authorizations, kill switch, uncertain resolution, skills
  // lifecycle, task/workflow control) must additionally authenticate the
  // operator with a bearer token. ENFORCED whenever OPERATOR_API_TOKEN is
  // configured; when unset the routes stay open (dev/paper) and every
  // state-changing response carries a warning header so the gap stays
  // visible until the token is deployed.
  // -----------------------------------------------------------------
  const OPERATOR_PROTECTED_ROUTES = new Set([
    "POST /api/v1/tasks",
    "POST /api/v1/workflows/research",
    "POST /api/v1/workflows/:runId/cancel",
    "POST /api/v1/execution/authorizations",
    "POST /api/v1/execution/intents",
    "POST /api/v1/execution/uncertain/resolve",
    "POST /api/v1/execution/kill-switch",
    "POST /api/v1/skills/submit",
    "POST /api/v1/skills/approve",
    "POST /api/v1/skills/reject",
    "POST /api/v1/skills/install",
    "POST /api/v1/skills/rollback",
  ]);
  if (deps.config.operatorApiToken) {
    const expected = Buffer.from(`Bearer ${deps.config.operatorApiToken}`);
    app.addHook("preHandler", async (request, reply) => {
      const route = `${request.method} ${request.routeOptions?.url ?? ""}`;
      if (!OPERATOR_PROTECTED_ROUTES.has(route)) {
        return;
      }
      const header = Buffer.from(String(request.headers["authorization"] ?? ""));
      const ok = header.length === expected.length && timingSafeEqual(header, expected);
      if (!ok) {
        reply.code(401).send({
          error: "UNAUTHORIZED",
          message: "this route requires an operator bearer token (Authorization: Bearer <OPERATOR_API_TOKEN>)",
        });
      }
    });
  } else {
    logger.warn("operator_api_token_not_configured: state-changing routes are unauthenticated (set OPERATOR_API_TOKEN; audit 2026-10-21)");
    app.addHook("onSend", async (request, reply, payload) => {
      if (request.method !== "GET" && request.method !== "HEAD") {
        reply.header("x-auth-warning", "operator token not configured; state-changing routes are unauthenticated (set OPERATOR_API_TOKEN)");
      }
      return payload;
    });
  }

  const payments = deps.payments;
  if (payments) {
    // -----------------------------------------------------------------
    // x402 gate: every priced route requires a confirmed payment for the
    // exact catalog amount, made to the project wallet, BEFORE the
    // handler responds. Unpaid requests receive 402 + the requirement.
    // -----------------------------------------------------------------
    const receiver = deps.config.paymentsReceiverAddress;
    app.addHook("preHandler", async (request, reply) => {
      const route = `${request.method} ${request.routeOptions?.url ?? ""}`;
      if (FREE_ROUTES.includes(route)) {
        return;
      }
      const service = findServiceByRoute(route);
      if (!service) {
        return; // unpriced routes (execution, task retrieval) stay open;
                // payments grant content access only, never trading.
      }
      const paymentId = (request.headers["x-payments"] ?? "") as string;
      if (paymentId) {
        const record = payments.guard.list().find((r) => r.paymentId === paymentId);
        // LIVE mode requires the payment to be SETTLED on-chain (the
        // facilitator confirmed receipt). PAPER mode accepts recorded
        // payments (mock settlement) for local development and tests.
        const statusOk =
          deps.config.paymentsMode === "live"
            ? record?.status === "settled"
            : record?.status === "settled" || record?.status === "recorded";
        const ok =
          record !== undefined &&
          statusOk &&
          record.grants.contentAccess === true &&
          record.amount === service.amountAtomic &&
          record.payTo.toLowerCase() === receiver.toLowerCase();
        if (ok) {
          return; // payment confirmed for this exact service price
        }
      }
      // No valid payment: answer 402 with the requirement the payer needs.
      reply.header(X402_VERSION_HEADER, SUPPORTED_X402_VERSION);
      reply.code(402).send({
        error: "PAYMENT_REQUIRED",
        serviceId: service.serviceId,
        priceUsd: service.priceUsd,
        requirement: requirementForService(service, receiver, deps.config.baseUsdcAddress),
        hint: "POST /api/v1/payments/verify with an x402 payment for the requirement, then retry with the paymentId in the X-PAYMENTS header",
      });
    });

    /** Public catalog: every priced service, its exact price and rationale. */
    app.get("/api/v1/payments/catalog", async () => ({
      receiver,
      asset: `USDC on Base (${deps.config.baseUsdcAddress})`,
      mode: deps.config.paymentsMode,
      services: SERVICE_CATALOG.map((svc) => ({
        serviceId: svc.serviceId,
        priceUsd: svc.priceUsd,
        amountAtomic: svc.amountAtomic,
        description: svc.description,
        rationale: svc.rationale,
      })),
    }));

    /** Requirement generator for a catalog service. */
    app.get("/api/v1/payments/requirement", async (request, reply) => {
      const serviceId = (request.query as { serviceId?: string }).serviceId;
      const svc = SERVICE_CATALOG.find((s) => s.serviceId === serviceId);
      if (!svc) {
        reply.code(404).send({ error: "SERVICE_NOT_FOUND", services: SERVICE_CATALOG.map((s) => s.serviceId) });
        return;
      }
      return { serviceId: svc.serviceId, requirement: requirementForService(svc, receiver, deps.config.baseUsdcAddress) };
    });
    /** Payment records + reconciliation report. */
    app.get("/api/v1/payments", async () => ({
      records: payments.guard.list(),
      reconcile: payments.guard.reconcile(),
      semantics: "a settled payment grants content access only; grants.trading is always false",
    }));

    /** Process a payment attempt against a requirement (idempotent by paymentId). */
    app.post("/api/v1/payments/verify", async (request, reply) => {
      const body = request.body as { agentId?: string; requirement?: unknown; payment?: unknown; paymentId?: string };
      if (!body.agentId || !body.paymentId) {
        reply.code(400).send({ error: "VALIDATION_FAILED", message: "agentId and paymentId are required" });
        return;
      }
      const verdict = await payments.guard.process({
        agentId: body.agentId,
        requirement: body.requirement,
        payment: body.payment,
        paymentId: body.paymentId,
      });
      reply.code(verdict.ok ? 200 : 422).send(verdict);
    });

    /** Submit settlement evidence for a recorded payment. */
    app.post("/api/v1/payments/settle", async (request, reply) => {
      const body = request.body as { paymentId?: string; transactionHash?: string };
      if (!body.paymentId) {
        reply.code(400).send({ error: "VALIDATION_FAILED", message: "paymentId is required" });
        return;
      }
      const verdict = await payments.guard.verifySettlement(body.paymentId, { transactionHash: body.transactionHash });
      reply.code(verdict.ok ? 200 : 422).send(verdict);
      // Treasury: a NEW settlement (not an idempotent replay) schedules a
      // deficit-only gas top-up from the just-arrived USDC revenue. Runs
      // detached after a short delay (RPC nodes lag state behind the
      // settlement receipt); the payer response never depends on it.
      if (verdict.ok && deps.treasury?.enabled && !(verdict.message ?? "").includes("replay")) {
        const treasury = deps.treasury;
        const timer = setTimeout(() => {
          void treasury.topUpGas()
            .then((result) =>
              logger.info(
                {
                  actions: result.plan.actions.map((a) => a.kind),
                  notes: result.plan.notes,
                  receipts: result.receipts.map((r) => r.txHash),
                },
                "treasury_top_up_after_settlement",
              ),
            )
            .catch((error: unknown) => logger.error({ err: String(error) }, "treasury_top_up_failed"));
        }, deps.treasury.settleDelayMs ?? 15_000);
        // Never hold the process open just for a scheduled top-up.
        (timer as { unref?: () => void }).unref?.();
      }
    });
  }

  return app;
}
