import { z } from "zod";
import { EvmAddress, IsoDateTime, Uuid } from "./primitives.js";

/**
 * x402 (HTTP 402) payment contracts.
 *
 * PROTOCOL ASSUMPTIONS (documented in docs/X402.md):
 *  - x402 v1 only: responses must carry `X-PAYMENTS-Version: 1`.
 *  - Only the documented `exactInEvm` scheme is supported (EIP-3009
 *    transferWithAuthorization on EVM chains). Solana variants are NOT
 *    implemented and are rejected.
 *  - Settlement evidence is only accepted from explicitly allowlisted
 *    facilitator adapters. No live facilitator ships in this phase; tests
 *    use deterministic mock fixtures. No API keys exist in the codebase.
 */

export const X402_VERSION_HEADER = "X-PAYMENTS-Version";
export const SUPPORTED_X402_VERSION = "1";
export const SUPPORTED_X402_SCHEMES = ["exactInEvm"] as const;

/** EVM chain ids recognized by x402 and mapped to registry chains. */
export const X402_CHAIN_IDS: Record<number, string> = {
  8453: "base",
  1: "ethereum",
};

export const X402PaymentRequirement = z
  .object({
    scheme: z.enum(SUPPORTED_X402_SCHEMES),
    /** EVM chain id (numeric per x402 v1). */
    network: z.number().int().positive(),
    /** Payment asset contract address (e.g. USDC). */
    asset: EvmAddress,
    /** Exact amount in atomic units, as a decimal string (bigint-safe). */
    maxAmountRequired: z.string().regex(/^\d+$/),
    payTo: EvmAddress,
    /** Seconds the payment must settle within. */
    maxTimeoutSeconds: z.number().int().min(1).max(3_600),
    mimeType: z.string().min(1),
    outputSchema: z.string().optional(),
    extra: z.object({ name: z.string().optional(), version: z.string().optional(), description: z.string().optional() }).optional(),
  })
  .strict();
export type X402PaymentRequirement = z.infer<typeof X402PaymentRequirement>;

/** EIP-3009 transferWithAuthorization payload (x402 exactInEvm payment). */
export const X402PaymentPayload = z
  .object({
    x402Version: z.literal("1"),
    scheme: z.enum(SUPPORTED_X402_SCHEMES),
    payload: z
      .object({
        /** Payer EOA. */
        from: EvmAddress,
        to: EvmAddress,
        /** Exact amount in atomic units (must equal the requirement). */
        value: z.string().regex(/^\d+$/),
        /** EIP-3009 nonce: a bytes32 hex value (real x402 clients) or a UUID (paper fixtures). MUST be globally unique per payer. */
        nonce: z.union([z.string().regex(/^0x[0-9a-fA-F]{64}$/), Uuid]),
        validAfter: IsoDateTime,
        validBefore: IsoDateTime,
        signature: z.string().min(1),
      })
      .strict(),
  })
  .strict();
export type X402PaymentPayload = z.infer<typeof X402PaymentPayload>;

/** Settlement evidence returned by a facilitator after verification. */
export const X402Settlement = z
  .object({
    scheme: z.enum(SUPPORTED_X402_SCHEMES),
    network: z.number().int().positive(),
    payload: z
      .object({
        success: z.boolean(),
        transactionHash: z.string().min(1).optional(),
        error: z.object({ code: z.string(), message: z.string() }).optional(),
      })
      .strict(),
    /** Which allowlisted facilitator produced this evidence. */
    facilitatorId: z.string().min(1),
    settledAt: IsoDateTime,
  })
  .strict();
export type X402Settlement = z.infer<typeof X402Settlement>;

export const PaymentRecordStatus = z.enum(["recorded", "settled", "rejected"]);
export type PaymentRecordStatus = z.infer<typeof PaymentRecordStatus>;

export const PAYMENT_REJECTION_CODES = [
  "unsupported-x402-version",
  "unsupported-scheme",
  "unsupported-chain",
  "asset-not-allowed",
  "recipient-not-allowed",
  "amount-mismatch",
  "invalid-amount",
  "requirement-expired",
  "payment-window-invalid",
  "spend-cap-exceeded",
  "payment-replay",
  "settlement-invalid",
  "settlement-facilitator-not-allowed",
  "invalid-signature",
  "settlement-unconfirmed",
  "settlement-mismatch",
  "facilitator-error",
] as const;
export type PaymentRejectionCode = (typeof PAYMENT_REJECTION_CODES)[number];

/**
 * A payment record. NOTE: a settled payment grants CONTENT ACCESS only.
 * `grants.trading` is the literal false and there is NO path from a
 * payment to a trade authorization — enforced by the guard and by tests.
 */
export const PaymentRecord = z
  .object({
    paymentId: Uuid,
    agentId: z.string().min(1),
    requirementHash: z.string().min(1),
    chain: z.string().min(1),
    asset: EvmAddress,
    payTo: EvmAddress,
    /** Atomic units. */
    amount: z.string().regex(/^\d+$/),
    status: PaymentRecordStatus,
    rejectionCode: z.enum(PAYMENT_REJECTION_CODES).optional(),
    nonce: z.union([z.string().regex(/^0x[0-9a-fA-F]{64}$/), Uuid]),
    /** Payer EOA — required to confirm settlement on-chain. */
    payer: EvmAddress.optional(),
    facilitatorId: z.string().optional(),
    transactionHash: z.string().optional(),
    grants: z.object({ contentAccess: z.boolean(), trading: z.literal(false) }).strict(),
    recordedAt: IsoDateTime,
    settledAt: IsoDateTime.optional(),
  })
  .strict();
export type PaymentRecord = z.infer<typeof PaymentRecord>;

export const PaymentGuardVerdict = z
  .object({
    ok: z.boolean(),
    code: z.enum(PAYMENT_REJECTION_CODES).optional(),
    message: z.string().optional(),
    record: PaymentRecord.optional(),
  })
  .strict();
export type PaymentGuardVerdict = z.infer<typeof PaymentGuardVerdict>;

/** Allowlist entry for a payment asset. */
export const AssetAllowlistEntry = z
  .object({
    chain: z.string().min(1),
    address: EvmAddress,
    symbol: z.string().min(1),
    decimals: z.number().int().min(0).max(36),
  })
  .strict();
export type AssetAllowlistEntry = z.infer<typeof AssetAllowlistEntry>;

/** Allowlist entry for a payment recipient. */
export const RecipientAllowlistEntry = z
  .object({
    address: EvmAddress,
    label: z.string().min(1),
  })
  .strict();
export type RecipientAllowlistEntry = z.infer<typeof RecipientAllowlistEntry>;

export interface PaymentsReconcileReport {
  ranAt: string;
  recordsChecked: number;
  settledWithoutEvidence: string[];
  duplicateNonces: string[];
  consistent: boolean;
}

export const X402_FACILITATOR_FIXTURE_ID = "mock-facilitator";
