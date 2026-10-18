import { finalityDepth, type SolanaCommitmentLevel, type SupportedChain } from "./registry.js";
import { RateLimitError, RpcError, type BlockProvenance } from "./providers.js";

/**
 * Resilience layer for read-only providers:
 *  - RateLimiter: deterministic token bucket (injectable clock, no jitter)
 *  - withRetry: retries ONLY retriable, idempotent reads; bounded attempts
 *  - drainPagination: cursor pagination with a hard page cap
 *  - ReorgPolicy: observation finality via block/slot depth vs provenance
 *  - DedupeBuffer: (chain, txId, eventIndex) event dedupe with bounded memory
 *  - commitment helpers: requireFinality for Solana reads
 */

export interface Clock {
  now(): Date;
}

/** Deterministic token-bucket rate limiter. */
export class RateLimiter {
  private tokens: number;
  private lastRefillMs: number;

  constructor(
    readonly maxTokens: number,
    readonly refillPerMinute: number,
    private readonly clock: Clock,
  ) {
    if (!Number.isInteger(maxTokens) || maxTokens <= 0 || !Number.isInteger(refillPerMinute) || refillPerMinute <= 0) {
      throw new Error("rate limit parameters must be positive integers");
    }
    this.tokens = maxTokens;
    this.lastRefillMs = clock.now().getTime();
  }

  private refill(): void {
    const nowMs = this.clock.now().getTime();
    const elapsedMin = (nowMs - this.lastRefillMs) / 60_000;
    if (elapsedMin <= 0) {
      return;
    }
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsedMin * this.refillPerMinute);
    this.lastRefillMs = nowMs;
  }

  /** Take one token or throw RateLimitError with a deterministic backoff. */
  take(): void {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }
    const msPerToken = Math.max(1, Math.ceil(60_000 / this.refillPerMinute));
    throw new RateLimitError(msPerToken);
  }

  /** Non-throwing probe for wrappers that prefer parking. */
  tryTake(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}

/** Deterministic fixed backoff; no jitter so tests are reproducible. */
export function backoffMsForAttempt(baseMs: number, attempt: number): number {
  return baseMs * attempt;
}

export interface RetryOptions {
  maxAttempts: number;
  baseBackoffMs: number;
  clock: Clock;
  /** Sleep function; tests inject a no-op to stay synchronous. */
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (error: RpcError, attempt: number, backoffMs: number) => void;
}

/**
 * Wrap an idempotent read with bounded retries. Retriable RpcError codes are
 * re-attempted with deterministic backoff; non-retriable errors (and
 * RateLimitError) propagate immediately.
 */
export async function withRetry<T>(read: () => Promise<T>, options: RetryOptions): Promise<T> {
  const sleep = options.sleep ?? (() => Promise.resolve());
  let lastError: RpcError | undefined;
  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    try {
      return await read();
    } catch (error) {
      if (!(error instanceof RpcError) || !error.retriable) {
        throw error;
      }
      lastError = error;
      if (attempt < options.maxAttempts) {
        const backoffMs = backoffMsForAttempt(options.baseBackoffMs, attempt);
        options.onRetry?.(error, attempt, backoffMs);
        await sleep(backoffMs);
        options.clock.now(); // determinism hook for advanced clocks
      }
    }
  }
  throw lastError ?? new Error("withRetry: exhausted attempts without an error");
}

/** Wrap every provider method with a rate limiter (fails with RateLimitError). */
export function withRateLimit<T extends object>(provider: T, limiter: RateLimiter): T {
  return new Proxy(provider, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === "function" && prop !== "name") {
        // Async so rate-limit throws surface as rejections, not sync throws.
        return async (...args: unknown[]) => {
          limiter.take();
          return (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
        };
      }
      return value;
    },
  });
}

/** Drain cursor pagination with a hard page cap. Returns everything seen. */
export async function drainPagination<T>(
  fetchPage: (cursor: string | null) => Promise<{ items: T[]; hasMore: boolean; nextCursor: string | null }>,
  opts?: { maxPages?: number },
): Promise<{ items: T[]; pages: number; truncated: boolean }> {
  const maxPages = opts?.maxPages ?? 5;
  const items: T[] = [];
  let cursor: string | null = null;
  let pages = 0;
  for (; pages < maxPages; pages += 1) {
    const page = await fetchPage(cursor);
    items.push(...page.items);
    if (!page.hasMore || page.nextCursor === null) {
      return { items, pages: pages + 1, truncated: false };
    }
    cursor = page.nextCursor;
  }
  return { items, pages, truncated: true };
}

// ---------------------------------------------------------------------------
// Reorg handling & finality
// ---------------------------------------------------------------------------

export interface ObservationAtHeight {
  blockProvenance: BlockProvenance;
}

/**
 * Reorg policy: an observation is FINAL only when its height is at least
 * finalityDepth blocks/slots behind the current provenance tip. Solana
 * observations must additionally be at "finalized" commitment.
 */
export class ReorgPolicy {
  constructor(
    private readonly chain: SupportedChain,
    private readonly depth: number = finalityDepth(chain),
  ) {}

  /** True when the observation's height is deep enough behind the tip. */
  isFinal(observation: ObservationAtHeight, tip: BlockProvenance): boolean {
    if (observation.blockProvenance.chainId !== tip.chainId) {
      throw new Error(
        `provenance chain mismatch: observation ${observation.blockProvenance.chainId} vs tip ${tip.chainId}`,
      );
    }
    const behind = tip.height - observation.blockProvenance.height;
    if (behind < this.depth) {
      return false;
    }
    if (this.chain.kind === "solana") {
      return (observation.blockProvenance.commitment ?? "finalized") === "finalized";
    }
    return true;
  }

  /** True when the observation might be affected by a reorg (not final). */
  mayReorg(observation: ObservationAtHeight, tip: BlockProvenance): boolean {
    return !this.isFinal(observation, tip);
  }
}

/** Default commitment policy for report-grade reads. */
export const REPORT_COMMITMENT: SolanaCommitmentLevel = "finalized";

export function requireFinalCommitment(chain: SupportedChain, commitment: SolanaCommitmentLevel | undefined): SolanaCommitmentLevel {
  if (chain.kind !== "solana") {
    return commitment ?? "finalized";
  }
  if (commitment && commitment !== "finalized") {
    throw new Error(
      `report-grade reads require 'finalized' commitment, got '${commitment}'; ` +
        "downgrade the read explicitly if you really need softer data",
    );
  }
  return "finalized";
}

// ---------------------------------------------------------------------------
// Duplicate event handling
// ---------------------------------------------------------------------------

export interface DedupeKey {
  chainId: string;
  txId: string;
  eventIndex: number;
}

/** Bounded seen-event set: duplicates are skipped, memory is capped. */
export class DedupeBuffer {
  private readonly seen = new Set<string>();
  private readonly order: string[] = [];

  constructor(readonly capacity = 10_000) {}

  private static keyOf(key: DedupeKey): string {
    return `${key.chainId}:${key.txId}:${key.eventIndex}`;
  }

  /** Returns true when the event is NEW (first sighting). */
  add(key: DedupeKey): boolean {
    const composite = DedupeBuffer.keyOf(key);
    if (this.seen.has(composite)) {
      return false;
    }
    this.seen.add(composite);
    this.order.push(composite);
    if (this.order.length > this.capacity) {
      const evicted = this.order.shift();
      if (evicted !== undefined) {
        this.seen.delete(evicted);
      }
    }
    return true;
  }

  has(key: DedupeKey): boolean {
    return this.seen.has(DedupeBuffer.keyOf(key));
  }

  get size(): number {
    return this.seen.size;
  }
}

/** Filter a page of events down to first-sightings only (in place order). */
export function dedupeEvents(buffer: DedupeBuffer, chainId: string, events: { txId: string; eventIndex: number }[]): { txId: string; eventIndex: number }[] {
  return events.filter((event) => buffer.add({ chainId, txId: event.txId, eventIndex: event.eventIndex }));
}
