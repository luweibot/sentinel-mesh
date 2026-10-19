import { randomUUID } from "node:crypto";
import type { RejectionCode, TradeIntent } from "@sentinel-mesh/contracts";
import { ExecutionRejectedError } from "./authorization.js";
import type { GuardStateJournal, RestoredFill } from "./journal.js";

/**
 * Per-user and per-strategy limits: trade size caps, open position caps,
 * daily loss caps, and per-chain exposure caps.
 *
 * Limit policies must be EXPLICITLY configured for a user and a strategy;
 * a missing policy fails closed rather than defaulting to permissive.
 */

export interface UserLimits {
  /** Max single-trade notional in USD cents. */
  maxTradeUsdCents: number;
  /** Max trades per UTC day for this user. */
  maxTradesPerDay: number;
  /** Max aggregate open position notional in USD cents. */
  maxOpenPositionUsdCents: number;
  /** Max daily net loss in USD cents (positive number = loss cap). */
  dailyLossCapUsdCents: number;
  /** Max aggregate exposure per chain, in USD cents. */
  maxChainExposureUsdCents: Record<string, number>;
}

export interface StrategyLimits {
  /** Max single-trade notional in USD cents for this strategy. */
  maxTradeUsdCents: number;
  /** Max trades per UTC day for this strategy. */
  maxTradesPerDay: number;
}

export interface LimitStore {
  /** Current open position notional in USD cents for a user. */
  openPositionUsdCents(userId: string): number;
  /** Trades executed today (UTC) for a user; counts paper fills only. */
  tradesToday(userId: string): number;
  /** Trades executed today (UTC) for a strategy. */
  strategyTradesToday(strategyId: string): number;
  /** Today's realized net PnL in USD cents (negative = loss) for a user. */
  realizedPnlUsdCentsToday(userId: string): number;
  /** Current aggregate exposure in USD cents for a user on a chain. */
  chainExposureUsdCents(userId: string, chain: string): number;
  /** Record a paper fill so caps track state. Returns the fillId. */
  recordFill(input: { userId: string; strategyId: string; chain: string; notionalUsdCents: number; pnlUsdCents: number; day: string }): string;
  /** Remove a recorded fill (release a reservation). No-op for unknown ids. */
  removeFill(fillId: string): void;
}

/** Deterministic in-memory limit store for tests and the dev environment. */
export class InMemoryLimitStore implements LimitStore {
  private readonly fills: { fillId: string; userId: string; strategyId: string; chain: string; notionalUsdCents: number; pnlUsdCents: number; day: string }[] = [];

  constructor(private readonly clock: { now(): Date } = { now: () => new Date() }) {}

  private today(): string {
    return this.clock.now().toISOString().slice(0, 10);
  }

  openPositionUsdCents(userId: string): number {
    return this.fills.filter((f) => f.userId === userId).reduce((sum, f) => sum + f.notionalUsdCents, 0);
  }

  tradesToday(userId: string): number {
    return this.fills.filter((f) => f.userId === userId && f.day === this.today()).length;
  }

  strategyTradesToday(strategyId: string): number {
    return this.fills.filter((f) => f.strategyId === strategyId && f.day === this.today()).length;
  }

  realizedPnlUsdCentsToday(userId: string): number {
    return this.fills.filter((f) => f.userId === userId && f.day === this.today()).reduce((sum, f) => sum + f.pnlUsdCents, 0);
  }

  chainExposureUsdCents(userId: string, chain: string): number {
    return this.fills.filter((f) => f.userId === userId && f.chain === chain).reduce((sum, f) => sum + f.notionalUsdCents, 0);
  }

  recordFill(input: { userId: string; strategyId: string; chain: string; notionalUsdCents: number; pnlUsdCents: number; day: string }): string {
    const fillId = randomUUID();
    this.fills.push({ ...input, fillId });
    return fillId;
  }

  removeFill(fillId: string): void {
    const index = this.fills.findIndex((fill) => fill.fillId === fillId);
    if (index >= 0) this.fills.splice(index, 1);
  }

  /** Test helper: preset state for the day (defaults to the clock's day). */
  seed(input: { userId: string; strategyId: string; chain: string; notionalUsdCents: number; pnlUsdCents: number; day?: string }): void {
    this.recordFill({ ...input, day: input.day ?? this.today() });
  }

  /**
   * SECURITY (audit 2026-10-19): boot-time restore from the durable
   * journal. Restored fills count against the caps exactly as live ones
   * do, so a restart cannot reset trade/position/exposure/loss state.
   */
  restore(fills: RestoredFill[]): void {
    for (const fill of fills) {
      this.fills.push({ ...fill });
    }
  }
}

export interface LimitPolicySource {
  userLimits(userId: string): UserLimits | undefined;
  strategyLimits(strategyId: string): StrategyLimits | undefined;
}

export class StaticLimitPolicySource implements LimitPolicySource {
  private readonly users = new Map<string, UserLimits>();
  private readonly strategies = new Map<string, StrategyLimits>();

  setUserLimits(userId: string, limits: UserLimits): void {
    this.users.set(userId, limits);
  }

  setStrategyLimits(strategyId: string, limits: StrategyLimits): void {
    this.strategies.set(strategyId, limits);
  }

  userLimits(userId: string): UserLimits | undefined {
    return this.users.get(userId);
  }

  strategyLimits(strategyId: string): StrategyLimits | undefined {
    return this.strategies.get(strategyId);
  }
}

/**
 * Limits service: evaluates an intent against explicit user and strategy
 * policies plus live position/exposure/loss state. Missing policies and
 * exceeded caps fail closed with typed codes.
 */
export class LimitsService {
  constructor(
    private readonly policies: LimitPolicySource,
    private readonly store: LimitStore,
    private readonly clock: { now(): Date },
    /** Durable journal; absent in the pure in-memory dev mode. */
    private readonly journal?: GuardStateJournal,
  ) {}

  evaluate(intent: TradeIntent, notionalUsdCents: number): void {
    const user = this.policies.userLimits(intent.userId);
    if (!user) {
      throw new ExecutionRejectedError("user-limit-exceeded", `no limit policy configured for user '${intent.userId}'; refusing to execute`);
    }
    const strategy = this.policies.strategyLimits(intent.strategyId);
    if (!strategy) {
      throw new ExecutionRejectedError("strategy-limit-exceeded", `no limit policy configured for strategy '${intent.strategyId}'; refusing to execute`);
    }

    if (notionalUsdCents > user.maxTradeUsdCents) {
      throw new ExecutionRejectedError("user-limit-exceeded", `trade notional ${notionalUsdCents}c exceeds user cap ${user.maxTradeUsdCents}c`);
    }
    if (notionalUsdCents > strategy.maxTradeUsdCents) {
      throw new ExecutionRejectedError("strategy-limit-exceeded", `trade notional ${notionalUsdCents}c exceeds strategy cap ${strategy.maxTradeUsdCents}c`);
    }
    if (this.store.tradesToday(intent.userId) >= user.maxTradesPerDay) {
      throw new ExecutionRejectedError("user-limit-exceeded", `user has reached the daily trade cap of ${user.maxTradesPerDay}`);
    }
    if (this.store.strategyTradesToday(intent.strategyId) >= strategy.maxTradesPerDay) {
      throw new ExecutionRejectedError("strategy-limit-exceeded", `strategy has reached the daily trade cap of ${strategy.maxTradesPerDay}`);
    }
    const openAfter = this.store.openPositionUsdCents(intent.userId) + notionalUsdCents;
    if (openAfter > user.maxOpenPositionUsdCents) {
      throw new ExecutionRejectedError("position-cap-exceeded", `open position ${openAfter}c would exceed cap ${user.maxOpenPositionUsdCents}c`);
    }
    const chainCap = user.maxChainExposureUsdCents[intent.chain];
    if (chainCap === undefined) {
      throw new ExecutionRejectedError("exposure-cap-exceeded", `no exposure cap configured for chain '${intent.chain}'; refusing to execute`);
    }
    const exposureAfter = this.store.chainExposureUsdCents(intent.userId, intent.chain) + notionalUsdCents;
    if (exposureAfter > chainCap) {
      throw new ExecutionRejectedError("exposure-cap-exceeded", `chain exposure ${exposureAfter}c would exceed cap ${chainCap}c`);
    }
    const pnlToday = this.store.realizedPnlUsdCentsToday(intent.userId);
    if (-pnlToday >= user.dailyLossCapUsdCents) {
      throw new ExecutionRejectedError("daily-loss-cap-exceeded", `daily loss ${-pnlToday}c has reached the cap ${user.dailyLossCapUsdCents}c`);
    }
  }

  recordFill(intent: TradeIntent, notionalUsdCents: number, pnlUsdCents = 0): string {
    return this.store.recordFill({
      userId: intent.userId,
      strategyId: intent.strategyId,
      chain: intent.chain,
      notionalUsdCents,
      pnlUsdCents,
      day: this.clock.now().toISOString().slice(0, 10),
    });
  }

  /**
   * SECURITY (audit 2026-10-18): evaluate the caps AND record the fill in
   * one synchronous step, so concurrent intents cannot both pass the caps
   * before either is recorded (check-then-act race). The caller releases
   * the reservation via releaseReservation() when a later guard rejects.
   *
   * SECURITY (audit 2026-10-19): when a durable journal is wired, the
   * in-memory reservation (still synchronous, still race-safe) is
   * journaled before the fill id is returned, so a restart restores the
   * reservation. Residual, documented risk: a crash in the sub-second
   * window between the in-memory insert and the journal write under-counts
   * the caps after restore (paper-safe direction).
   */
  async evaluateAndReserve(intent: TradeIntent, notionalUsdCents: number): Promise<string> {
    this.evaluate(intent, notionalUsdCents);
    const fillId = this.recordFill(intent, notionalUsdCents);
    if (this.journal) {
      const day = this.clock.now().toISOString().slice(0, 10);
      await this.journal.recordFill({
        fillId,
        userId: intent.userId,
        strategyId: intent.strategyId,
        chain: intent.chain,
        notionalUsdCents,
        pnlUsdCents: 0,
        day,
      });
    }
    return fillId;
  }

  /** Release a reservation taken by evaluateAndReserve. */
  async releaseReservation(fillId: string): Promise<void> {
    this.store.removeFill(fillId);
    await this.journal?.releaseFill(fillId);
  }
}

export type { RejectionCode };
