import { type RejectionCode } from "@sentinel-mesh/contracts";
import { ExecutionRejectedError } from "./authorization.js";

/**
 * Idempotency registry: an intent executes at most once.
 *  - duplicate submission of the SAME intent returns the prior receipt
 *    (no second execution, no second authorization consumption)
 *  - the same intentId with DIFFERENT parameters is a conflict and fails
 *    closed as duplicate-submission-conflict
 */

export interface LedgerEntry {
  status: "in-flight" | "recorded";
  intentHash: string;
  receiptId?: string;
}

export class IdempotencyRegistry {
  private readonly ledger = new Map<string, LedgerEntry>();

  /**
   * Begin a submission. Returns the prior receiptId when the identical
   * intent already completed (duplicate -> replay the receipt), null when
   * this is a new execution, and THROWS on hash conflicts.
   */
  begin(intentId: string, hash: string): string | null {
    const existing = this.ledger.get(intentId);
    if (!existing) {
      this.ledger.set(intentId, { status: "in-flight", intentHash: hash });
      return null;
    }
    if (existing.intentHash !== hash) {
      throw new ExecutionRejectedError(
        "duplicate-submission-conflict",
        `intentId ${intentId} was already submitted with different parameters`,
      );
    }
    if (existing.status === "recorded") {
      return existing.receiptId ?? null;
    }
    // Identical intent concurrently in flight: not a conflict, but also not
    // a new execution; the caller must not execute twice. Signal in-flight.
    throw new ExecutionRejectedError("duplicate-submission-conflict", "identical intent is already being processed");
  }

  /** Mark the in-flight intent as recorded with its final receipt. */
  complete(intentId: string, hash: string, receiptId: string): void {
    const existing = this.ledger.get(intentId);
    if (!existing || existing.intentHash !== hash) {
      throw new Error(`idempotency ledger inconsistency for ${intentId}`);
    }
    this.ledger.set(intentId, { status: "recorded", intentHash: hash, receiptId });
  }

  /** Abort an in-flight reservation (guards rejected before recording). */
  abort(intentId: string, hash: string): void {
    const existing = this.ledger.get(intentId);
    if (existing && existing.intentHash === hash && existing.status === "in-flight") {
      this.ledger.delete(intentId);
    }
  }

  lookup(intentId: string): LedgerEntry | undefined {
    return this.ledger.get(intentId);
  }

  /**
   * SECURITY (audit 2026-10-19): boot-time restore from the durable
   * journal. Only RECORDED entries are restored; in-flight entries from a
   * dead process are dropped on purpose — no receipt exists for them, so
   * resubmission is correct and cannot double-execute.
   */
  restore(entries: { intentId: string; intentHash: string; receiptId: string }[]): void {
    for (const entry of entries) {
      this.ledger.set(entry.intentId, { status: "recorded", intentHash: entry.intentHash, receiptId: entry.receiptId });
    }
  }

  /**
   * SECURITY (audit 2026-10-21): uncertain live broadcasts (the tx may
   * still land onchain) restore as IN-FLIGHT locks: an identical
   * resubmission must be rejected as a conflict until an operator
   * resolves the onchain outcome (executor.resolveUncertain).
   */
  restoreUncertain(entries: { intentId: string; intentHash: string }[]): void {
    for (const entry of entries) {
      if (!this.ledger.has(entry.intentId)) {
        this.ledger.set(entry.intentId, { status: "in-flight", intentHash: entry.intentHash });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Kill switches
// ---------------------------------------------------------------------------

/**
 * Kill switch: global, per-user, and per-strategy switches with an explicit
 * "unknown" state. ONLY the "clear" state permits execution; "engaged" and
 * "unknown" both fail closed. There is no state that bypasses the switch.
 */
export class KillSwitch {
  private readonly global = new Map<string, "clear" | "engaged" | "unknown">();
  private readonly userSwitches = new Map<string, "clear" | "engaged" | "unknown">();
  private readonly strategySwitches = new Map<string, "clear" | "engaged" | "unknown">();

  setGlobal(state: "clear" | "engaged" | "unknown"): void {
    this.global.set("global", state);
  }

  setUser(userId: string, state: "clear" | "engaged" | "unknown"): void {
    this.userSwitches.set(userId, state);
  }

  setStrategy(strategyId: string, state: "clear" | "engaged" | "unknown"): void {
    this.strategySwitches.set(strategyId, state);
  }

  /**
   * SECURITY (audit 2026-10-19): boot-time restore from the durable
   * journal. A restored state REPLACES the in-memory default, so an
   * ENGAGED switch cannot be lost to a restart. A missing 'global' row is
   * NOT restored as clear: the in-memory default stays "unknown" and
   * execution fails closed until an operator clears the switch.
   */
  restore(states: { scope: string; state: "clear" | "engaged" | "unknown" }[]): void {
    for (const { scope, state } of states) {
      if (scope === "global") {
        this.global.set("global", state);
      } else if (scope.startsWith("user:")) {
        this.userSwitches.set(scope.slice("user:".length), state);
      } else if (scope.startsWith("strategy:")) {
        this.strategySwitches.set(scope.slice("strategy:".length), state);
      }
    }
  }

  /** Read-only snapshot for the dashboard; nothing mutable escapes. */
  snapshot(): { global: "clear" | "engaged" | "unknown"; users: Record<string, "clear" | "engaged" | "unknown">; strategies: Record<string, "clear" | "engaged" | "unknown"> } {
    return {
      global: this.global.get("global") ?? "unknown",
      users: Object.fromEntries(this.userSwitches),
      strategies: Object.fromEntries(this.strategySwitches),
    };
  }

  /** Fail-closed check: anything other than an explicit clear rejects. */
  check(scope: { userId: string; strategyId: string }): void {
    const code: RejectionCode | undefined = this.rejectionFor(scope);
    if (code === "kill-switch-engaged") {
      throw new ExecutionRejectedError(code, "kill switch is engaged");
    }
    if (code === "kill-switch-unknown") {
      throw new ExecutionRejectedError(code, "kill switch state cannot be verified; failing closed");
    }
  }

  rejectionFor(scope: { userId: string; strategyId: string }): RejectionCode | undefined {
    // GLOBAL: must be explicitly clear; unset or unknown fails closed.
    const globalState = this.global.get("global");
    if (globalState === "engaged") {
      return "kill-switch-engaged";
    }
    if (globalState !== "clear") {
      return "kill-switch-unknown";
    }
    // USER and STRATEGY scopes: unset (never configured) is fine; only an
    // explicit "engaged" or "unknown" state fails closed.
    for (const state of [this.userSwitches.get(scope.userId), this.strategySwitches.get(scope.strategyId)]) {
      if (state === "engaged") {
        return "kill-switch-engaged";
      }
      if (state === "unknown") {
        return "kill-switch-unknown";
      }
    }
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Reconciliation ledger
// ---------------------------------------------------------------------------

import type { ExecutionReceipt, ReconciliationReport } from "@sentinel-mesh/contracts";

/** Canonical, append-only view of receipts for reconciliation and audit. */
export class ReconciliationLedger {
  private readonly receipts = new Map<string, ExecutionReceipt>();

  record(receipt: ExecutionReceipt): void {
    const existing = this.receipts.get(receipt.receiptId);
    if (existing && JSON.stringify(existing) !== JSON.stringify(receipt)) {
      throw new Error(`ledger corruption: receipt ${receipt.receiptId} recorded with different content`);
    }
    this.receipts.set(receipt.receiptId, receipt);
  }

  receiptsForIntent(intentId: string): ExecutionReceipt[] {
    return [...this.receipts.values()].filter((receipt) => receipt.intentId === intentId);
  }

  /**
   * SECURITY (audit 2026-10-19): boot-time restore of the paper journal
   * from the durable store, so receipt replay and reconciliation keep
   * working across a restart.
   */
  restore(receipts: ExecutionReceipt[]): void {
    for (const receipt of receipts) {
      this.record(receipt);
    }
  }

  all(): ExecutionReceipt[] {
    return [...this.receipts.values()];
  }

  receiptById(receiptId: string): ExecutionReceipt | undefined {
    return this.receipts.get(receiptId);
  }

  /**
   * Reconcile the ledger against the set of intents that were submitted:
   *  - every submitted intent must have at least one receipt
   *  - no intent may have more than one PAPER-FILLED receipt (duplicate
   *    execution). Rejection receipts do not count: a rejected intent that
   *    is later retried and filled legitimately accumulates one rejection
   *    receipt plus one fill.
   *  - receipts must reference known intents (no orphan receipts)
   */
  reconcile(submittedIntentIds: string[], now: () => Date): ReconciliationReport {
    const submitted = new Set(submittedIntentIds);
    const byIntent = new Map<string, ExecutionReceipt[]>();
    const mismatches: { intentId: string; problem: string }[] = [];
    const duplicateReceipts: string[] = [];

    for (const receipt of this.all()) {
      if (!submitted.has(receipt.intentId)) {
        mismatches.push({ intentId: receipt.intentId, problem: `orphan receipt ${receipt.receiptId} references an intent that was never submitted` });
      }
      const list = byIntent.get(receipt.intentId) ?? [];
      list.push(receipt);
      byIntent.set(receipt.intentId, list);
    }

    const missingReceipts: string[] = [];
    for (const intentId of submitted) {
      const receipts = byIntent.get(intentId) ?? [];
      if (receipts.length === 0) {
        missingReceipts.push(intentId);
      } else if (receipts.filter((receipt) => receipt.status === "paper-filled").length > 1) {
        duplicateReceipts.push(intentId);
      }
    }

    const report: ReconciliationReport = {
      ranAt: now().toISOString(),
      receiptsChecked: this.all().length,
      missingReceipts,
      duplicateReceipts,
      mismatches,
      consistent: missingReceipts.length === 0 && duplicateReceipts.length === 0 && mismatches.length === 0,
    };
    return report;
  }
}
