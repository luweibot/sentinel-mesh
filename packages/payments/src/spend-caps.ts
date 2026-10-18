/**
 * Per-agent daily spend caps. A payment RESERVES cap space when recorded
 * and COMMITS it when settled; rejected payments release their
 * reservation. Fail closed: unknown agents start at zero utilization but
 * still must fit within their configured cap.
 */

export interface CapVerdict {
  ok: boolean;
  utilizedUsdCents: number;
}

export class SpendCapLedger {
  private readonly reserved = new Map<string, number>();
  private readonly committed = new Map<string, Map<string, number>>();
  private readonly pending = new Map<string, Map<string, number>>();

  constructor(private readonly caps: Record<string, number>) {}

  capOf(agentId: string): number {
    return this.caps[agentId] ?? 0;
  }

  utilized(agentId: string, now: Date): number {
    const today = this.dayKey(now);
    const committedToday = this.committed.get(agentId)?.get(today) ?? 0;
    const reservedToday = this.pending.get(agentId)?.get(today) ?? 0;
    return committedToday + reservedToday;
  }

  tryReserve(agentId: string, amountUsdCents: bigint, now: Date): CapVerdict {
    const cap = this.capOf(agentId);
    const today = this.dayKey(now);
    const amount = Number(amountUsdCents);
    const committedToday = this.committed.get(agentId)?.get(today) ?? 0;
    const reservedToday = this.pending.get(agentId)?.get(today) ?? 0;
    const utilized = committedToday + reservedToday;
    if (utilized + amount > cap) {
      return { ok: false, utilizedUsdCents: utilized };
    }
    const pending = this.pending.get(agentId) ?? new Map<string, number>();
    pending.set(today, reservedToday + amount);
    this.pending.set(agentId, pending);
    return { ok: true, utilizedUsdCents: utilized + amount };
  }

  /** Release a reservation when the payment is rejected (not settled). */
  release(agentId: string, amountUsdCents: number, now: Date): void {
    const today = this.dayKey(now);
    const pending = this.pending.get(agentId);
    const reservedToday = pending?.get(today) ?? 0;
    pending?.set(today, Math.max(0, reservedToday - amountUsdCents));
  }

  commit(agentId: string): void {
    const pending = this.pending.get(agentId);
    if (!pending) return;
    const committed = this.committed.get(agentId) ?? new Map<string, number>();
    for (const [day, amount] of pending) {
      committed.set(day, (committed.get(day) ?? 0) + amount);
    }
    this.committed.set(agentId, committed);
    this.pending.set(agentId, new Map());
  }

  private dayKey(now: Date): string {
    return now.toISOString().slice(0, 10);
  }
}

