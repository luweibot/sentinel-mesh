import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { createLogger } from "@sentinel-mesh/logger";
import { loadConfig } from "@sentinel-mesh/config";
import { randomUUID } from "node:crypto";
import {
  DEMO_STRATEGY,
  DEMO_USER,
  buildExecutionStack,
  restoreGuardState,
  type ExecutionStack,
} from "../src/execution.js";
import { buildPaymentsStack } from "../src/skills-payments.js";
import { ExecutionReceipt, TradeIntent } from "@sentinel-mesh/contracts";
import {
  intentHash,
  type GuardStateJournal,
  type GuardStateSnapshot,
  type KillSwitchState,
  type RestoredFill,
  type UncertainJournalEntry,
} from "@sentinel-mesh/execution";
import type { SpendCapStateJournal } from "@sentinel-mesh/orchestrator";

/**
 * SECURITY (audit 2026-10-19): sleep/wake regression tests.
 *
 * The orchestrator may run on free-tier compute that sleeps. These tests
 * prove that the durable guard journal preserves every guard guarantee
 * across a restart:
 *  1. a completed intent replays its receipt — never executes twice
 *  2. same intentId with different parameters still conflicts
 *  3. an ENGAGED kill switch survives a restart
 *  4. a fresh durable boot fails CLOSED (no auto-clear) until an operator
 *     explicitly clears the switch
 *  5. trade caps keep counting fills recorded before the restart
 *  6. released reservations do not permanently consume cap space
 *  7. an in-flight intent from a dead process is dropped, not stuck
 *  8. x402 spend-cap utilization survives a restart
 *  9. reconciliation coverage survives a restart: BOTH executed and
 *     REJECTED intents are restored as submitted (rejection receipts
 *     have no idempotency row — restoring from idempotency alone flagged
 *     every rejected intent as an orphan; observed in the ADR-015 drill)
 */

const EVM_TOKEN_IN = "0xabc0000000000000000000000000000000000001";
const EVM_TOKEN_OUT = "0xdef0000000000000000000000000000000000002";

const clock = { now: () => new Date() };

function silentLogger() {
  const sink = new PassThrough();
  sink.resume();
  return createLogger({ service: "test", level: "silent", destination: sink });
}

/** Fake journal with the same semantics as PgGuardStateJournal. */
class FakeGuardStateJournal implements GuardStateJournal {
  readonly receipts = new Map<string, ExecutionReceipt>();
  readonly idempotency = new Map<string, { intentHash: string; status: "in-flight" | "recorded"; receiptId?: string }>();
  readonly fills = new Map<string, RestoredFill & { released: boolean }>();
  readonly killSwitch = new Map<string, KillSwitchState>();
  readonly uncertain = new Map<string, UncertainJournalEntry>();

  async restore(): Promise<GuardStateSnapshot> {
    // Same as the PG journal: in-flight rows belong to a dead process.
    for (const [intentId, entry] of this.idempotency) {
      if (entry.status === "in-flight") {
        this.idempotency.delete(intentId);
      }
    }
    return {
      receipts: [...this.receipts.values()],
      idempotency: [...this.idempotency.entries()]
        .filter(([, entry]) => entry.status === "recorded")
        .map(([intentId, entry]) => ({
          intentId,
          intentHash: entry.intentHash,
          status: "recorded" as const,
          receiptId: entry.receiptId as string,
        })),
      fills: [...this.fills.values()].filter((fill) => !fill.released).map(({ released: _released, ...fill }) => fill),
      killSwitch: [...this.killSwitch.entries()].map(([scope, state]) => ({ scope, state })),
      spendCaps: [],
      uncertain: [...this.uncertain.values()],
    };
  }

  async recordCommit(receipt: ExecutionReceipt, entry: { intentId: string; intentHash: string; receiptId: string }): Promise<void> {
    this.receipts.set(receipt.receiptId, receipt);
    this.idempotency.set(entry.intentId, { intentHash: entry.intentHash, status: "recorded", receiptId: entry.receiptId });
  }

  async recordRejection(receipt: ExecutionReceipt): Promise<void> {
    this.receipts.set(receipt.receiptId, receipt);
  }

  async recordAbort(intentId: string): Promise<void> {
    this.idempotency.delete(intentId);
  }

  async recordUncertain(entry: UncertainJournalEntry): Promise<void> {
    this.uncertain.set(entry.intentId, entry);
  }

  async resolveUncertain(intentId: string): Promise<void> {
    this.uncertain.delete(intentId);
  }

  async recordFill(fill: RestoredFill): Promise<void> {
    this.fills.set(fill.fillId, { ...fill, released: false });
  }

  async releaseFill(fillId: string): Promise<void> {
    const fill = this.fills.get(fillId);
    if (fill) {
      fill.released = true;
    }
  }

  async recordKillSwitch(scope: string, state: KillSwitchState): Promise<void> {
    this.killSwitch.set(scope, state);
  }
}

/** Boot a stack; with a journal this mirrors a server start incl. restore. */
/** Paper mode, matching the deployed EXECUTION_MODE=paper environment. */
const config = () => loadConfig({ EXECUTION_MODE: "paper", DATA_SOURCE: "fixture" });

async function boot(journal: GuardStateJournal): Promise<ExecutionStack> {
  const stack = buildExecutionStack(config(), silentLogger(), clock, { journal });
  await restoreGuardState(await journal.restore(), stack, silentLogger());
  return stack;
}

function freshIntent(overrides: Partial<Record<string, unknown>> = {}): TradeIntent {
  return TradeIntent.parse({
    schemaVersion: 1,
    intentId: randomUUID(),
    userId: DEMO_USER,
    strategyId: DEMO_STRATEGY,
    chain: "base",
    tokenIn: EVM_TOKEN_IN,
    tokenOut: EVM_TOKEN_OUT,
    amountInRaw: "1000000", // 1c notional via the demo estimator
    minAmountOutRaw: "0",
    maxFeeUsdCents: 100,
    maxPriceImpactBps: 100,
    deadline: new Date(clock.now().getTime() + 120_000).toISOString(),
    ...overrides,
  });
}

async function execute(stack: ExecutionStack, intent: TradeIntent) {
  const authorization = await stack.authorizations.issue(intent, "test-approver");
  return ExecutionReceipt.parse(await stack.executor.submitIntent(intent, authorization));
}

/** The demo strategy caps at 15 trades/day; the demo user at 20. */
const STRATEGY_DAILY_CAP = 15;

describe("durable guard state across a restart (sleep/wake)", () => {
  it("replays a completed intent's receipt after a restart instead of re-executing", async () => {
    const journal = new FakeGuardStateJournal();
    const before = await boot(journal);
    await before.setKillSwitch("global", null, "clear");
    const intent = freshIntent();
    const first = await execute(before, intent);
    expect(first.status).toBe("paper-filled");

    // sleep/wake: a brand-new process restoring from the same journal
    const after = await boot(journal);
    const replay = await execute(after, intent);

    expect(replay.receiptId).toBe(first.receiptId);
    expect(replay.status).toBe("paper-filled");
    // exactly ONE paper-filled receipt for the intent across both lives
    const fills = (await after.executor.receiptsForIntent(intent.intentId)).filter((r) => r.status === "paper-filled");
    expect(fills).toHaveLength(1);
  });

  it("still rejects the same intentId with different parameters after a restart", async () => {
    const journal = new FakeGuardStateJournal();
    const before = await boot(journal);
    await before.setKillSwitch("global", null, "clear");
    const intent = freshIntent();
    await execute(before, intent);

    const after = await boot(journal);
    const mutated = freshIntent({ intentId: intent.intentId, amountInRaw: "2000000" });
    const rejection = await execute(after, mutated);
    expect(rejection.status).toBe("rejected");
    expect(rejection.rejectionCode).toBe("duplicate-submission-conflict");
  });

it("reconciliation coverage survives a restart: rejected intents are not orphans (ADR-015 observation, fixed)", async () => {
    const journal = new FakeGuardStateJournal();
    const before = await boot(journal);
    await before.setKillSwitch("global", null, "clear");

    // one filled intent and one REJECTED intent (no idempotency row)
    const filled = freshIntent();
    const fillReceipt = await execute(before, filled);
    expect(fillReceipt.status).toBe("paper-filled");
    await before.setKillSwitch("global", null, "engaged");
    const rejected = freshIntent();
    const rejectReceipt = await execute(before, rejected);
    expect(rejectReceipt.status).toBe("rejected");
    expect(rejectReceipt.rejectionCode).toBe("kill-switch-engaged");
    await before.setKillSwitch("global", null, "clear");

    // sleep/wake: a new stack restoring from the same journal
    const after = await boot(journal);

    // Both intents count as submitted; no orphan receipts.
    expect(after.submittedIntentIds.has(filled.intentId)).toBe(true);
    expect(after.submittedIntentIds.has(rejected.intentId)).toBe(true);
    const report = after.ledger.reconcile([...after.submittedIntentIds], () => new Date());
    expect(report.mismatches.filter((m) => m.problem.includes("orphan"))).toEqual([]);
    expect(report.missingReceipts).toEqual([]);
    expect(report.duplicateReceipts).toEqual([]);
  });

    it("an ENGAGED kill switch survives a restart", async () => {
    const journal = new FakeGuardStateJournal();
    const before = await boot(journal);
    await before.setKillSwitch("global", null, "clear");
    await before.setKillSwitch("global", null, "engaged");

    const after = await boot(journal);
    const rejection = await execute(after, freshIntent());
    expect(rejection.status).toBe("rejected");
    expect(rejection.rejectionCode).toBe("kill-switch-engaged");
  });

  it("a fresh durable boot fails CLOSED: no auto-clear, execution is rejected until an operator clears the switch", async () => {
    const journal = new FakeGuardStateJournal();
    const stack = await boot(journal);
    const rejection = await execute(stack, freshIntent());
    expect(rejection.status).toBe("rejected");
    expect(rejection.rejectionCode).toBe("kill-switch-unknown");

    // after the explicit operator clear, execution proceeds
    await stack.setKillSwitch("global", null, "clear");
    const ok = await execute(stack, freshIntent());
    expect(ok.status).toBe("paper-filled");
  });

  it("daily trade caps keep counting fills recorded before the restart", async () => {
    const journal = new FakeGuardStateJournal();
    const before = await boot(journal);
    await before.setKillSwitch("global", null, "clear");
    for (let i = 0; i < STRATEGY_DAILY_CAP; i += 1) {
      const receipt = await execute(before, freshIntent());
      expect(receipt.status).toBe("paper-filled");
    }

    // sleep/wake: the strategy cap (15/day) was already exhausted
    const after = await boot(journal);
    const rejection = await execute(after, freshIntent());
    expect(rejection.status).toBe("rejected");
    expect(rejection.rejectionCode).toBe("strategy-limit-exceeded");
  });

  it("a released reservation does not permanently consume cap space after a restart", async () => {
    const journal = new FakeGuardStateJournal();
    const before = await boot(journal);
    await before.setKillSwitch("global", null, "clear");
    // an impossible minimum output fails the slippage guard AFTER the
    // limits reservation, exercising the release path
    const rejected = await execute(before, freshIntent({ minAmountOutRaw: "999999999999999999" }));
    expect(rejected.status).toBe("rejected");
    expect(rejected.rejectionCode).toBe("slippage-limit-exceeded");

    // the reservation was journaled and then released
    const snapshot = await journal.restore();
    expect(snapshot.fills).toHaveLength(0);

    // after the restart the released fill is NOT restored: cap space is free
    const after = await boot(journal);
    const ok = await execute(after, freshIntent());
    expect(ok.status).toBe("paper-filled");
  });

  it("fails CLOSED when the registry recorded an intent but its receipt is missing after a restore", async () => {
    const journal = new FakeGuardStateJournal();
    const before = await boot(journal);
    await before.setKillSwitch("global", null, "clear");
    const intent = freshIntent();
    const first = await execute(before, intent);
    expect(first.status).toBe("paper-filled");

    // simulate a partial restore: the idempotency entry survives but the
    // receipt row was lost (the exact corruption the executor must not
    // turn into a second execution)
    journal.receipts.clear();
    const after = await boot(journal);
    const replay = await execute(after, intent);
    expect(replay.status).toBe("rejected");
    expect(replay.rejectionCode).toBe("duplicate-submission-conflict");
    // and nothing re-executed: no paper fill in the new ledger
    const fills = (await after.executor.receiptsForIntent(intent.intentId)).filter((r) => r.status === "paper-filled");
    expect(fills).toHaveLength(0);
  });

  it("an in-flight intent from a dead process is dropped on restore, not stuck forever", async () => {
    const journal = new FakeGuardStateJournal();
    // simulate a crash between begin() and complete(): an in-flight entry
    // with the REAL intent hash, but no receipt
    const intent = freshIntent();
    journal.idempotency.set(intent.intentId, { intentHash: intentHash(intent), status: "in-flight" });

    const after = await boot(journal);
    await after.setKillSwitch("global", null, "clear");
    // the dead process never committed a receipt, so resubmission is a NEW
    // execution — exactly one fill results
    const receipt = await execute(after, intent);
    expect(receipt.status).toBe("paper-filled");
    const fills = (await after.executor.receiptsForIntent(intent.intentId)).filter((r) => r.status === "paper-filled");
    expect(fills).toHaveLength(1);
  });

  it("an uncertain live broadcast survives a restart as a BLOCKING lock (audit 2026-10-21)", async () => {
    const journal = new FakeGuardStateJournal();
    // simulate a live broadcast whose outcome was unknown (the tx may
    // still land onchain): the executor journaled an uncertain entry and
    // its cap reservation survived as a released=false fill
    const intent = freshIntent();
    journal.uncertain.set(intent.intentId, {
      intentId: intent.intentId,
      intentHash: intentHash(intent),
      intent,
      authorizationId: "auth-uncertain-1",
      reservedFillId: "fill-uncertain-1",
      decidedAt: clock.now().toISOString(),
    });
    journal.fills.set("fill-uncertain-1", {
      fillId: "fill-uncertain-1",
      userId: DEMO_USER,
      strategyId: DEMO_STRATEGY,
      chain: "base",
      notionalUsdCents: 1,
      pnlUsdCents: 0,
      day: clock.now().toISOString().slice(0, 10),
      released: false,
    });

    const after = await boot(journal);
    await after.setKillSwitch("global", null, "clear");
    // the restored lock blocks an identical resubmission: the tx may
    // still land onchain and must never be double-broadcast
    const replay = await execute(after, intent);
    expect(replay.status).toBe("rejected");
    expect(replay.rejectionCode).toBe("duplicate-submission-conflict");

    // after onchain reconciliation the operator resolves not-landed:
    // the lock and the cap reservation release, resubmission executes
    await after.executor.resolveUncertain(intent.intentId, { landed: false });
    journal.resolveUncertain(intent.intentId);
    const resubmitted = await execute(after, intent);
    expect(resubmitted.status).toBe("paper-filled");
  });
});

/** Fake spend-cap journal with PG-equivalent delta semantics. */
class FakeSpendCapJournal implements SpendCapStateJournal {
  private readonly rows = new Map<string, { committedUsdCents: number; reservedUsdCents: number }>();
  private queue: Promise<unknown> = Promise.resolve();

  private enqueue(operation: () => void): void {
    this.queue = this.queue.then(() => {
      operation();
    });
  }

  async restore() {
    await this.queue;
    return [...this.rows.entries()].map(([key, row]) => {
      const parts = key.split("|");
      const agentId = parts[0] ?? "";
      const day = parts[1] ?? "";
      return { agentId, day, committedUsdCents: row.committedUsdCents, reservedUsdCents: row.reservedUsdCents };
    });
  }

  onReserved(agentId: string, day: string, amountUsdCents: number): void {
    this.enqueue(() => {
      const row = this.rows.get(`${agentId}|${day}`) ?? { committedUsdCents: 0, reservedUsdCents: 0 };
      row.reservedUsdCents += amountUsdCents;
      this.rows.set(`${agentId}|${day}`, row);
    });
  }

  onReleased(agentId: string, day: string, amountUsdCents: number): void {
    this.enqueue(() => {
      const row = this.rows.get(`${agentId}|${day}`) ?? { committedUsdCents: 0, reservedUsdCents: 0 };
      row.reservedUsdCents = Math.max(0, row.reservedUsdCents - amountUsdCents);
      this.rows.set(`${agentId}|${day}`, row);
    });
  }

  onCommitted(agentId: string, day: string, amountUsdCents: number): void {
    this.enqueue(() => {
      const row = this.rows.get(`${agentId}|${day}`) ?? { committedUsdCents: 0, reservedUsdCents: 0 };
      row.committedUsdCents += amountUsdCents;
      row.reservedUsdCents = Math.max(0, row.reservedUsdCents - amountUsdCents);
      this.rows.set(`${agentId}|${day}`, row);
    });
  }
}

describe("durable x402 spend caps across a restart", () => {
  it("reservations survive a restart and still count against the cap", async () => {
    const journal = new FakeSpendCapJournal();
    const logger = silentLogger();

    const before = buildPaymentsStack(config(), logger, clock, { journal });
    const today = clock.now().toISOString().slice(0, 10);
    // demo cap for trend-scout-agent is $10/day = 1000c
    const first = before.caps.tryReserve("trend-scout-agent", 900n, clock.now());
    expect(first.ok).toBe(true);

    // sleep/wake: a new ledger restoring from the same journal
    const after = buildPaymentsStack(config(), logger, clock, { journal });
    after.caps.restore(await journal.restore());
    const second = after.caps.tryReserve("trend-scout-agent", 200n, clock.now());
    expect(second.ok).toBe(false); // 900c reserved before the restart still counts
    void today;
  });
});
