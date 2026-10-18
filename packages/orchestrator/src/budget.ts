/**
 * Per-agent resource budgets.
 *
 * Two limits are enforced at task start:
 *  - maxTasksPerMinute: rolling 60s window of task starts.
 *  - maxConcurrent: simultaneous executions.
 *
 * The ledger is deterministic: timestamps come from the injected clock, no
 * jitter, no randomization. When a limit blocks a task, the ledger reports
 * how long to wait; the engine parks the task as retry-scheduled and its tick
 * re-drives it later.
 */
export interface BudgetLimits {
  maxTasksPerMinute: number;
  maxConcurrent: number;
}

export interface AcquireResult {
  ok: boolean;
  retryInMs: number;
}

export class BudgetLedger {
  private readonly starts = new Map<string, number[]>();
  private readonly active = new Map<string, number>();

  tryAcquire(agentId: string, limits: BudgetLimits, nowMs: number): AcquireResult {
    const active = this.active.get(agentId) ?? 0;
    if (active >= limits.maxConcurrent) {
      return { ok: false, retryInMs: 50 };
    }
    const windowStart = nowMs - 60_000;
    const stamps = (this.starts.get(agentId) ?? []).filter((t) => t >= windowStart);
    if (stamps.length >= limits.maxTasksPerMinute) {
      this.starts.set(agentId, stamps);
      const oldest = stamps[0] ?? nowMs;
      return { ok: false, retryInMs: Math.max(1, oldest + 60_000 - nowMs) };
    }
    stamps.push(nowMs);
    this.starts.set(agentId, stamps);
    return { ok: true, retryInMs: 0 };
  }

  begin(agentId: string): void {
    this.active.set(agentId, (this.active.get(agentId) ?? 0) + 1);
  }

  end(agentId: string): void {
    const current = this.active.get(agentId) ?? 0;
    this.active.set(agentId, Math.max(0, current - 1));
  }
}
