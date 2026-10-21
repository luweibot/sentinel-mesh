import type { ExecutionReceipt } from "@sentinel-mesh/contracts";

/**
 * Guard-state journal: optional durability behind the in-memory guard
 * runtime. SECURITY (audit 2026-10-19): the guard pipeline keeps its
 * authoritative runtime state in process memory (single-process,
 * synchronous race protection per audit 2026-10-18); the journal records
 * the same facts in durable storage and rebuilds that state at boot, so a
 * sleeping or restarted instance cannot lose guard guarantees:
 *
 *  - a COMPLETED intent replays its receipt instead of re-executing
 *  - cap fills (trade/position/exposure/loss) survive a restart
 *  - an ENGAGED kill switch survives a restart
 *  - a missing kill-switch 'global' row restores as UNKNOWN (fail closed)
 *  - x402 spend-cap utilization survives a restart
 *
 * Write ordering rules implementations must respect:
 *  - commit records (receipt + idempotency) are written ATOMICALLY in one
 *    call before the receipt is returned to the caller
 *  - kill-switch writes happen BEFORE the in-memory state changes, so a
 *    failed write can never silently lose an ENGAGED state
 *  - fill reservations are recorded in memory first (race protection) and
 *    journaled second; a crash in that sub-second window can under-count
 *    caps after restore (paper-safe, documented residual risk)
 */

export type KillSwitchState = "clear" | "engaged" | "unknown";
/** 'global' | 'user:<id>' | 'strategy:<id>' */
export type KillSwitchScope = string;

/** A restored (post-restart) idempotency entry; only recorded entries are restored. */
export interface RestoredIdempotencyEntry {
  intentId: string;
  intentHash: string;
  status: "recorded";
  receiptId: string;
}

export interface RestoredFill {
  fillId: string;
  userId: string;
  strategyId: string;
  chain: string;
  notionalUsdCents: number;
  pnlUsdCents: number;
  day: string;
}

export interface RestoredKillSwitch {
  scope: KillSwitchScope;
  state: KillSwitchState;
}

export interface RestoredSpendCaps {
  agentId: string;
  day: string;
  committedUsdCents: number;
  reservedUsdCents: number;
}

/**
 * An uncertain live broadcast (audit 2026-10-21): the transaction may
 * still land onchain, so the in-flight idempotency lock AND the cap
 * reservation are RETAINED until an operator resolves the outcome after
 * onchain reconciliation. Journaled durably so the lock survives a
 * restart; cap reservations persist as released=false guard_fills rows.
 */
export interface UncertainJournalEntry {
  intentId: string;
  intentHash: string;
  /** The full intent as submitted (JSON shape). */
  intent: unknown;
  authorizationId: string;
  reservedFillId: string;
  decidedAt: string;
}

/** Snapshot loaded from durable storage at boot, before serving traffic. */
export interface GuardStateSnapshot {
  receipts: ExecutionReceipt[];
  idempotency: RestoredIdempotencyEntry[];
  fills: RestoredFill[];
  killSwitch: RestoredKillSwitch[];
  spendCaps: RestoredSpendCaps[];
  /** Uncertain live broadcasts restored as in-flight locks. */
  uncertain: UncertainJournalEntry[];
}

/** An idempotency ledger entry as journaled for a completed intent. */
export interface IdempotencyCommitEntry {
  intentId: string;
  intentHash: string;
  receiptId: string;
}

/**
 * Journal interface implemented by Postgres-backed storage (and by test
 * fakes). Every method is durable-or-throwing: implementations must not
 * swallow write errors silently.
 */
export interface GuardStateJournal {
  /** Load the full guard state for boot-time restore. */
  restore(): Promise<GuardStateSnapshot>;
  /** Atomically journal a paper-filled receipt and its idempotency entry. */
  recordCommit(receipt: ExecutionReceipt, entry: IdempotencyCommitEntry): Promise<void>;
  /** Journal a rejection receipt (audit trail; idempotency is aborted separately). */
  recordRejection(receipt: ExecutionReceipt): Promise<void>;
  /** Journal that an intent's in-flight reservation was aborted (allows resubmission). */
  recordAbort(intentId: string): Promise<void>;
  /** Journal an uncertain live broadcast: the tx may still land onchain;
   * the in-flight idempotency lock is RETAINED until resolveUncertain. */
  recordUncertain(entry: UncertainJournalEntry): Promise<void>;
  /** Remove the uncertain record after onchain reconciliation (operator). */
  resolveUncertain(intentId: string): Promise<void>;
  /** Journal a cap fill reservation. */
  recordFill(fill: RestoredFill): Promise<void>;
  /** Journal that a fill reservation was released (rejected downstream). */
  releaseFill(fillId: string): Promise<void>;
  /** Durable kill-switch write; called BEFORE the in-memory switch changes. */
  recordKillSwitch(scope: KillSwitchScope, state: KillSwitchState): Promise<void>;
}
