import { describe, expect, it, beforeEach } from "vitest";
import { PassThrough } from "node:stream";
import { createLogger, type Logger } from "@sentinel-mesh/logger";
import {
  ExecutionReceipt,
  TradeIntent,
  PolicyEvaluationRequest,
  canonicalIntentJson,
  type PolicyDecision,
} from "@sentinel-mesh/contracts";
import { fixtureProviders } from "@sentinel-mesh/chain-data";
import type { PolicyEngine } from "@sentinel-mesh/policy-engine";
import { DeterministicPolicyEngine } from "@sentinel-mesh/policy-engine";
import {
  AuthorizationService,
  InMemoryAuthorizationStore,
  ExecutionRejectedError,
  IdempotencyRegistry,
  KillSwitch,
  ReconciliationLedger,
  InMemoryLimitStore,
  LimitsService,
  StaticLimitPolicySource,
  DeterministicPaperSimulator,
  DeterministicMockSigner,
  GuardedExecutionService,
} from "../src/index.js";
import type { TradeBroadcastPort } from "../src/broadcast.js";
import type { GuardStateJournal, GuardStateSnapshot, UncertainJournalEntry } from "../src/journal.js";
import type { ExecutionReceipt as ReceiptType } from "@sentinel-mesh/contracts";

/** In-memory journal fake recording every durable write (audit 2026-10-21 tests). */
class FakeExecutionJournal implements GuardStateJournal {
  readonly receipts = new Map<string, ReceiptType>();
  readonly recordedCommits: string[] = [];
  readonly aborts: string[] = [];
  readonly uncertain = new Map<string, UncertainJournalEntry>();
  readonly resolvedUncertain: string[] = [];
  readonly fills = new Map<string, { fillId: string; released: boolean }>();

  async restore(): Promise<GuardStateSnapshot> {
    return {
      receipts: [...this.receipts.values()],
      idempotency: [],
      fills: [],
      killSwitch: [],
      spendCaps: [],
      uncertain: [...this.uncertain.values()],
    };
  }
  async recordCommit(receipt: ReceiptType, entry: { intentId: string; receiptId: string }): Promise<void> {
    this.receipts.set(receipt.receiptId, receipt);
    this.recordedCommits.push(entry.intentId);
  }
  async recordRejection(receipt: ReceiptType): Promise<void> {
    this.receipts.set(receipt.receiptId, receipt);
  }
  async recordAbort(intentId: string): Promise<void> {
    this.aborts.push(intentId);
  }
  async recordUncertain(entry: UncertainJournalEntry): Promise<void> {
    this.uncertain.set(entry.intentId, entry);
  }
  async resolveUncertain(intentId: string): Promise<void> {
    this.uncertain.delete(intentId);
    this.resolvedUncertain.push(intentId);
  }
  async recordFill(fill: { fillId: string }): Promise<void> {
    this.fills.set(fill.fillId, { fillId: fill.fillId, released: false });
  }
  async releaseFill(fillId: string): Promise<void> {
    const fill = this.fills.get(fillId);
    if (fill) {
      fill.released = true;
    }
  }
  async recordKillSwitch(): Promise<void> {}
}

const EVM_TOKEN_IN = "0xabc0000000000000000000000000000000000001";
const EVM_TOKEN_OUT = "0xdef0000000000000000000000000000000000002";
/** Fixed clock so TTLs and deadlines are deterministic. */
const START_MS = Date.parse("2026-02-01T00:00:00.000Z");
let nowMs = START_MS;
const clock = { now: () => new Date(nowMs) };

function silentLogger(): Logger {
  const sink = new PassThrough();
  sink.resume();
  return createLogger({ service: "execution-test", level: "silent", destination: sink });
}

const USER_LIMITS = {
  maxTradeUsdCents: 1_000_000, // $10k
  maxTradesPerDay: 10,
  maxOpenPositionUsdCents: 5_000_000,
  dailyLossCapUsdCents: 2_000_000,
  maxChainExposureUsdCents: { base: 4_000_000, ethereum: 1_000_000, "solana-mainnet": 4_000_000, solana: 4_000_000, "solana-devnet": 4_000_000 },
};

interface Harness {
  authorizations: AuthorizationService;
  executor: GuardedExecutionService;
  simulator: DeterministicPaperSimulator;
  killSwitch: KillSwitch;
  ledger: ReconciliationLedger;
  limits: LimitsService;
  limitStore: InMemoryLimitStore;
}

function buildHarness(overrides?: {
  policyEngine?: PolicyEngine;
  minPoolTvlUsdCents?: number;
  mode?: "disabled" | "paper" | "live";
  broadcaster?: TradeBroadcastPort;
  journal?: GuardStateJournal;
}): Harness {
  const logger = silentLogger();
  const store = new InMemoryAuthorizationStore();
  const authorizations = new AuthorizationService(store, clock);
  const killSwitch = new KillSwitch();
  killSwitch.setGlobal("clear");
  killSwitch.setUser("user-1", "clear");
  killSwitch.setStrategy("strategy-1", "clear");
  const idempotency = new IdempotencyRegistry();
  const ledger = new ReconciliationLedger();
  const policies = new StaticLimitPolicySource();
  policies.setUserLimits("user-1", USER_LIMITS);
  policies.setStrategyLimits("strategy-1", { maxTradeUsdCents: 800_000, maxTradesPerDay: 5 });
  const limitStore = new InMemoryLimitStore(clock);
  const limits = new LimitsService(policies, limitStore, clock, overrides?.journal);
  const simulator = new DeterministicPaperSimulator();
  const policyEngine = overrides?.policyEngine ??
    new DeterministicPolicyEngine({
      policyVersion: "1.0.0",
      rules: { allowedChains: ["base", "ethereum", "solana-mainnet", "solana", "solana-devnet"], maxNotionalUsdCents: 10_000_000, notionalAdvisoryFraction: 1 },
    });

  const executor = new GuardedExecutionService({
    authorizationService: authorizations,
    idempotency,
    killSwitch,
    limits,
    ledger,
    policyEngine,
    simulator,
    signer: new DeterministicMockSigner(),
    clock,
    logger,
    minPoolTvlUsdCents: overrides?.minPoolTvlUsdCents ?? 100_000, // $1,000
    liquidity: fixtureProviders().liquidity,
    notionalUsdCentsFor: (intent) => Math.ceil(Number(BigInt(intent.amountInRaw) / 10n ** 6n)),
    mode: { mode: overrides?.mode ?? "paper" },
    ...(overrides?.broadcaster ? { broadcaster: overrides.broadcaster, slippageBps: 100 } : {}),
    ...(overrides?.journal ? { journal: overrides.journal } : {}),
  });

  return { authorizations, executor, simulator, killSwitch, ledger, limits, limitStore };
}

function baseIntent(overrides: Partial<TradeIntent> = {}): TradeIntent {
  return TradeIntent.parse({
    schemaVersion: 1,
    intentId: "11111111-1111-4111-8111-111111111111",
    userId: "user-1",
    strategyId: "strategy-1",
    chain: "base",
    tokenIn: EVM_TOKEN_IN,
    tokenOut: EVM_TOKEN_OUT,
    amountInRaw: "1000000", // 1 unit -> notional 1c via notionalUsdCentsFor
    minAmountOutRaw: "0",
    maxFeeUsdCents: 100,
    maxPriceImpactBps: 100,
    deadline: new Date(START_MS + 120_000).toISOString(),
    ...overrides,
  });
}

async function authorized(harness: Harness, intent: TradeIntent) {
  return harness.authorizations.issue(intent, "approver-1");
}

/** Policy engine stub with a controllable verdict. */
class StubPolicyEngine implements PolicyEngine {
  readonly policyVersion = "1.0.0";
  verdict: "allow" | "reject" | "requires-review" = "allow";
  failWith?: Error;

  async evaluate(request: PolicyEvaluationRequest): Promise<PolicyDecision> {
    PolicyEvaluationRequest.parse(request);
    if (this.failWith) {
      throw this.failWith;
    }
    return {
      schemaVersion: 1,
      decisionId: "22222222-2222-4222-8222-222222222222",
      signalId: request.signalId,
      verdict: this.verdict,
      executionMode: "simulation",
      reasons: this.verdict === "allow" ? [] : [{ code: "stub", message: "stubbed verdict", severity: "reject" }],
      policyVersion: this.policyVersion,
      evaluatedAt: new Date(nowMs).toISOString(),
    };
  }
}

beforeEach(() => {
  nowMs = START_MS;
});

describe("guarded execution: happy path", () => {
  it("paper-fills an authorized, in-bounds intent with a deterministic mock signature", async () => {
    const harness = buildHarness();
    const intent = baseIntent();
    const auth = await authorized(harness, intent);
    const receipt = ExecutionReceipt.parse(await harness.executor.submitIntent(intent, auth));
    expect(receipt.status).toBe("paper-filled");
    expect(receipt.executionMode).toBe("paper");
    expect(receipt.paperTxHash).toMatch(/^paper-/);
    expect(receipt.feeUsdCents).toBeGreaterThan(0);
    expect(BigInt(receipt.simulatedOutRaw ?? "0")).toBeGreaterThan(0n);
    // The authorization is single-use now.
    await expect(harness.authorizations.consume(auth, intent)).rejects.toThrow(ExecutionRejectedError);
  });

  it("fails closed when execution mode is not explicitly paper", async () => {
    const harness = buildHarness({ mode: "disabled" });
    const intent = baseIntent();
    const auth = await authorized(harness, intent);
    const receipt = await harness.executor.submitIntent(intent, auth);
    expect(receipt.status).toBe("rejected");
    expect(receipt.rejectionCode).toBe("execution-disabled");
  });
});

describe("adversarial: replay & duplicate submission", () => {
  it("replays the original receipt on identical duplicate submission (no double fill)", async () => {
    const harness = buildHarness();
    const intent = baseIntent();
    const auth = await authorized(harness, intent);
    const first = await harness.executor.submitIntent(intent, auth);
    const second = await harness.executor.submitIntent(intent, auth);
    expect(second.receiptId).toBe(first.receiptId);
    const receipts = await harness.executor.receiptsForIntent(intent.intentId);
    expect(receipts.length).toBe(1);
    expect(receipts[0]!.status).toBe("paper-filled");
  });

  it("fails closed on the same intentId submitted with altered parameters", async () => {
    const harness = buildHarness();
    const intent = baseIntent();
    const auth = await authorized(harness, intent);
    await harness.executor.submitIntent(intent, auth);
    const altered = TradeIntent.parse({ ...intent, amountInRaw: "9000000" });
    const receipt = await harness.executor.submitIntent(altered, undefined);
    expect(receipt.status).toBe("rejected");
    expect(receipt.rejectionCode).toBe("duplicate-submission-conflict");
  });

  it("rejects replay even with a freshly minted authorization for the same parameters", async () => {
    const harness = buildHarness();
    const intent = baseIntent();
    await authorized(harness, intent); // original authorization
    const first = await harness.executor.submitIntent(intent, await authorized(harness, intent));
    expect(first.status).toBe("paper-filled");
    const freshAuth = await authorized(harness, intent);
    const replay = await harness.executor.submitIntent(intent, freshAuth);
    expect(replay.receiptId).toBe(first.receiptId);
  });
});

describe("adversarial: wrong chain", () => {
  it("rejects an authorization bound to a different chain", async () => {
    const harness = buildHarness();
    const baseIntentDraft = baseIntent();
    const ethereumIntent = TradeIntent.parse({ ...baseIntentDraft, chain: "ethereum" });
    // Authorization was minted for the Base intent's hash but claims chain base...
    const auth = await harness.authorizations.issue(baseIntentDraft, "approver-1");
    const tampered = { ...auth, chain: "ethereum" as const };
    const receipt = await harness.executor.submitIntent(ethereumIntent, tampered);
    expect(receipt.status).toBe("rejected");
    expect(receipt.rejectionCode).toBe("intent-hash-mismatch");
  });
});

describe("adversarial: altered parameters (calldata/instruction equivalent)", () => {
  it("rejects any parameter alteration after authorization", async () => {
    const harness = buildHarness();
    const original = baseIntent();
    const auth = await authorized(harness, original);
    for (const alteration of [
      { amountInRaw: "2000000" },
      { minAmountOutRaw: "1" },
      { maxFeeUsdCents: 101 },
      { maxPriceImpactBps: 101 },
      { deadline: new Date(START_MS + 121_000).toISOString() },
      { tokenOut: "0xdef0000000000000000000000000000000000003" },
      { userId: "user-2" },
      { strategyId: "strategy-2" },
    ]) {
      const altered = TradeIntent.parse({ ...original, ...alteration });
      const receipt = await harness.executor.submitIntent(altered, auth);
      expect(receipt.status).toBe("rejected");
      expect(receipt.rejectionCode).toBe("intent-hash-mismatch");
    }
  });

  it("binds to a canonical, order-stable serialization", () => {
    const intent = baseIntent();
    const json = canonicalIntentJson(intent);
    // Normalized token casing does not change the binding.
    expect(canonicalIntentJson({ ...intent, tokenIn: intent.tokenIn.toUpperCase() })).toBe(json);
    expect(canonicalIntentJson({ ...intent, amountInRaw: "2000000" })).not.toBe(json);
  });
});

describe("adversarial: expired & revoked approval", () => {
  it("rejects an expired authorization", async () => {
    const harness = buildHarness();
    const intent = baseIntent();
    const auth = await authorized(harness, intent);
    nowMs += 61_000; // TTL is 60s
    const receipt = await harness.executor.submitIntent(intent, auth);
    expect(receipt.status).toBe("rejected");
    expect(receipt.rejectionCode).toBe("expired-authorization");
  });

  it("rejects a revoked authorization even before expiry", async () => {
    const harness = buildHarness();
    const intent = baseIntent();
    const auth = await authorized(harness, intent);
    await harness.authorizations.revoke(auth.authorizationId);
    const receipt = await harness.executor.submitIntent(intent, auth);
    expect(receipt.status).toBe("rejected");
    expect(receipt.rejectionCode).toBe("revoked-authorization");
  });

  it("fails closed on missing or malformed authorizations", async () => {
    const harness = buildHarness();
    const intent = baseIntent();
    expect((await harness.executor.submitIntent(intent, undefined)).rejectionCode).toBe("invalid-authorization");
    expect((await harness.executor.submitIntent(intent, {} as never)).rejectionCode).toBe("invalid-authorization");
  });

  it("fails closed when the store cannot verify the presented authorization", async () => {
    const harness = buildHarness();
    const intent = baseIntent();
    const foreign = await authorized(harness, intent); // never stored in THIS harness store
    const other = buildHarness();
    const receipt = await other.executor.submitIntent(intent, foreign);
    expect(receipt.status).toBe("rejected");
    expect(receipt.rejectionCode).toBe("invalid-authorization");
  });
});

describe("adversarial: excessive spend & limit caps", () => {
  it("rejects trades over the per-user notional cap", async () => {
    const harness = buildHarness();
    const intent = baseIntent({ amountInRaw: "2000000000000" }); // notional 2,000,000c > 1,000,000c cap
    const auth = await authorized(harness, intent);
    const receipt = await harness.executor.submitIntent(intent, auth);
    expect(receipt.rejectionCode).toBe("user-limit-exceeded");
  });

  it("rejects trades over the per-strategy cap", async () => {
    const harness = buildHarness();
    const bigIntent = baseIntent({ amountInRaw: "900000000000" }); // 900,000c: under user cap, over strategy cap
    const auth = await authorized(harness, bigIntent);
    const receipt = await harness.executor.submitIntent(bigIntent, auth);
    expect(receipt.rejectionCode).toBe("strategy-limit-exceeded");
  });

  it("fails closed when no limit policy exists for the user or strategy", async () => {
    const harness = buildHarness();
    const stranger = baseIntent({ userId: "user-9", strategyId: "strategy-9" });
    const auth = await authorized(harness, stranger);
    expect((await harness.executor.submitIntent(stranger, auth)).rejectionCode).toBe("user-limit-exceeded");
  });

  it("enforces open-position, chain-exposure, daily-trade, and daily-loss caps", async () => {
    const harness = buildHarness();
    const big = baseIntent({ amountInRaw: "600000000000" }); // 600,000c notional
    // Seed an existing position of 4,600,000c -> position cap (5,000,000c) exceeded.
    harness.limitStore.seed({ userId: "user-1", strategyId: "strategy-1", chain: "base", notionalUsdCents: 4_600_000, pnlUsdCents: 0 });
    let receipt = await harness.executor.submitIntent(big, await authorized(harness, big));
    expect(receipt.rejectionCode).toBe("position-cap-exceeded");

    // Chain exposure cap 4,000,000c: seed 3,700,000c and submit 400,000c.
    const fresh = buildHarness();
    fresh.limitStore.seed({ userId: "user-1", strategyId: "strategy-1", chain: "base", notionalUsdCents: 3_700_000, pnlUsdCents: 0 });
    receipt = await fresh.executor.submitIntent(big, await authorized(fresh, big));
    expect(receipt.rejectionCode).toBe("exposure-cap-exceeded");

    // Daily loss cap: realized loss at the cap blocks new trades.
    const sad = buildHarness();
    sad.limitStore.seed({ userId: "user-1", strategyId: "strategy-1", chain: "base", notionalUsdCents: 0, pnlUsdCents: -2_000_000 });
    receipt = await sad.executor.submitIntent(baseIntent(), await authorized(sad, baseIntent()));
    expect(receipt.rejectionCode).toBe("daily-loss-cap-exceeded");

    // Daily trade count: strategy allows 5; run 5 then a 6th fails.
    const daily = buildHarness();
    const tiny = baseIntent();
    for (let i = 0; i < 5; i += 1) {
      const each = TradeIntent.parse({ ...tiny, intentId: `33333333-3333-4333-8333-3333333333${String(i).padStart(2, "0")}`.replace(/33$/, String(i).padStart(2, "0")) });
      const filled = await daily.executor.submitIntent(each, await authorized(daily, each));
      expect(filled.status).toBe("paper-filled");
    }
    const sixth = TradeIntent.parse({ ...tiny, intentId: "44444444-4444-4444-8444-444444444444" });
    receipt = await daily.executor.submitIntent(sixth, await authorized(daily, sixth));
    expect(receipt.rejectionCode).toBe("strategy-limit-exceeded");
  });
});

describe("adversarial: policy engine gates", () => {
  it("rejects when the policy engine rejects", async () => {
    const stub = new StubPolicyEngine();
    stub.verdict = "reject";
    const harness = buildHarness({ policyEngine: stub });
    const intent = baseIntent();
    const receipt = await harness.executor.submitIntent(intent, await authorized(harness, intent));
    expect(receipt.rejectionCode).toBe("policy-rejected");
  });

  it("rejects when the policy engine requires human review", async () => {
    const stub = new StubPolicyEngine();
    stub.verdict = "requires-review";
    const harness = buildHarness({ policyEngine: stub });
    const intent = baseIntent();
    const receipt = await harness.executor.submitIntent(intent, await authorized(harness, intent));
    expect(receipt.rejectionCode).toBe("policy-review-required");
  });

  it("fails closed when the policy engine errors", async () => {
    const stub = new StubPolicyEngine();
    stub.failWith = new Error("rpc down");
    const harness = buildHarness({ policyEngine: stub });
    const intent = baseIntent();
    const receipt = await harness.executor.submitIntent(intent, await authorized(harness, intent));
    expect(receipt.rejectionCode).toBe("policy-error");
  });
});

describe("adversarial: liquidity, fee, slippage, and price-impact bounds", () => {
  it("rejects when observed liquidity is below the floor", async () => {
    const harness = buildHarness({ minPoolTvlUsdCents: 10_000_000_000 }); // absurd floor
    const intent = baseIntent();
    const receipt = await harness.executor.submitIntent(intent, await authorized(harness, intent));
    expect(receipt.rejectionCode).toBe("liquidity-insufficient");
  });

  it("fails closed when no liquidity source is configured", async () => {
    const harness = buildHarness();
    // Build a second executor without liquidity wired.
    const killSwitch = new KillSwitch();
    killSwitch.setGlobal("clear");
    const broken = new (await import("../src/executor.js")).GuardedExecutionService({
      authorizationService: harness.authorizations,
      idempotency: new IdempotencyRegistry(),
      killSwitch,
      limits: harness.limits,
      ledger: new ReconciliationLedger(),
      policyEngine: new StubPolicyEngine(),
      simulator: new DeterministicPaperSimulator(),
      signer: new DeterministicMockSigner(),
      clock,
      logger: silentLogger(),
      minPoolTvlUsdCents: 1,
      liquidity: undefined,
      notionalUsdCentsFor: (_intent) => 1,
      mode: { mode: "paper" },
    });
    const intent = baseIntent();
    const receipt = await broken.submitIntent(intent, await harness.authorizations.issue(intent, "approver-1"));
    expect(receipt.rejectionCode).toBe("liquidity-insufficient");
  });

  it("enforces fee, slippage, and price-impact bounds from the simulation", async () => {
    // First learn the deterministic simulation outputs for this intent.
    const probe = new DeterministicPaperSimulator();
    const intent = baseIntent();
    const sim = await probe.simulate(intent);

    // Fee bound below the simulated fee.
    let harness = buildHarness();
    const feeIntent = TradeIntent.parse({ ...intent, intentId: "55555555-5555-4555-8555-555555555555", maxFeeUsdCents: sim.feeUsdCents - 1 });
    expect((await harness.executor.submitIntent(feeIntent, await authorized(harness, feeIntent))).rejectionCode).toBe("fee-limit-exceeded");

    // Min output above the simulated output.
    harness = buildHarness();
    const slipIntent = TradeIntent.parse({ ...intent, intentId: "66666666-6666-4666-8666-666666666666", minAmountOutRaw: (BigInt(sim.simulatedOutRaw) + 1n).toString() });
    expect((await harness.executor.submitIntent(slipIntent, await authorized(harness, slipIntent))).rejectionCode).toBe("slippage-limit-exceeded");

    // Price impact bound below the simulated impact.
    harness = buildHarness();
    const impactIntent = TradeIntent.parse({ ...intent, intentId: "77777777-7777-4777-8777-777777777777", maxPriceImpactBps: sim.priceImpactBps - 1 });
    expect((await harness.executor.submitIntent(impactIntent, await authorized(harness, impactIntent))).rejectionCode).toBe("price-impact-exceeded");
  });
});

describe("adversarial: RPC uncertainty", () => {
  it("fails closed when simulation is uncertain", async () => {
    const harness = buildHarness();
    const intent = baseIntent();
    harness.simulator.overrideOutcome(intent.intentId, { status: "uncertain", detail: "rpc returned ambiguous receipt" });
    const receipt = await harness.executor.submitIntent(intent, await authorized(harness, intent));
    expect(receipt.rejectionCode).toBe("simulation-uncertain");
  });

  it("rejects when simulation explicitly fails", async () => {
    const harness = buildHarness();
    const intent = baseIntent();
    harness.simulator.overrideOutcome(intent.intentId, { status: "failed", detail: "simulated swap reverted" });
    const receipt = await harness.executor.submitIntent(intent, await authorized(harness, intent));
    expect(receipt.rejectionCode).toBe("simulation-failed");
  });
});

describe("adversarial: emergency stop", () => {
  it("rejects everything while the global kill switch is engaged", async () => {
    const harness = buildHarness();
    harness.killSwitch.setGlobal("engaged");
    const intent = baseIntent();
    const receipt = await harness.executor.submitIntent(intent, await authorized(harness, intent));
    expect(receipt.rejectionCode).toBe("kill-switch-engaged");
  });

  it("fails closed when the kill switch state is unknown or unset", async () => {
    const harness = buildHarness();
    harness.killSwitch.setGlobal("unknown");
    const intent = baseIntent();
    expect((await harness.executor.submitIntent(intent, await authorized(harness, intent))).rejectionCode).toBe("kill-switch-unknown");

    // A fresh switch that was never explicitly cleared also fails closed.
    const virgin = new KillSwitch();
    expect(virgin.rejectionFor({ userId: "user-1", strategyId: "strategy-1" })).toBe("kill-switch-unknown");
  });

  it("supports user- and strategy-scoped stops without affecting others", async () => {
    const harness = buildHarness();
    harness.killSwitch.setStrategy("strategy-1", "engaged");
    const intent = baseIntent();
    expect((await harness.executor.submitIntent(intent, await authorized(harness, intent))).rejectionCode).toBe("kill-switch-engaged");

    harness.killSwitch.setStrategy("strategy-1", "clear");
    harness.killSwitch.setUser("user-1", "engaged");
    expect((await harness.executor.submitIntent(intent, await authorized(harness, intent))).rejectionCode).toBe("kill-switch-engaged");

    const otherUser = baseIntent({ userId: "user-2", intentId: "88888888-8888-4888-8888-888888888888" });
    expect((await harness.executor.submitIntent(otherUser, await authorized(harness, otherUser))).rejectionCode).toBe("user-limit-exceeded"); // different user, not stopped by user-1 switch
  });
});

describe("reconciliation", () => {
  it("reports a consistent ledger after executions", async () => {
    const harness = buildHarness();
    const intent = baseIntent();
    await harness.executor.submitIntent(intent, await authorized(harness, intent));
    const report = harness.ledger.reconcile([intent.intentId], clock.now);
    expect(report.consistent).toBe(true);
    expect(report.receiptsChecked).toBe(1);
  });

  it("detects missing receipts, duplicate fills, and orphan receipts", async () => {
    const harness = buildHarness();
    const intent = baseIntent();
    await harness.executor.submitIntent(intent, await authorized(harness, intent));

    // Missing: an intent that was submitted but has no receipt.
    const report = harness.ledger.reconcile([intent.intentId, "99999999-9999-4999-8999-999999999999"], clock.now);
    expect(report.consistent).toBe(false);
    expect(report.missingReceipts).toContain("99999999-9999-4999-8999-999999999999");
  });

  it("refuses inconsistent re-recorded receipts (ledger corruption guard)", async () => {
    const harness = buildHarness();
    const intent = baseIntent();
    const receipt = await harness.executor.submitIntent(intent, await authorized(harness, intent));
    expect(() => harness.ledger.record({ ...receipt, feeUsdCents: (receipt.feeUsdCents ?? 0) + 1 })).toThrow(/ledger corruption/);
  });
});

describe("authorization service invariants", () => {
  it("mints short-lived authorizations bound to the exact hash", async () => {
    const harness = buildHarness();
    const intent = baseIntent();
    const auth = await authorized(harness, intent);
    expect(Date.parse(auth.expiresAt) - Date.parse(auth.issuedAt)).toBe(60_000);
    expect(auth.status).toBe("active");
    expect(auth.bindsToHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects non-positive TTLs", () => {
    expect(() => new AuthorizationService(new InMemoryAuthorizationStore(), clock, 0)).toThrow();
  });

  it("keeps intent deadlines independent of authorization TTLs", async () => {
    const harness = buildHarness();
    const intent = baseIntent();
    const auth = await authorized(harness, intent);
    nowMs += 45_000; // still within TTL...
    const receipt = await harness.executor.submitIntent(intent, auth);
    expect(receipt.status).toBe("paper-filled");
  });
});

// ---------------------------------------------------------------------------
// SECURITY REGRESSION TESTS (audit 2026-10-18): race conditions
// ---------------------------------------------------------------------------

import type { TransactionSimulationPort, SimulationResult } from "../src/index.js";

/**
 * Simulator wrapper that pauses the FIRST N simulate() calls at a gate so a
 * second submitIntent() can interleave mid-flight (reproducing real
 * concurrency windows between the awaits in the guard pipeline).
 */
class GateSimulator implements TransactionSimulationPort {
  private held = 0;
  private waiters: Array<() => void> = [];
  private entered = 0;

  constructor(private readonly inner: TransactionSimulationPort, private readonly holdCount: number) {}

  /** Resolve when `target` simulations have entered (i.e. requests are paused). */
  async waitForEntry(target = 1): Promise<void> {
    while (this.entered < target) {
      await new Promise((r) => setTimeout(r, 1));
    }
  }

  openGate(): void {
    this.held = 0;
    for (const w of this.waiters.splice(0)) w();
  }

  async simulate(intent: import("@sentinel-mesh/contracts").TradeIntent): Promise<SimulationResult> {
    this.entered += 1;
    if (this.entered <= this.holdCount) {
      this.held += 1;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    return this.inner.simulate(intent);
  }
}

describe("security audit regressions: duplicate-in-flight must not delete the winner's idempotency reservation", () => {
  it("a rejected concurrent duplicate cannot unlock a third submission of the same intent (double execution)", async () => {
    const inner = new DeterministicPaperSimulator();
    const gate = new GateSimulator(inner, 1);
    const harness = buildHarness();
    // Rebuild the executor with the gated simulator.
    const gated = new GuardedExecutionService({
      authorizationService: harness.authorizations,
      idempotency: new IdempotencyRegistry(),
      killSwitch: harness.killSwitch,
      limits: harness.limits,
      ledger: harness.ledger,
      policyEngine: new DeterministicPolicyEngine({
        policyVersion: "1.0.0",
        rules: { allowedChains: ["base", "ethereum", "solana-mainnet", "solana", "solana-devnet"], maxNotionalUsdCents: 10_000_000, notionalAdvisoryFraction: 1 },
      }),
      simulator: gate,
      signer: new DeterministicMockSigner(),
      clock,
      logger: silentLogger(),
      minPoolTvlUsdCents: 100_000,
      liquidity: fixtureProviders().liquidity,
      notionalUsdCentsFor: (intent) => Math.ceil(Number(BigInt(intent.amountInRaw) / 10n ** 6n)),
      mode: { mode: "paper" },
    });

    const intent = baseIntent();
    const first = gated.submitIntent(intent, await authorized(harness, intent));
    await gate.waitForEntry(); // first submission is now paused inside simulate()

    // Second identical submission while the first is in flight: must be
    // rejected as a duplicate, and must NOT free the winner's reservation.
    const duplicate = await gated.submitIntent(intent, await authorized(harness, intent));
    expect(duplicate.status).toBe("rejected");
    expect(duplicate.rejectionCode).toBe("duplicate-submission-conflict");

    // Third identical submission: with the reservation intact it must also be
    // rejected. (Before the fix, the catch-path abort() had deleted the
    // in-flight entry and this submission executed a second time.)
    const third = await gated.submitIntent(intent, await authorized(harness, intent));
    expect(third.status).toBe("rejected");
    expect(third.rejectionCode).toBe("duplicate-submission-conflict");

    gate.openGate();
    const firstReceipt = await first;
    expect(firstReceipt.status).toBe("paper-filled");

    // Exactly ONE paper fill for this intent may exist.
    const receipts = await gated.receiptsForIntent(intent.intentId);
    const filled = receipts.filter((r) => r.status === "paper-filled");
    expect(filled).toHaveLength(1);
    const report = harness.ledger.reconcile([intent.intentId], clock.now);
    expect(report.duplicateReceipts).toHaveLength(0);
  });
});

describe("security audit regressions: limit caps must be reserved atomically", () => {
  it("two concurrent intents cannot both pass the open-position cap and then both fill", async () => {
    const gate = new GateSimulator(new DeterministicPaperSimulator(), 2);
    const logger = silentLogger();
    const policies = new StaticLimitPolicySource();
    // Cap: $100 open position; each intent notional will be $60.
    policies.setUserLimits("user-1", { ...USER_LIMITS, maxOpenPositionUsdCents: 10_000, maxTradeUsdCents: 10_000, maxTradesPerDay: 10 });
    policies.setStrategyLimits("strategy-1", { maxTradeUsdCents: 10_000, maxTradesPerDay: 10 });
    const limitStore = new InMemoryLimitStore(clock);
    const limits = new LimitsService(policies, limitStore, clock);
    const killSwitch = new KillSwitch();
    killSwitch.setGlobal("clear");
    killSwitch.setUser("user-1", "clear");
    killSwitch.setStrategy("strategy-1", "clear");
    const authorizations = new AuthorizationService(new InMemoryAuthorizationStore(), clock);
    const executor = new GuardedExecutionService({
      authorizationService: authorizations,
      idempotency: new IdempotencyRegistry(),
      killSwitch,
      limits,
      ledger: new ReconciliationLedger(),
      policyEngine: new DeterministicPolicyEngine({
        policyVersion: "1.0.0",
        rules: { allowedChains: ["base", "ethereum", "solana-mainnet", "solana", "solana-devnet"], maxNotionalUsdCents: 10_000_000, notionalAdvisoryFraction: 1 },
      }),
      simulator: gate,
      signer: new DeterministicMockSigner(),
      clock,
      logger,
      minPoolTvlUsdCents: 100_000,
      liquidity: fixtureProviders().liquidity,
      notionalUsdCentsFor: () => 6_000, // $60 per intent against a $100 cap
      mode: { mode: "paper" },
    });

    const a = baseIntent({ intentId: "22222222-2222-4222-8222-222222222221", amountInRaw: "6000000" });
    const b = baseIntent({ intentId: "22222222-2222-4222-8222-222222222222", amountInRaw: "6000000" });

    const reqA = executor.submitIntent(a, await authorizations.issue(a, "approver-1"));
    await gate.waitForEntry(1);
    // B is submitted while A holds its reservation; with atomic reservation
    // B must reject at the caps step WITHOUT ever reaching the gate.
    const receiptB = await executor.submitIntent(b, await authorizations.issue(b, "approver-1"));
    expect(receiptB.status).toBe("rejected");
    expect(receiptB.rejectionCode, `debug: ${JSON.stringify(receiptB)}`).toBe("position-cap-exceeded");

    gate.openGate();
    const receiptA = await reqA;
    const statuses = [receiptA.status, receiptB.status].sort();
    // Exactly one may fill: the second must be rejected on the position cap.
    expect(statuses).toEqual(["paper-filled", "rejected"]);
    const rejected = receiptA.status === "rejected" ? receiptA : receiptB;
    expect(rejected.rejectionCode).toBe("position-cap-exceeded");
    // Open position must never exceed the configured cap.
    expect(limitStore.openPositionUsdCents("user-1")).toBeLessThanOrEqual(10_000);
  });
});

// ---------------------------------------------------------------------------
// Uncertain live broadcasts (audit 2026-10-21)
// ---------------------------------------------------------------------------
describe("live uncertain broadcasts: the in-flight lock is retained (audit 2026-10-21)", () => {
  function uncertainHarness(journal: FakeExecutionJournal, script: Array<"throw" | { status: "success" }>) {
    let calls = 0;
    const broadcaster: TradeBroadcastPort = {
      quote: async () => ({ quotedOutRaw: "2000000", feeUsdCents: 1, priceImpactBps: 10, detail: "test quote" }),
      execute: async () => {
        const step = script[Math.min(calls, script.length - 1)];
        calls += 1;
        if (step === "throw") {
          throw new Error("rpc connection reset mid-flight");
        }
        return { txHash: "0xlivehash", status: "success", executedOutRaw: "2000000", feeUsdCents: 2, detail: "filled" };
      },
    };
    const harness = buildHarness({ mode: "live", broadcaster, journal });
    return { harness, broadcastCalls: () => calls };
  }

  it("keeps the lock: an identical resubmission is rejected without a second broadcast", async () => {
    const journal = new FakeExecutionJournal();
    const { harness, broadcastCalls } = uncertainHarness(journal, ["throw"]);
    const intent = baseIntent();
    const auth = await authorized(harness, intent);

    const receipt = await harness.executor.submitIntent(intent, auth);
    expect(receipt.status).toBe("rejected");
    expect(receipt.rejectionCode).toBe("execution-uncertain");
    expect(broadcastCalls()).toBe(1);

    // the uncertain state is locked in memory and journaled durably
    expect(harness.executor.listUncertain().map((e) => e.intentId)).toEqual([intent.intentId]);
    expect(journal.uncertain.keys()).toContain(intent.intentId);
    expect(journal.aborts).toHaveLength(0);

    // the reserved cap fill was NOT released
    const entry = harness.executor.listUncertain()[0]!;
    expect(entry.reservedFillId).not.toBe("");
    expect(journal.fills.get(entry.reservedFillId)?.released).toBe(false);

    // an identical resubmission must not double-broadcast while the tx may still land
    const replay = await harness.executor.submitIntent(intent, auth);
    expect(replay.status).toBe("rejected");
    expect(replay.rejectionCode).toBe("duplicate-submission-conflict");
    expect(broadcastCalls()).toBe(1); // still exactly one broadcast ever
  });

  it("resolve(landed=true) commits a live-filled receipt and duplicates replay it", async () => {
    const journal = new FakeExecutionJournal();
    const { harness, broadcastCalls } = uncertainHarness(journal, ["throw"]);
    const intent = baseIntent();
    const auth = await authorized(harness, intent);

    const uncertain = await harness.executor.submitIntent(intent, auth);
    expect(uncertain.rejectionCode).toBe("execution-uncertain");

    const resolved = await harness.executor.resolveUncertain(intent.intentId, {
      landed: true,
      txHash: "0xonchainreceipt",
      executedOutRaw: "1900000",
      feeUsdCents: 3,
    });
    expect(resolved?.status).toBe("live-filled");
    expect(resolved?.txHash).toBe("0xonchainreceipt");
    expect(harness.executor.listUncertain()).toHaveLength(0);
    expect(journal.resolvedUncertain).toEqual([intent.intentId]);

    // duplicate submission now REPLAYS the resolved receipt (no re-execution)
    const replay = await harness.executor.submitIntent(intent, auth);
    expect(replay.status).toBe("live-filled");
    expect(replay.receiptId).toBe(resolved?.receiptId);
    expect(broadcastCalls()).toBe(1);
  });

  it("resolve(landed=false) releases the lock and cap; resubmission executes", async () => {
    const journal = new FakeExecutionJournal();
    const { harness, broadcastCalls } = uncertainHarness(journal, ["throw", { status: "success" }]);
    const intent = baseIntent();

    const uncertain = await harness.executor.submitIntent(intent, await authorized(harness, intent));
    expect(uncertain.rejectionCode).toBe("execution-uncertain");

    const entry = harness.executor.listUncertain()[0]!;
    const out = await harness.executor.resolveUncertain(intent.intentId, { landed: false });
    expect(out).toBeNull();
    // the cap reservation was released (journal releaseFill called)
    expect(journal.fills.get(entry.reservedFillId)?.released).toBe(true);
    expect(harness.executor.listUncertain()).toHaveLength(0);

    // the released lock allows a fresh execution of the same intentId
    const resubmitted = await harness.executor.submitIntent(intent, await authorized(harness, intent));
    expect(resubmitted.status).toBe("live-filled");
    expect(broadcastCalls()).toBe(2);
  });

  it("restoreUncertain re-arms the lock from the durable journal (restart safety)", async () => {
    const journal = new FakeExecutionJournal();
    const { harness } = uncertainHarness(journal, ["throw"]);
    const intent = baseIntent();
    await harness.executor.submitIntent(intent, await authorized(harness, intent));

    // simulate a restart: a fresh executor restores the uncertain journal
    const restarted = uncertainHarness(new FakeExecutionJournal(), ["throw"]).harness;
    restarted.executor.restoreUncertain(await journal.restore().then((s) => s.uncertain));
    expect(restarted.executor.listUncertain().map((e) => e.intentId)).toEqual([intent.intentId]);
    const replay = await restarted.executor.submitIntent(intent, await authorized(restarted, intent));
    expect(replay.status).toBe("rejected");
    expect(replay.rejectionCode).toBe("duplicate-submission-conflict");
  });
});
