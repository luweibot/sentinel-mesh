import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { createLogger } from "@sentinel-mesh/logger";
import { loadConfig } from "@sentinel-mesh/config";
import { InMemoryEventBus } from "@sentinel-mesh/queue";
import { createEventPublisher } from "@sentinel-mesh/queue";
import { DeterministicPolicyEngine } from "@sentinel-mesh/policy-engine";
import {
  InMemoryEventOutbox,
  InMemoryProcessedEvents,
  InMemoryRunStore,
  InMemoryTaskStore,
  OrchestrationEngine,
} from "@sentinel-mesh/orchestrator";
import { registerAllAgents } from "@sentinel-mesh/agents";
import { buildExecutionStack } from "../src/execution.js";
import { buildApp } from "../src/app.js";

/**
 * Merged deployment: this service now also serves the retired API
 * service's surface (agent registry, signal pipeline, explorer routes).
 * These tests pin the merged contract: one origin, engine-backed
 * /api/v1/tasks, real payment records (no explorer stub), and a unified
 * health check that reports the queue mode.
 */

function silentLogger() {
  const sink = new PassThrough();
  sink.resume();
  return createLogger({ service: "test", level: "silent", destination: sink });
}

function baseDeps() {
  const config = loadConfig({ EXECUTION_MODE: "paper" });
  const logger = silentLogger();
  const bus = new InMemoryEventBus();
  const engine = new OrchestrationEngine({
    bus,
    taskStore: new InMemoryTaskStore(),
    runStore: new InMemoryRunStore(),
    outbox: new InMemoryEventOutbox(),
    processedEvents: new InMemoryProcessedEvents(),
    clock: { now: () => new Date() },
    logger,
  });
  const execution = buildExecutionStack(config, logger, { now: () => new Date() });
  registerAllAgents(engine, execution.port);
  return { config, logger, engine, execution };
}

async function mergedApp() {
  const deps = baseDeps();
  const publisher = await createEventPublisher({});
  const policyEngine = new DeterministicPolicyEngine({
    policyVersion: "0.1.0",
    rules: { allowedChains: ["base", "solana"], maxNotionalUsdCents: 50000 },
  });
  const app = buildApp({
    config: deps.config,
    logger: deps.logger,
    engine: deps.engine,
    storageMode: "in-memory",
    api: { publisher, policyEngine, busMode: "in-memory" },
  });
  return { app, deps };
}

describe("merged deployment (API routes on the orchestrator)", () => {
  it("serves the agent registry", async () => {
    const { app } = await mergedApp();
    const response = await app.inject({ method: "GET", url: "/api/v1/agents" });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { agents: Array<{ agentId: string }>; total: number };
    expect(body.total).toBeGreaterThan(0);
    expect(body.agents.some((agent) => agent.agentId === "trend-scout")).toBe(true);
  });

  it("serves the explorer routes (fees)", async () => {
    const { app } = await mergedApp();
    const response = await app.inject({ method: "GET", url: "/api/v1/fees?chain=base" });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { dataSource: string; chain: string };
    expect(body.dataSource).toBe("fixture");
    expect(body.chain).toBe("base");
  });

  it("serves the guarded signal pipeline end to end", async () => {
    const { app } = await mergedApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/signals",
      payload: {
        chain: "base",
        tokenIn: "0x0000000000000000000000000000000000000001",
        tokenOut: "0x0000000000000000000000000000000000000002",
        notionalUsdCents: 1000,
      },
    });
    expect(response.statusCode).toBe(202);
    const body = response.json() as { signal: { signalId: string }; decision: { verdict: string } };
    expect(body.signal.signalId).toBeTruthy();
    expect(["allow", "reject", "requires-review"]).toContain(body.decision.verdict);

    const listed = await app.inject({ method: "GET", url: "/api/v1/signals" });
    expect((listed.json() as { signals: unknown[] }).signals).toHaveLength(1);
  });

  it("issues tasks through the ENGINE (the engine-backed variant, not the event stub)", async () => {
    const { app, deps } = await mergedApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      payload: { agentId: "research-agent", taskType: "research-topic", input: { topic: "base ecosystem", maxDocuments: 2 } },
    });
    expect(response.statusCode).toBe(202);
    const { task } = response.json() as { task: { taskId: string } };
    expect(task.taskId).toBeTruthy();
    // the task is durable in the engine's task store
    expect(await deps.engine.getTask(task.taskId)).toBeTruthy();
  });

  it("health/ready reports the merged queue mode", async () => {
    const { app } = await mergedApp();
    const response = await app.inject({ method: "GET", url: "/health/ready" });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { checks: { queue?: { mode: string }; storage?: { mode: string } } };
    expect(body.checks.queue).toEqual({ mode: "in-memory" });
    expect(body.checks.storage).toEqual({ mode: "in-memory" });
  });

  it("does NOT register API routes when api deps are absent (routes 404, service stays lean)", async () => {
    const deps = baseDeps();
    const app = buildApp({ config: deps.config, logger: deps.logger, engine: deps.engine, storageMode: "in-memory" });
    const agents = await app.inject({ method: "GET", url: "/api/v1/agents" });
    expect(agents.statusCode).toBe(404);
    const ready = await app.inject({ method: "GET", url: "/health/ready" });
    expect((ready.json() as { checks: Record<string, unknown> }).checks.queue).toBeUndefined();
  });
});
