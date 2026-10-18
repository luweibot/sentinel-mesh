import { describe, expect, it } from "vitest";
import { PolicyEvaluationRequest } from "@sentinel-mesh/contracts";
import { DeterministicPolicyEngine, PolicyConfigurationError } from "../src/index.js";

const baseRequest = PolicyEvaluationRequest.parse({
  schemaVersion: 1,
  signalId: "9e1f0a1c-5b1e-4d7a-9a1a-6f4b5f0a1b2c",
  chain: "base",
  tokenIn: "0x1111111111111111111111111111111111111111",
  tokenOut: "0x2222222222222222222222222222222222222222",
  notionalUsdCents: 1000,
  requestedAt: "2026-01-01T00:00:00.000Z",
});

function engine(maxNotionalUsdCents = 50_000) {
  return new DeterministicPolicyEngine({
    policyVersion: "0.1.0",
    rules: { allowedChains: ["base", "solana"], maxNotionalUsdCents },
  });
}

describe("deterministic policy engine", () => {
  it("allows a small in-policy signal", async () => {
    const decision = await engine().evaluate(baseRequest);
    expect(decision.verdict).toBe("allow");
    expect(decision.reasons).toHaveLength(0);
    expect(decision.executionMode).toBe("simulation");
    expect(decision.policyVersion).toBe("0.1.0");
  });

  it("rejects signals on disallowed chains", async () => {
    const decision = await engine().evaluate({
      ...baseRequest,
      chain: "ethereum",
    });
    expect(decision.verdict).toBe("reject");
    expect(decision.reasons.map((r) => r.code)).toContain("chain-not-allowed");
  });

  it("rejects signals that exceed the notional cap", async () => {
    const decision = await engine().evaluate({ ...baseRequest, notionalUsdCents: 50_001 });
    expect(decision.verdict).toBe("reject");
    expect(decision.reasons.map((r) => r.code)).toContain("notional-exceeds-cap");
  });

  it("flags large-but-legal signals for review", async () => {
    const decision = await engine().evaluate({ ...baseRequest, notionalUsdCents: 30_000 });
    expect(decision.verdict).toBe("requires-review");
    expect(decision.reasons.map((r) => r.code)).toContain("approaching-notional-cap");
    expect(decision.reasons.every((r) => r.severity === "advisory")).toBe(true);
  });

  it("rejects invalid evaluation requests", async () => {
    await expect(
      engine().evaluate({ ...baseRequest, notionalUsdCents: -5 }),
    ).rejects.toThrow();
  });

  it("rejects invalid rule sets at construction", () => {
    expect(
      () =>
        new DeterministicPolicyEngine({
          policyVersion: "0.1.0",
          rules: { allowedChains: [], maxNotionalUsdCents: 100 },
        }),
    ).toThrow();
    expect(
      () =>
        new DeterministicPolicyEngine({
          policyVersion: "not-semver",
          rules: { allowedChains: ["base"], maxNotionalUsdCents: 100 },
        }),
    ).toThrow(PolicyConfigurationError);
  });

  it("is deterministic for identical requests", async () => {
    const first = await engine().evaluate(baseRequest);
    const second = await engine().evaluate(baseRequest);
    expect({ ...first, decisionId: undefined, evaluatedAt: undefined }).toEqual({
      ...second,
      decisionId: undefined,
      evaluatedAt: undefined,
    });
  });
});
