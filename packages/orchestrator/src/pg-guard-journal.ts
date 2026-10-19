import type { QueryExecutor } from "@sentinel-mesh/database";
import { ExecutionReceipt } from "@sentinel-mesh/contracts";
import type {
  GuardStateJournal,
  GuardStateSnapshot,
  IdempotencyCommitEntry,
  KillSwitchScope,
  KillSwitchState,
  RestoredFill,
  RestoredIdempotencyEntry,
  RestoredKillSwitch,
  RestoredSpendCaps,
} from "@sentinel-mesh/execution";

/**
 * Postgres-backed guard-state journal (migration 006).
 *
 * SECURITY (audit 2026-10-19): the in-memory guard runtime remains the
 * authoritative race-protected state; this journal persists every commit
 * point so boot-time restore() rebuilds it after a sleep/restart. Commit
 * records (receipt + idempotency) are written in ONE transaction; kill-
 * switch writes happen before the in-memory switch changes.
 */
export class PgGuardStateJournal implements GuardStateJournal {
  constructor(private readonly executor: QueryExecutor) {}

  async restore(): Promise<GuardStateSnapshot> {
    // In-flight idempotency rows belong to a dead process: no receipt was
    // committed, so the intent may be resubmitted. Drop them.
    await this.executor.query("delete from guard_idempotency where status = 'in-flight'");

    const receipts = await this.executor.query(
      "select payload from guard_receipts order by recorded_at asc",
    );
    const idempotency = await this.executor.query(
      "select intent_id, intent_hash, receipt_id from guard_idempotency where status = 'recorded'",
    );
    const fills = await this.executor.query(
      "select fill_id, user_id, strategy_id, chain, notional_usd_cents, pnl_usd_cents, day from guard_fills where released = false",
    );
    const killSwitch = await this.executor.query(
      "select scope, state from guard_kill_switch",
    );
    const spendCaps = await this.executor.query(
      "select agent_id, day, committed_usd_cents, reserved_usd_cents from guard_spend_caps",
    );

    const restoredIdempotency: RestoredIdempotencyEntry[] = (idempotency.rows as ReadonlyArray<Record<string, unknown>>).map((row) => ({
      intentId: String(row["intent_id"]),
      intentHash: String(row["intent_hash"]),
      status: "recorded",
      receiptId: String(row["receipt_id"]),
    }));

    const restoredFills: RestoredFill[] = (fills.rows as ReadonlyArray<Record<string, unknown>>).map((row) => ({
      fillId: String(row["fill_id"]),
      userId: String(row["user_id"]),
      strategyId: String(row["strategy_id"]),
      chain: String(row["chain"]),
      notionalUsdCents: Number(row["notional_usd_cents"]),
      pnlUsdCents: Number(row["pnl_usd_cents"]),
      day: String(row["day"]),
    }));

    const restoredKillSwitch: RestoredKillSwitch[] = (killSwitch.rows as ReadonlyArray<Record<string, unknown>>).map((row) => ({
      scope: String(row["scope"]),
      state: String(row["state"]) as KillSwitchState,
    }));

    const restoredSpendCaps: RestoredSpendCaps[] = (spendCaps.rows as ReadonlyArray<Record<string, unknown>>).map((row) => ({
      agentId: String(row["agent_id"]),
      day: String(row["day"]),
      committedUsdCents: Number(row["committed_usd_cents"]),
      reservedUsdCents: Number(row["reserved_usd_cents"]),
    }));

    return {
      receipts: (receipts.rows as ReadonlyArray<Record<string, unknown>>)
        .map((row) => {
          try {
            // pg returns jsonb columns as PARSED objects; the string path
            // covers fakes and string-typed payloads.
            const raw = row["payload"];
            const receipt = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
            return ExecutionReceipt.parse(receipt);
          } catch {
            return undefined;
          }
        })
        .filter((receipt): receipt is ExecutionReceipt => receipt !== undefined),
      idempotency: restoredIdempotency,
      fills: restoredFills,
      killSwitch: restoredKillSwitch,
      spendCaps: restoredSpendCaps,
    };
  }

  async recordCommit(receipt: ExecutionReceipt, entry: IdempotencyCommitEntry): Promise<void> {
    // ONE transaction: the receipt and its idempotency entry land together
    // or not at all, so restore can never see a recorded intent whose
    // receipt is missing.
    await this.executor.query("BEGIN");
    try {
      await this.executor.query(
        `insert into guard_receipts (receipt_id, intent_id, payload)
         values ($1, $2, $3)
         on conflict (receipt_id) do nothing`,
        [receipt.receiptId, receipt.intentId, JSON.stringify(receipt)],
      );
      await this.executor.query(
        `insert into guard_idempotency (intent_id, intent_hash, status, receipt_id)
         values ($1, $2, 'recorded', $3)
         on conflict (intent_id) do update set
           intent_hash = excluded.intent_hash,
           status = 'recorded',
           receipt_id = excluded.receipt_id`,
        [entry.intentId, entry.intentHash, entry.receiptId],
      );
      await this.executor.query("COMMIT");
    } catch (error) {
      await this.executor.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  }

  async recordRejection(receipt: ExecutionReceipt): Promise<void> {
    await this.executor.query(
      `insert into guard_receipts (receipt_id, intent_id, payload)
       values ($1, $2, $3)
       on conflict (receipt_id) do nothing`,
      [receipt.receiptId, receipt.intentId, JSON.stringify(receipt)],
    );
  }

  async recordAbort(intentId: string): Promise<void> {
    await this.executor.query("delete from guard_idempotency where intent_id = $1", [intentId]);
  }

  async recordFill(fill: RestoredFill): Promise<void> {
    await this.executor.query(
      `insert into guard_fills (fill_id, user_id, strategy_id, chain, notional_usd_cents, pnl_usd_cents, day)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (fill_id) do nothing`,
      [fill.fillId, fill.userId, fill.strategyId, fill.chain, fill.notionalUsdCents, fill.pnlUsdCents, fill.day],
    );
  }

  async releaseFill(fillId: string): Promise<void> {
    await this.executor.query("update guard_fills set released = true where fill_id = $1", [fillId]);
  }

  async recordKillSwitch(scope: KillSwitchScope, state: KillSwitchState): Promise<void> {
    await this.executor.query(
      `insert into guard_kill_switch (scope, state) values ($1, $2)
       on conflict (scope) do update set state = excluded.state`,
      [scope, state],
    );
  }
}

/** Journal interface for the x402 spend-cap ledger (payments package). */
export interface SpendCapStateJournal {
  restore(): Promise<RestoredSpendCaps[]>;
  /** Queued (fire-and-forget) delta write; the sync ledger never blocks. */
  onReserved(agentId: string, day: string, amountUsdCents: number): void;
  onReleased(agentId: string, day: string, amountUsdCents: number): void;
  onCommitted(agentId: string, day: string, amountUsdCents: number): void;
}

/**
 * Postgres-backed spend-cap journal (guard_spend_caps table, migration 006).
 * Writes are DELTA upserts behind a serialized queue so the synchronous
 * in-memory ledger never blocks on I/O (its reservation race must stay
 * synchronous). A crash can lose only the final queued delta — documented,
 * paper-safe residual.
 */
export class PgSpendCapJournal implements SpendCapStateJournal {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly executor: QueryExecutor, private readonly onError: (error: unknown) => void) {}

  private enqueue(operation: () => Promise<void>): void {
    this.queue = this.queue.then(operation).catch((error: unknown) => {
      this.onError(error);
    });
  }

  async restore(): Promise<RestoredSpendCaps[]> {
    const result = await this.executor.query(
      "select agent_id, day, committed_usd_cents, reserved_usd_cents from guard_spend_caps",
    );
    return (result.rows as ReadonlyArray<Record<string, unknown>>).map((row) => ({
      agentId: String(row["agent_id"]),
      day: String(row["day"]),
      committedUsdCents: Number(row["committed_usd_cents"]),
      reservedUsdCents: Number(row["reserved_usd_cents"]),
    }));
  }

  private upsert(agentId: string, day: string, field: "committed_usd_cents" | "reserved_usd_cents", delta: number): void {
    this.enqueue(async () => {
      await this.executor.query(
        `insert into guard_spend_caps (agent_id, day, committed_usd_cents, reserved_usd_cents)
         values ($1, $2, $3, $4)
         on conflict (agent_id, day) do update set
           committed_usd_cents = greatest(0, guard_spend_caps.committed_usd_cents + excluded.committed_usd_cents),
           reserved_usd_cents = greatest(0, guard_spend_caps.reserved_usd_cents + excluded.reserved_usd_cents)`,
        [agentId, day, field === "committed_usd_cents" ? delta : 0, field === "reserved_usd_cents" ? delta : 0],
      );
    });
  }

  onReserved(agentId: string, day: string, amountUsdCents: number): void {
    this.upsert(agentId, day, "reserved_usd_cents", amountUsdCents);
  }

  onReleased(agentId: string, day: string, amountUsdCents: number): void {
    this.upsert(agentId, day, "reserved_usd_cents", -amountUsdCents);
  }

  onCommitted(agentId: string, day: string, amountUsdCents: number): void {
    this.enqueue(async () => {
      await this.executor.query(
        `insert into guard_spend_caps (agent_id, day, committed_usd_cents, reserved_usd_cents)
         values ($1, $2, $3, 0)
         on conflict (agent_id, day) do update set
           committed_usd_cents = guard_spend_caps.committed_usd_cents + $3,
           reserved_usd_cents = greatest(0, guard_spend_caps.reserved_usd_cents - $3)`,
        [agentId, day, amountUsdCents],
      );
    });
  }
}
