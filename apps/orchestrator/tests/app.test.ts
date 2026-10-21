import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { createLogger } from "@sentinel-mesh/logger";
import { loadConfig } from "@sentinel-mesh/config";
import { InMemoryEventBus } from "@sentinel-mesh/queue";
import {
  InMemoryEventOutbox,
  InMemoryProcessedEvents,
  InMemoryRunStore,
  InMemoryTaskStore,
  OrchestrationEngine,
} from "@sentinel-mesh/orchestrator";
import { registerResearchAgents } from "@sentinel-mesh/agents";
import { buildApp } from "../src/app.js";
import { buildExecutionStack } from "../src/execution.js";

function deps() {
  const config = loadConfig({ DATA_SOURCE: "fixture" });
  const sink = new PassThrough();
  sink.resume();
  const logger = createLogger({ service: "test", level: "silent", destination: sink });
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
  registerResearchAgents(engine);
  const app = buildApp({ config, logger, engine, storageMode: "in-memory" });
  return { app, engine };
}

const OPERATOR_TOKEN = "test-operator-token-0123456789abcdef0123456789";

/** App with the execution control plane (kill-switch etc.) registered. */
function makeExecutionApp(operatorToken?: string) {
  const env: Record<string, string> = { DATA_SOURCE: "fixture", EXECUTION_MODE: "paper" };
  if (operatorToken !== undefined) {
    env["OPERATOR_API_TOKEN"] = operatorToken;
  }
  const config = loadConfig(env);
  const sink = new PassThrough();
  sink.resume();
  const logger = createLogger({ service: "test", level: "silent", destination: sink });
  const engine = new OrchestrationEngine({
    bus: new InMemoryEventBus(),
    taskStore: new InMemoryTaskStore(),
    runStore: new InMemoryRunStore(),
    outbox: new InMemoryEventOutbox(),
    processedEvents: new InMemoryProcessedEvents(),
    clock: { now: () => new Date() },
    logger,
  });
  registerResearchAgents(engine);
  const execution = buildExecutionStack(config, logger, { now: () => new Date() }, {});
  const app = buildApp({ config, logger, engine, execution, storageMode: "in-memory" });
  return { app, engine };
}

describe("CORS", () => {
  it("allows only configured origins", async () => {
    const config = loadConfig({ ALLOWED_ORIGINS: "https://sentinel-mesh.vercel.app" , DATA_SOURCE: "fixture" });
    const sink = new PassThrough();
    sink.resume();
    const logger = createLogger({ service: "test", level: "silent", destination: sink });
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
    registerResearchAgents(engine);
    const app = buildApp({ config, logger, engine, storageMode: "in-memory" });
    const allowed = await app.inject({ method: "GET", url: "/health", headers: { origin: "https://sentinel-mesh.vercel.app" } });
    expect(allowed.headers["access-control-allow-origin"]).toBe("https://sentinel-mesh.vercel.app");
    const denied = await app.inject({ method: "GET", url: "/health", headers: { origin: "https://evil.example.com" } });
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("orchestrator service", () => {
  it("GET /health reports the service identity", async () => {
    const { app } = deps();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json().service).toBe("sentinel-mesh-orchestrator");
    await app.close();
  });

  it("GET /health/ready reports storage mode and guard state", async () => {
    const { app } = deps();
    const res = await app.inject({ method: "GET", url: "/health/ready" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.checks.storage.mode).toBe("in-memory");
    // Execution mode defaults fail-closed to "disabled"; "paper" requires explicit opt-in.
    expect(body.checks.policy.executionMode).toBe("disabled");
    await app.close();
  });

  it("POST /api/v1/tasks issues a task and records the result", async () => {
    const { app } = deps();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      payload: {
        agentId: "research-agent",
        taskType: "research-topic",
        input: { topic: "base ecosystem", maxDocuments: 2 },
      },
    });
    expect(res.statusCode).toBe(202);
    const { task } = res.json();
    const detail = await app.inject({ method: "GET", url: `/api/v1/tasks/${task.taskId}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().task.status).toBe("succeeded");
    expect(detail.json().task.result.status).toBe("success");
    await app.close();
  });

  it("returns 400 for invalid task bodies", async () => {
    const { app } = deps();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      payload: { agentId: "research-agent", taskType: "not-a-task" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("VALIDATION_FAILED");
    await app.close();
  });

  it("runs the research workflow end to end and exposes the run and trace", async () => {
    const { app, engine } = deps();
    const start = await app.inject({
      method: "POST",
      url: "/api/v1/workflows/research",
      payload: { topic: "base ecosystem", maxDocuments: 3 },
    });
    expect(start.statusCode).toBe(200);
    const { run, traceId } = start.json();
    expect(run.status).toBe("completed");
    expect(run.steps.map((s: { status: string }) => s.status)).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
    ]);

    const runDetail = await app.inject({ method: "GET", url: `/api/v1/workflows/${run.runId}` });
    expect(runDetail.statusCode).toBe(200);
    expect(runDetail.json().tasks.length).toBe(3);
    expect(runDetail.json().tasks.every((t: { status: string }) => t.status === "succeeded")).toBe(true);

    const trace = await app.inject({ method: "GET", url: `/api/v1/trace/${traceId}` });
    expect(trace.statusCode).toBe(200);
    const traceBody = trace.json();
    expect(traceBody.eventCount).toBeGreaterThanOrEqual(8);
    expect(traceBody.events.every((e: { correlationId?: string }) => e.correlationId === traceId)).toBe(true);

    // The engine trace and the HTTP surface agree.
    expect(engine.getTrace(traceId).length).toBe(traceBody.eventCount);
    await app.close();
  });

  it("returns 404 for unknown runs, tasks, and traces", async () => {
    const { app } = deps();
    expect((await app.inject({ method: "GET", url: "/api/v1/workflows/11111111-1111-4111-8111-111111111111" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/v1/tasks/11111111-1111-4111-8111-111111111111" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/v1/trace/11111111-1111-4111-8111-111111111111" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/nope" })).statusCode).toBe(404);
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Operator bearer-token gate on state-changing routes (audit 2026-10-21)
// ---------------------------------------------------------------------------
describe("operator authentication (OPERATOR_API_TOKEN)", () => {
  it("rejects a state-changing request without a token with 401", async () => {
    const { app } = makeExecutionApp(OPERATOR_TOKEN);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/execution/kill-switch",
      payload: { scope: "global", state: "engaged" },
    });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error).toBe("UNAUTHORIZED");
  });

  it("rejects a wrong token with 401", async () => {
    const { app } = makeExecutionApp(OPERATOR_TOKEN);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/execution/kill-switch",
      headers: { authorization: "Bearer wrong-token" },
      payload: { scope: "global", state: "engaged" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("accepts a state-changing request with the correct token", async () => {
    const { app } = makeExecutionApp(OPERATOR_TOKEN);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/execution/kill-switch",
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
      payload: { scope: "global", state: "engaged" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("leaves GET routes and the payments client flow unauthenticated", async () => {
    const { app } = makeExecutionApp(OPERATOR_TOKEN);
    // read routes are unaffected by the operator gate
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/v1/execution/uncertain" })).statusCode).toBe(200);
    // the x402 client-facing routes are NOT operator-gated: they carry
    // their own payment proof gate (402/400 here, but never 401)
    const verify = await app.inject({ method: "POST", url: "/api/v1/payments/verify", payload: {} });
    expect(verify.statusCode).not.toBe(401);
  });

  it("flags state-changing responses with a warning header when the token is NOT configured", async () => {
    const { app } = makeExecutionApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/execution/kill-switch",
      payload: { scope: "global", state: "engaged" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-auth-warning"]).toContain("OPERATOR_API_TOKEN");
  });
});
