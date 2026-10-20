import { z } from "zod";
import { ChainId, IsoDateTime, Semver, Uuid } from "./primitives.js";

/**
 * Guarded execution contracts: trade intents, short-lived authorizations,
 * paper-trade receipts, and fail-closed rejection codes.
 *
 * PHASE STATUS: paper trading only. There is no live mode in these schemas:
 * receipts carry the literal `executionMode: "paper"`, and no schema field
 * can represent a broadcast transaction. Enabling live trading is a
 * production go-live decision with its own checklist (docs/EXECUTION.md),
 * not a config flip.
 */

export const EXECUTION_CONTRACT_VERSION = 1;

/** Every reason a guarded execution can fail CLOSED. */
export const RejectionCode = z.enum([
  "missing-authorization",
  "invalid-authorization",
  "expired-authorization",
  "revoked-authorization",
  "consumed-authorization",
  "intent-hash-mismatch",
  "chain-mismatch",
  "duplicate-submission-conflict",
  "policy-rejected",
  "policy-review-required",
  "policy-error",
  "user-limit-exceeded",
  "strategy-limit-exceeded",
  "position-cap-exceeded",
  "daily-loss-cap-exceeded",
  "exposure-cap-exceeded",
  "liquidity-insufficient",
  "fee-limit-exceeded",
  "slippage-limit-exceeded",
  "price-impact-exceeded",
  "adapter-validation-failed",
  "simulation-failed",
  "simulation-uncertain",
  "kill-switch-engaged",
  "kill-switch-unknown",
  "execution-disabled",
  "execution-unavailable",
  "execution-uncertain",
  "execution-reverted",
  "reconciliation-mismatch",
]);
export type RejectionCode = z.infer<typeof RejectionCode>;

/** Whole-number base-unit amounts, transported as strings (no floats). */
const RawAmount = z.string().regex(/^\d+$/, "must be a whole-number string in base units");

/**
 * The exact parameters an authorization binds to. The canonical hash of
 * THIS object is what an authorization carries; ANY divergence (amount,
 * tokens, chain, slippage bounds, fees, deadline, user, strategy) produces
 * a different hash and fails closed as intent-hash-mismatch.
 */
export const TradeIntent = z
  .object({
    schemaVersion: z.literal(EXECUTION_CONTRACT_VERSION),
    intentId: Uuid,
    userId: z.string().min(1),
    strategyId: z.string().min(1),
    chain: ChainId,
    tokenIn: z.string().min(1),
    tokenOut: z.string().min(1),
    /** Base units in, whole-number string. */
    amountInRaw: RawAmount,
    /** Minimum acceptable base units out (slippage lower bound). */
    minAmountOutRaw: RawAmount,
    /** Hard ceiling on total fee, in USD cents. */
    maxFeeUsdCents: z.number().int().positive(),
    /** Hard ceiling on accepted price impact, in basis points. */
    maxPriceImpactBps: z.number().int().min(1).max(10_000),
    /** Intent deadline; after this instant the intent is stale. */
    deadline: IsoDateTime,
  })
  .strict()
  .refine((intent) => intent.tokenIn !== intent.tokenOut, {
    message: "tokenIn and tokenOut must differ",
    path: ["tokenOut"],
  });
export type TradeIntent = z.infer<typeof TradeIntent>;

/** Canonical, order-stable serialization used for authorization binding. */
export function canonicalIntentJson(intent: TradeIntent): string {
  const parsed = TradeIntent.parse(intent);
  return JSON.stringify({
    schemaVersion: parsed.schemaVersion,
    intentId: parsed.intentId,
    userId: parsed.userId,
    strategyId: parsed.strategyId,
    chain: parsed.chain,
    tokenIn: parsed.tokenIn.toLowerCase(),
    tokenOut: parsed.tokenOut.toLowerCase(),
    amountInRaw: parsed.amountInRaw,
    minAmountOutRaw: parsed.minAmountOutRaw,
    maxFeeUsdCents: parsed.maxFeeUsdCents,
    maxPriceImpactBps: parsed.maxPriceImpactBps,
    deadline: parsed.deadline,
  });
}

export const AuthorizationStatus = z.enum(["active", "revoked", "consumed"]);
export type AuthorizationStatus = z.infer<typeof AuthorizationStatus>;

/**
 * Short-lived, exact-bound authorization for one intent.
 *  - bindsToHash is the canonical hash of the FULL intent; any alteration
 *    produces intent-hash-mismatch.
 *  - expiresAt is short-lived (issued with a small TTL); stale authorizations
 *    fail closed.
 *  - Single use: consuming marks it "consumed"; replays fail closed.
 */
export const TradeAuthorization = z
  .object({
    schemaVersion: z.literal(EXECUTION_CONTRACT_VERSION),
    authorizationId: Uuid,
    intentId: Uuid,
    /** sha256-style hex hash of canonicalIntentJson(intent). */
    bindsToHash: z.string().regex(/^[0-9a-f]{64}$/),
    chain: ChainId,
    approverId: z.string().min(1),
    issuedAt: IsoDateTime,
    expiresAt: IsoDateTime,
    status: AuthorizationStatus,
  })
  .strict();
export type TradeAuthorization = z.infer<typeof TradeAuthorization>;

export const ReceiptStatus = z.enum(["paper-filled", "live-filled", "rejected"]);
export type ReceiptStatus = z.infer<typeof ReceiptStatus>;

/**
 * Execution receipt: a paper trade receipt (executionMode "paper",
 * paperTxHash mock artifact) or a LIVE trade receipt (executionMode
 * "live", txHash is a real onchain transaction hash).
 */
export const ExecutionReceipt = z
  .object({
    schemaVersion: z.literal(EXECUTION_CONTRACT_VERSION),
    receiptId: Uuid,
    intentId: Uuid,
    authorizationId: Uuid.nullable(),
    status: ReceiptStatus,
    executionMode: z.enum(["paper", "live"]),
    /** Set iff status is "rejected"; a typed fail-closed code. */
    rejectionCode: RejectionCode.optional(),
    rejectionDetail: z.string().optional(),
    /** Deterministic mock-signed paper artifact; never a real chain hash. */
    paperTxHash: z.string().min(1).optional(),
    /** Real onchain transaction hash; set iff executionMode is "live". */
    txHash: z.string().min(1).optional(),
    simulatedOutRaw: RawAmount.optional(),
    feeUsdCents: z.number().int().min(0).optional(),
    decidedAt: IsoDateTime,
    /** Version of the guard pipeline that produced this receipt. */
    guardPipelineVersion: Semver,
  })
  .strict();
export type ExecutionReceipt = z.infer<typeof ExecutionReceipt>;

/** Kill switch states; "unknown" is treated as ENGAGED (fail closed). */
export const KillSwitchState = z.enum(["clear", "engaged", "unknown"]);
export type KillSwitchState = z.infer<typeof KillSwitchState>;

/** Result of a reconciliation pass over the execution ledger. */
export const ReconciliationReport = z
  .object({
    ranAt: IsoDateTime,
    receiptsChecked: z.number().int().min(0),
    missingReceipts: z.array(Uuid),
    duplicateReceipts: z.array(Uuid),
    mismatches: z.array(
      z
        .object({
          intentId: Uuid,
          problem: z.string().min(1),
        })
        .strict(),
    ),
    consistent: z.boolean(),
  })
  .strict();
export type ReconciliationReport = z.infer<typeof ReconciliationReport>;
