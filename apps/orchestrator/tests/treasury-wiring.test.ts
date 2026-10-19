import { describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { randomUUID } from "node:crypto";
import { loadConfig } from "@sentinel-mesh/config";
import { createLogger } from "@sentinel-mesh/logger";
import { InMemoryEventBus } from "@sentinel-mesh/queue";
import { OrchestrationEngine, InMemoryTaskStore, InMemoryRunStore, InMemoryEventOutbox, InMemoryProcessedEvents } from "@sentinel-mesh/orchestrator";
import { registerResearchAgents } from "@sentinel-mesh/agents";
import { buildApp } from "../src/app.js";
import { buildSkillsStack, buildPaymentsStack } from "../src/skills-payments.js";
import { buildTreasuryStack, type TreasuryStack } from "../src/treasury.js";
import { mockPayment, mockRequirement } from "@sentinel-mesh/payments";

const NOW = new Date("2026-04-01T12:00:30.000Z");

function baseDeps() {
  const config = loadConfig({ DATA_SOURCE: "fixture" });
  const sink = new PassThrough(); sink.resume();
  const logger = createLogger({ service: "test", level: "silent", destination: sink });
  const engine = new OrchestrationEngine({
    bus: new InMemoryEventBus(),
    taskStore: new InMemoryTaskStore(), runStore: new InMemoryRunStore(),
    outbox: new InMemoryEventOutbox(), processedEvents: new InMemoryProcessedEvents(),
    clock: { now: () => new Date() }, logger,
  });
  registerResearchAgents(engine);
  return { config, logger, engine };
}

function mockTreasury(): TreasuryStack & { topUpGas: ReturnType<typeof vi.fn> } {
  return {
    enabled: true,
    settleDelayMs: 10,
    topUpGas: vi.fn(async () => ({
      plan: { actions: [{ kind: "swapUsdcToEthOnBase", usdcRaw: 48001n }], notes: ["swap 48001 USDC raw → ETH gas"] },
      receipts: [{ kind: "swapUsdcToEthOnBase", txHash: "0xtest", status: "success", gasUsed: "180000", minOutRaw: "1" }],
      ranAt: NOW.toISOString(),
    })),
  };
}

describe("treasury wiring: settled x402 payments trigger the gas top-up", () => {
  it("a NEW settlement schedules topUpGas exactly once (detached, non-blocking)", async () => {
    const { config, logger, engine } = baseDeps();
    const treasury = mockTreasury();
    const payments = buildPaymentsStack(config, logger, { now: () => NOW });
    const app = buildApp({
      config, logger, engine,
      skills: buildSkillsStack(config, logger, { now: () => NOW }).registry,
      payments,
      storageMode: "in-memory",
      treasury,
    });
    const requirement = mockRequirement();
    const paymentId = randomUUID();
    const verify = await app.inject({
      method: "POST", url: "/api/v1/payments/verify",
      payload: { agentId: "trend-scout-agent", requirement, payment: mockPayment({ payTo: requirement.payTo as string, maxAmountRequired: requirement.maxAmountRequired as string }, paymentId), paymentId },
    });
    expect(verify.statusCode).toBe(200);
    const settle = await app.inject({
      method: "POST", url: "/api/v1/payments/settle",
      payload: { paymentId, transactionHash: `mock-tx-${paymentId.slice(0, 8)}` },
    });
    expect(settle.statusCode).toBe(200);
    expect(treasury.topUpGas).not.toHaveBeenCalled(); // detached: response never waits
    await vi.waitFor(() => expect(treasury.topUpGas).toHaveBeenCalledTimes(1));
    await app.close();
  });

  it("idempotent settlement replays do NOT re-trigger the top-up", async () => {
    const { config, logger, engine } = baseDeps();
    const treasury = mockTreasury();
    const payments = buildPaymentsStack(config, logger, { now: () => NOW });
    const app = buildApp({
      config, logger, engine,
      skills: buildSkillsStack(config, logger, { now: () => NOW }).registry,
      payments, storageMode: "in-memory", treasury,
    });
    const requirement = mockRequirement();
    const paymentId = randomUUID();
    await app.inject({
      method: "POST", url: "/api/v1/payments/verify",
      payload: { agentId: "trend-scout-agent", requirement, payment: mockPayment({ payTo: requirement.payTo as string, maxAmountRequired: requirement.maxAmountRequired as string }, paymentId), paymentId },
    });
    await app.inject({ method: "POST", url: "/api/v1/payments/settle", payload: { paymentId, transactionHash: "0xfirst" } });
    await vi.waitFor(() => expect(treasury.topUpGas).toHaveBeenCalledTimes(1));
    const replay = await app.inject({ method: "POST", url: "/api/v1/payments/settle", payload: { paymentId, transactionHash: "0xsecond" } });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().message).toMatch(/replay/i);
    await new Promise((r) => setTimeout(r, 150));
    expect(treasury.topUpGas).toHaveBeenCalledTimes(1); // NOT twice
    await app.close();
  });

  it("failed settlements (422) never trigger the top-up", async () => {
    const { config, logger, engine } = baseDeps();
    const treasury = mockTreasury();
    const app = buildApp({
      config, logger, engine,
      skills: buildSkillsStack(config, logger, { now: () => NOW }).registry,
      payments: buildPaymentsStack(config, logger, { now: () => NOW }),
      storageMode: "in-memory", treasury,
    });
    const settle = await app.inject({
      method: "POST", url: "/api/v1/payments/settle",
      payload: { paymentId: randomUUID(), transactionHash: "0xwhatever" },
    });
    expect(settle.statusCode).toBe(422);
    await new Promise((r) => setTimeout(r, 150));
    expect(treasury.topUpGas).not.toHaveBeenCalled();
    await app.close();
  });

  it("treasury disabled by default config: no top-up, no crash", async () => {
    const { config, logger, engine } = baseDeps();
    expect(config.treasuryEnabled).toBe(false);
    const stack = buildTreasuryStack(config, logger);
    expect(stack.enabled).toBe(false);
    await expect(stack.topUpGas()).rejects.toThrow(/disabled/);
    // and the app works fine without any treasury dep at all:
    const app = buildApp({
      config, logger, engine,
      skills: buildSkillsStack(config, logger, { now: () => NOW }).registry,
      payments: buildPaymentsStack(config, logger, { now: () => NOW }),
      storageMode: "in-memory",
    });
    const health = await app.inject({ method: "GET", url: "/health/ready" });
    expect(health.statusCode).toBe(200);
    await app.close();
  });

  it("config parses treasury env overrides", () => {
    const cfg = loadConfig({
      DATA_SOURCE: "fixture",
      TREASURY_ENABLED: "true",
      TREASURY_ETH_TARGET_WEI: "1000000000000000",
      TREASURY_SOL_TARGET_LAMPORTS: "50000000",
      TREASURY_USDC_RESERVE_RAW: "1000000",
      TREASURY_SLIPPAGE_BPS: "300",
      SOLANA_WALLET_ADDRESS: "H2jn8HAwt14tJEmQ4g9uFMGWsznWuKoooACDA6STFWVF",
    });
    expect(cfg.treasuryEnabled).toBe(true);
    expect(cfg.treasuryEthTargetWei).toBe(1_000_000_000_000_000n);
    expect(cfg.treasurySolTargetLamports).toBe(50_000_000n);
    expect(cfg.treasuryUsdcReserveRaw).toBe(1_000_000n);
    expect(cfg.treasurySlippageBps).toBe(300);
    expect(cfg.solanaWalletAddress).toBe("H2jn8HAwt14tJEmQ4g9uFMGWsznWuKoooACDA6STFWVF");
  });

  it("treasury enabled without a valid EVM key fails closed to disabled", async () => {
    const { config, logger, engine } = baseDeps();
    const enabledCfg = loadConfig({ DATA_SOURCE: "fixture", TREASURY_ENABLED: "true" });
    const previous = process.env.EVM_PRIVATE_KEY;
    delete process.env.EVM_PRIVATE_KEY;
    try {
      const stack = buildTreasuryStack(enabledCfg, logger);
      expect(stack.enabled).toBe(false);
    } finally {
      if (previous !== undefined) process.env.EVM_PRIVATE_KEY = previous;
    }
    void config; void engine;
  });
});
