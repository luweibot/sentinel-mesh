import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { buildApp } from "../src/app.js";
import { loadConfig } from "@sentinel-mesh/config";
import { createLogger } from "@sentinel-mesh/logger";
import { InMemoryEventBus } from "@sentinel-mesh/queue";
import { DeterministicPolicyEngine } from "@sentinel-mesh/policy-engine";

function testDeps() {
  const config = loadConfig({ DATA_SOURCE: "fixture" });
  const sink = new PassThrough();
  sink.resume(); // discard output
  const logger = createLogger({ service: "test", level: "silent", destination: sink });
  const bus = new InMemoryEventBus();
  const policyEngine = new DeterministicPolicyEngine({
    policyVersion: "0.1.0",
    rules: { allowedChains: ["base", "solana"], maxNotionalUsdCents: 50_000 },
  });
  const app = buildApp({ config, logger, publisher: bus, policyEngine, busMode: "in-memory" });
  return { app, bus };
}

describe("CORS", () => {
  it("allows configured origins with explicit ACAO header and preflight support", async () => {
    const { app } = testDeps();
    const preflight = await app.inject({
      method: "OPTIONS",
      url: "/health",
      headers: { origin: "http://localhost:3000", "access-control-request-method": "GET" },
    });
    expect(preflight.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
    expect(preflight.statusCode).toBeLessThan(400);

    const actual = await app.inject({ method: "GET", url: "/health", headers: { origin: "http://localhost:3000" } });
    expect(actual.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
  });

  it("does not grant CORS to unconfigured origins", async () => {
    const { app } = testDeps();
    const response = await app.inject({ method: "GET", url: "/health", headers: { origin: "https://evil.example.com" } });
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("CORS can be disabled for zero-trust-proxy deployments (ALLOWED_ORIGINS=none)", async () => {
    const config = loadConfig({ ALLOWED_ORIGINS: "none" , DATA_SOURCE: "fixture" });
    const sink = new PassThrough();
    sink.resume();
    const logger = createLogger({ service: "test", level: "silent", destination: sink });
    const bus = new InMemoryEventBus();
    const policyEngine = new DeterministicPolicyEngine({ policyVersion: "0.1.0", rules: { allowedChains: ["base"], maxNotionalUsdCents: 50_000 } });
    const app = buildApp({ config, logger, publisher: bus, policyEngine, busMode: "in-memory" });
    const response = await app.inject({ method: "GET", url: "/health", headers: { origin: "https://sentinel-mesh.vercel.app" } });
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("health endpoints", () => {
  it("GET /health returns service identity", async () => {
    const { app } = testDeps();
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("ok");
    expect(body.service).toBe("sentinel-mesh-api");
    expect(typeof body.uptimeSec).toBe("number");
    await app.close();
  });

  it("GET /health/ready reports skipped database and guard state in mock mode", async () => {
    const { app } = testDeps();
    const response = await app.inject({ method: "GET", url: "/health/ready" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("ok");
    expect(body.checks.database).toEqual({ configured: false, status: "skipped" });
    expect(body.checks.events.mode).toBe("in-memory");
    // Execution mode defaults fail-closed to "disabled"; "paper" requires explicit opt-in.
    expect(body.checks.policy.executionMode).toBe("disabled");
    await app.close();
  });

  it("GET /health/ready returns 503 when the database probe fails", async () => {
    const config = { ...loadConfig({ DATA_SOURCE: "fixture" }), databaseUrl: "postgresql://user:pw@localhost:5432/db" };
    const sink = new PassThrough();
    sink.resume();
    const app = buildApp({
      config,
      logger: createLogger({ service: "test", level: "silent", destination: sink }),
      publisher: new InMemoryEventBus(),
      policyEngine: new DeterministicPolicyEngine({
        policyVersion: "0.1.0",
        rules: { allowedChains: ["base"], maxNotionalUsdCents: 1000 },
      }),
      busMode: "in-memory",
      dbProbe: async () => {
        throw new Error("connection refused");
      },
    });
    const response = await app.inject({ method: "GET", url: "/health/ready" });
    expect(response.statusCode).toBe(503);
    const body = response.json();
    expect(body.status).toBe("degraded");
    expect(body.checks.database.status).toBe("unreachable");
    await app.close();
  });

  it("unknown routes return JSON 404", async () => {
    const { app } = testDeps();
    const response = await app.inject({ method: "GET", url: "/nope" });
    expect(response.statusCode).toBe(404);
    expect(response.json().error).toBe("NOT_FOUND");
    await app.close();
  });
});

describe("agent registry", () => {
  it("GET /api/v1/agents returns the manifest registry", async () => {
    const { app } = testDeps();
    const response = await app.inject({ method: "GET", url: "/api/v1/agents" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.total).toBeGreaterThanOrEqual(4);
    expect(body.agents.every((a: { permissions: { canSignTransactions: boolean } }) => a.permissions.canSignTransactions === false)).toBe(true);
    await app.close();
  });
});

describe("task issuing", () => {
  it("POST /api/v1/tasks issues a task and publishes a versioned event", async () => {
    const { app, bus } = testDeps();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      payload: { agentId: "trend-scout", taskType: "scan-trending", input: { chain: "base" } },
    });
    expect(response.statusCode).toBe(202);
    const body = response.json();
    expect(body.task.assignedAgentId).toBe("trend-scout");
    expect(body.task.schemaVersion).toBe(1);
    expect(bus.published.length).toBe(1);
    expect(bus.published[0]!.type).toBe("agent.task.issued");
    expect(bus.published[0]!.schemaVersion).toBe(1);
    await app.close();
  });

  it("rejects a task type the manifest does not support", async () => {
    const { app } = testDeps();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      payload: { agentId: "trend-scout", taskType: "simulate-trade" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("TASK_TYPE_NOT_SUPPORTED");
    await app.close();
  });

  it("returns 404 for an unknown agent", async () => {
    const { app } = testDeps();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      payload: { agentId: "ghost-agent", taskType: "scan-trending" },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error).toBe("AGENT_NOT_FOUND");
    await app.close();
  });

  it("returns 400 for an invalid body", async () => {
    const { app } = testDeps();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      payload: { agentId: 42 },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("VALIDATION_FAILED");
    await app.close();
  });
});

describe("guarded signal pipeline", () => {
  it("evaluates a signal, publishes both events, and executes nothing", async () => {
    const { app, bus } = testDeps();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/signals",
      payload: {
        chain: "base",
        tokenIn: "0x1111111111111111111111111111111111111111",
        tokenOut: "0x2222222222222222222222222222222222222222",
        notionalUsdCents: 1000,
      },
    });
    expect(response.statusCode).toBe(202);
    const body = response.json();
    expect(body.decision.verdict).toBe("allow");
    expect(body.decision.executionMode).toBe("simulation");
    expect(body.execution.status).toBe("not-executed");
    expect(bus.published.map((e) => e.type)).toEqual(["signal.created", "policy.decision.recorded"]);
    expect(bus.published[0]!.correlationId).toBe(bus.published[1]!.correlationId);
    await app.close();
  });

  it("rejects a signal above the notional cap", async () => {
    const { app } = testDeps();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/signals",
      payload: {
        chain: "base",
        tokenIn: "0x1111111111111111111111111111111111111111",
        tokenOut: "0x2222222222222222222222222222222222222222",
        notionalUsdCents: 10_000_000,
      },
    });
    expect(response.statusCode).toBe(202);
    const body = response.json();
    expect(body.decision.verdict).toBe("reject");
    expect(body.decision.reasons[0].code).toBe("notional-exceeds-cap");
    await app.close();
  });

  it("rejects a malformed signal body", async () => {
    const { app } = testDeps();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/signals",
      payload: { chain: "moonbase" },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });
});
