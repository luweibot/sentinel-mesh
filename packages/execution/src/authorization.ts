import { randomUUID } from "node:crypto";
import {
  TradeAuthorization,
  canonicalIntentJson,
  type RejectionCode,
  type TradeIntent,
} from "@sentinel-mesh/contracts";
import { createHash } from "node:crypto";

/** Fail-closed error carrying a typed rejection code. */
export class ExecutionRejectedError extends Error {
  constructor(
    readonly code: RejectionCode,
    message: string,
  ) {
    super(message);
    this.name = "ExecutionRejectedError";
  }
}

export function intentHash(intent: TradeIntent): string {
  return createHash("sha256").update(canonicalIntentJson(intent)).digest("hex");
}

export interface Clock {
  now(): Date;
}

export interface AuthorizationStore {
  save(authorization: TradeAuthorization): Promise<void>;
  find(authorizationId: string): Promise<TradeAuthorization | undefined>;
}

export class InMemoryAuthorizationStore implements AuthorizationStore {
  private readonly map = new Map<string, TradeAuthorization>();

  async save(authorization: TradeAuthorization): Promise<void> {
    this.map.set(authorization.authorizationId, authorization);
  }

  async find(authorizationId: string): Promise<TradeAuthorization | undefined> {
    return this.map.get(authorizationId);
  }
}

/**
 * Authorization service: the ONLY component that mints and consumes
 * authorizations. An authorization is short-lived, bound to the exact
 * canonical hash of one intent, and single-use. Everything else fails
 * closed: missing, malformed, stale, revoked, consumed, or mismatched
 * bindings all throw ExecutionRejectedError with a specific code.
 */
export class AuthorizationService {
  /** Default TTL: 60 seconds. Authorizations are deliberately short-lived. */
  static readonly DEFAULT_TTL_MS = 60_000;

  constructor(
    private readonly store: AuthorizationStore,
    private readonly clock: Clock,
    private readonly ttlMs: number = AuthorizationService.DEFAULT_TTL_MS,
  ) {
    if (ttlMs <= 0) {
      throw new Error("authorization TTL must be positive");
    }
  }

  /** Mint a fresh authorization bound to the exact intent hash. */
  async issue(intent: TradeIntent, approverId: string): Promise<TradeAuthorization> {
    const issuedAt = this.clock.now();
    const authorization: TradeAuthorization = TradeAuthorization.parse({
      schemaVersion: 1,
      authorizationId: randomUUID(),
      intentId: intent.intentId,
      bindsToHash: intentHash(intent),
      chain: intent.chain,
      approverId,
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + this.ttlMs).toISOString(),
      status: "active",
    });
    await this.store.save(authorization);
    return authorization;
  }

  /** Revoke an authorization (before or after consumption attempts). */
  async revoke(authorizationId: string): Promise<void> {
    const record = await this.store.find(authorizationId);
    if (record && record.status === "active") {
      await this.store.save({ ...record, status: "revoked" });
    }
  }

  /**
   * CONSUME: verify an authorization against the intent it claims to
   * authorize, then mark it consumed. Every failure mode is a typed,
   * fail-closed rejection. On success the authorization is single-use
   * consumed, so replays fail with consumed-authorization.
   */
  async consume(
    authorization: TradeAuthorization | undefined,
    intent: TradeIntent,
  ): Promise<TradeAuthorization> {
    const parsed = this.safeParse(authorization);
    if (!parsed.success) {
      throw new ExecutionRejectedError("invalid-authorization", "authorization is missing or malformed");
    }
    const record = parsed.data;

    // The store is the source of truth for lifecycle state: a caller may
    // still hold a stale pre-revocation copy of the authorization.
    const stored = await this.store.find(record.authorizationId);
    if (!stored) {
      throw new ExecutionRejectedError("invalid-authorization", `authorization ${record.authorizationId} could not be verified against the authorization store`);
    }
    if (stored.status === "revoked" || record.status === "revoked") {
      throw new ExecutionRejectedError("revoked-authorization", `authorization ${record.authorizationId} was revoked`);
    }
    if (stored.status === "consumed" || record.status === "consumed") {
      throw new ExecutionRejectedError("consumed-authorization", `authorization ${record.authorizationId} was already used (replay)`);
    }
    if (record.intentId !== intent.intentId) {
      throw new ExecutionRejectedError("invalid-authorization", "authorization does not belong to this intent");
    }
    if (record.chain !== intent.chain) {
      throw new ExecutionRejectedError("chain-mismatch", `authorization is bound to chain '${record.chain}' but the intent targets '${intent.chain}'`);
    }
    const expectedHash = intentHash(intent);
    if (record.bindsToHash !== expectedHash) {
      throw new ExecutionRejectedError(
        "intent-hash-mismatch",
        "intent parameters do not exactly match the authorization binding (altered parameters)",
      );
    }
    if (this.clock.now().getTime() >= Date.parse(record.expiresAt)) {
      throw new ExecutionRejectedError("expired-authorization", `authorization expired at ${record.expiresAt}`);
    }

    // Fail closed if the store disagrees with the presented record.
    if (stored.status !== "active" || stored.bindsToHash !== expectedHash || stored.intentId !== record.intentId) {
      throw new ExecutionRejectedError("invalid-authorization", "authorization could not be verified against the authorization store");
    }
    const consumed: TradeAuthorization = { ...stored, status: "consumed" };
    await this.store.save(consumed);
    return consumed;
  }

  private safeParse(value: TradeAuthorization | undefined) {
    return TradeAuthorization.safeParse(value);
  }
}
