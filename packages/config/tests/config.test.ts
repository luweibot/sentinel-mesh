import { describe, expect, it } from "vitest";
import { ConfigValidationError, loadConfig } from "../src/index.js";

describe("loadConfig", () => {
  it("returns deterministic defaults with an empty environment", () => {
    const config = loadConfig({});
    expect(config.nodeEnv).toBe("development");
    expect(config.logLevel).toBe("info");
    expect(config.apiPort).toBe(3001);
    expect(config.databaseUrl).toBeUndefined();
    expect(config.redisUrl).toBeUndefined();
    expect(config.chainAdapterMode).toBe("mock");
    expect(config.policyMode).toBe("dry-run");
    expect(config.executionMode).toBe("disabled");
    expect(config.mockSignerAddress).toBe(`0x${"0".repeat(40)}`);
    expect(config.policyMaxNotionalUsdCents).toBe(50_000);
  });

  it("parses typed values from strings", () => {
    const config = loadConfig({
      API_PORT: "4001",
      LOG_LEVEL: "debug",
      POLICY_MAX_NOTIONAL_USD_CENTS: "1234",
      DATABASE_URL: "postgresql://user:pw@localhost:5432/db",
    });
    expect(config.apiPort).toBe(4001);
    expect(config.logLevel).toBe("debug");
    expect(config.policyMaxNotionalUsdCents).toBe(1234);
    expect(config.databaseUrl).toBe("postgresql://user:pw@localhost:5432/db");
  });

  it("treats empty infrastructure URLs as unset", () => {
    expect(loadConfig({ DATABASE_URL: "", REDIS_URL: "" }).databaseUrl).toBeUndefined();
  });

  it("rejects invalid values with per-variable details", () => {
    try {
      loadConfig({ API_PORT: "not-a-port", LOG_LEVEL: "loud" });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      const issues = (error as ConfigValidationError).issues;
      expect(issues.length).toBeGreaterThanOrEqual(2);
      expect(error instanceof Error && error.message).toContain("Invalid environment configuration");
    }
  });

  it("rejects live execution mode (phase 0 guard)", () => {
    expect(() => loadConfig({ EXECUTION_MODE: "live" })).toThrow(ConfigValidationError);
    const paper = loadConfig({ EXECUTION_MODE: "paper" });
    expect(paper.executionMode).toBe("paper");
    expect(() => loadConfig({ EXECUTION_MODE: "live" })).toThrow(/go-live checklist/);
  });

  it("rejects readonly chain mode (phase 0 guard)", () => {
    expect(() => loadConfig({ CHAIN_ADAPTER_MODE: "readonly" })).toThrow(ConfigValidationError);
  });
});
