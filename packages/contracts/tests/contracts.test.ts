import { describe, expect, it } from "vitest";
import {
  AgentManifest,
  AgentTaskResult,
  EVENT_ENVELOPE_VERSION,
  EventCatalog,
  createEnvelope,
  parseEnvelope,
  parseTypedEnvelope,
} from "../src/index.js";
import type { AgentTask } from "../src/index.js";

const validManifest = {
  manifestVersion: 1,
  agentId: "trend-scout",
  displayName: "Trend Scout",
  version: "0.1.0",
  capabilities: ["trend-analysis"],
  supportedTaskTypes: ["scan-trending"],
  chainAffinity: ["base", "solana"],
  permissions: { networkAccess: "mock", canSignTransactions: false },
};

describe("agent manifest contract", () => {
  it("accepts a valid manifest", () => {
    expect(AgentManifest.safeParse(validManifest).success).toBe(true);
  });

  it("rejects a manifest that claims it can sign transactions (phase 0 hard guard)", () => {
    const result = AgentManifest.safeParse({
      ...validManifest,
      permissions: { networkAccess: "mock", canSignTransactions: true },
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown fields (strict mode)", () => {
    const result = AgentManifest.safeParse({ ...validManifest, unexpected: "field" });
    expect(result.success).toBe(false);
  });

  it("rejects unknown capabilities and task types", () => {
    expect(AgentManifest.safeParse({ ...validManifest, capabilities: ["time-travel"] }).success).toBe(false);
    expect(AgentManifest.safeParse({ ...validManifest, supportedTaskTypes: ["teleport"] }).success).toBe(false);
  });
});

describe("task result contract", () => {
  const base = {
    schemaVersion: 1,
    taskId: "9e1f0a1c-5b1e-4d7a-9a1a-6f4b5f0a1b2c",
    agentId: "trend-scout",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
  };

  it("accepts a successful result with output and no error", () => {
    const result = AgentTaskResult.safeParse({ ...base, status: "success", output: { tokens: [] } });
    expect(result.success).toBe(true);
  });

  it("rejects a failed result without an error", () => {
    const result = AgentTaskResult.safeParse({ ...base, status: "failed" });
    expect(result.success).toBe(false);
  });

  it("rejects a successful result that carries an error", () => {
    const result = AgentTaskResult.safeParse({
      ...base,
      status: "success",
      output: null,
      error: { code: "E", message: "m" },
    });
    expect(result.success).toBe(false);
  });
});

describe("event envelopes", () => {
  const task: AgentTask = {
    schemaVersion: 1,
    taskId: "9e1f0a1c-5b1e-4d7a-9a1a-6f4b5f0a1b2c",
    assignedAgentId: "trend-scout",
    taskType: "scan-trending",
    input: { chain: "base" },
    issuedAt: "2026-01-01T00:00:00.000Z",
    priority: "normal",
    attempt: 1,
  };

  it("creates a versioned envelope with a fresh event id", () => {
    const envelope = createEnvelope(EventCatalog["agent.task.issued"], task, {
      actor: { kind: "system", id: "test" },
      occurredAt: "2026-01-01T00:00:00.000Z",
    });
    expect(envelope.schemaVersion).toBe(EVENT_ENVELOPE_VERSION);
    expect(envelope.type).toBe("agent.task.issued");
    expect(envelope.eventId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("rejects a payload that does not match the event definition", () => {
    expect(() =>
      createEnvelope(
        EventCatalog["agent.task.issued"],
        { wrong: "payload" },
        { actor: { kind: "system", id: "test" } },
      ),
    ).toThrow();
  });

  it("rejects envelopes with a future schema version", () => {
    const envelope = createEnvelope(EventCatalog["agent.task.issued"], task, {
      actor: { kind: "system", id: "test" },
    });
    expect(parseEnvelope(envelope).type).toBe("agent.task.issued");
    expect(() => parseEnvelope({ ...envelope, schemaVersion: 2 })).toThrow();
  });

  it("rejects an envelope missing required fields", () => {
    expect(() => parseEnvelope({ nope: true })).toThrow();
  });

  it("typed parsing validates the payload against the definition", () => {
    const envelope = createEnvelope(EventCatalog["signal.created"], {
      signalId: "9e1f0a1c-5b1e-4d7a-9a1a-6f4b5f0a1b2c",
      chain: "base",
      kind: "copy-trade",
      tokenIn: "0xabc",
      tokenOut: "0xdef",
      notionalUsdCents: 500,
    }, { actor: { kind: "agent", id: "wallet-watcher" } });
    const typed = parseTypedEnvelope(EventCatalog["signal.created"], envelope);
    expect(typed.payload.chain).toBe("base");
    expect(() =>
      parseTypedEnvelope(EventCatalog["signal.created"], { ...envelope, payload: { bad: 1 } }),
    ).toThrow();
  });

  it("policy decisions can only be simulation mode (phase 0 guard)", () => {
    const decision = {
      schemaVersion: 1,
      decisionId: "9e1f0a1c-5b1e-4d7a-9a1a-6f4b5f0a1b2c",
      signalId: "8e1f0a1c-5b1e-4d7a-9a1a-6f4b5f0a1b2c",
      verdict: "allow",
      executionMode: "live",
      reasons: [],
      policyVersion: "0.1.0",
      evaluatedAt: "2026-01-01T00:00:00.000Z",
    };
    const result = EventCatalog["policy.decision.recorded"].payloadSchema.safeParse(decision);
    expect(result.success).toBe(false);
  });
});
