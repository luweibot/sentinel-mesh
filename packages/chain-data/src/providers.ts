import { z } from "zod";
import { SolanaCommitmentLevel, type SupportedChain } from "./registry.js";
import { TokenIdentity } from "./token-identity.js";

/**
 * Read-only provider interfaces for EVM and Solana data.
 *
 * Every method is a READ. There is deliberately no transaction, message, or
 * swap method anywhere in this file, and no provider implementation gets
 * signing capability. Implementations: deterministic fixtures (this package);
 * real RPC/HTTP clients are a later phase behind these same interfaces.
 *
 * Reliability conventions implemented by the resilience wrappers:
 *  - pagination: opaque cursors with hasMore (see drainPagination)
 *  - rate limits: token-bucket wrapper throws RateLimitError
 *  - RPC failures: providers throw RpcError with a classified code; the
 *    retry wrapper re-drives idempotent reads only
 *  - reorgs: block/slot provenance + finality depth policy
 *  - duplicate events: ingestion keys by (txHash|signature, logIndex|index)
 *  - Solana commitment: wallet/activity reads take a commitment level;
 *    finalized is the default for anything used in reports
 */

export const RpcErrorCode = z.enum([
  "connection-refused",
  "timeout",
  "http-429",
  "http-5xx",
  "bad-response",
  "parse-error",
  "reorg-detected",
]);
export type RpcErrorCode = z.infer<typeof RpcErrorCode>;

/** Classified RPC failure. Retriable codes are known to withRetry. */
export class RpcError extends Error {
  constructor(
    readonly code: RpcErrorCode,
    message: string,
    readonly retriable: boolean = code === "timeout" || code === "http-429" || code === "http-5xx" || code === "connection-refused",
  ) {
    super(message);
    this.name = "RpcError";
  }
}

/** Thrown by the rate-limit wrapper when the bucket is exhausted. */
export class RateLimitError extends Error {
  constructor(readonly retryInMs: number) {
    super(`provider rate limit exhausted; retry in ${retryInMs}ms`);
    this.name = "RateLimitError";
  }
}

// ---------------------------------------------------------------------------
// Shared observation shapes
// ---------------------------------------------------------------------------

export const BlockProvenance = z
  .object({
    chainId: z.string().min(1),
    /** EVM block height or Solana slot at observation time. */
    height: z.number().int().min(0),
    hash: z.string().min(1),
    timestamp: z.string(),
    /** Solana only: commitment this provenance was read at. */
    commitment: SolanaCommitmentLevel.optional(),
  })
  .strict();
export type BlockProvenance = z.infer<typeof BlockProvenance>;

export const Paginated = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    items: z.array(item),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
  }).strict();
export type Paginated<T> = { items: T[]; hasMore: boolean; nextCursor: string | null };

export const LiquidityObservation = z
  .object({
    /** Address pair identifying the pool (EVM pool contract / Solana pool id). */
    poolAddress: z.string().min(1),
    poolKind: z.enum(["v2-pool", "v3-pool", "clmm", "serum", "other"]),
    quoteToken: z.string().min(1),
    /** Raw reserve amounts as strings (bigint-safe transport). */
    baseReserve: z.string(),
    quoteReserve: z.string(),
    /** Heuristic USD TVL estimate supplied by the provider. */
    tvlUsd: z.number().min(0),
    blockProvenance: BlockProvenance,
    observedAt: z.string(),
  })
  .strict();
export type LiquidityObservation = z.infer<typeof LiquidityObservation>;

export const ContractMetadata = z
  .object({
    address: z.string().min(1),
    name: z.string(),
    symbol: z.string(),
    decimals: z.number().int().min(0).max(36),
    standard: z.enum(["erc-20", "erc-721", "erc-1155", "spl", "unknown"]),
    blockProvenance: BlockProvenance,
    observedAt: z.string(),
  })
  .strict();
export type ContractMetadata = z.infer<typeof ContractMetadata>;

export const WalletActivityEvent = z
  .object({
    /** tx hash (EVM) or signature (Solana). */
    txId: z.string().min(1),
    /** Log index (EVM) or inner instruction index (Solana); dedupe key part. */
    eventIndex: z.number().int().min(0),
    kind: z.enum(["transfer-in", "transfer-out", "swap-like", "other"]),
    /** Token identities involved, address-keyed. */
    tokenAddress: z.string().min(1),
    counterparty: z.string().min(1),
    amountRaw: z.string(),
    /** Positive USD estimate when computable; absent when unknown. */
    amountUsd: z.number().min(0).optional(),
    blockProvenance: BlockProvenance,
    observedAt: z.string(),
  })
  .strict();
export type WalletActivityEvent = z.infer<typeof WalletActivityEvent>;

export const FeeEstimate = z
  .object({
    kind: z.enum(["evm-gas", "solana-compute-units"]),
    /** EVM: gas units for the reference transfer; Solana: CUs. */
    units: z.number().int().min(0),
    /** EVM: base fee in gwei; Solana: priority fee in lamports per CU. */
    unitPrice: z.number().min(0),
    /** USD estimate using the provider's reference prices. */
    feeUsd: z.number().min(0),
    blockProvenance: BlockProvenance,
    observedAt: z.string(),
  })
  .strict();
export type FeeEstimate = z.infer<typeof FeeEstimate>;

export const DiscoveredToken = z
  .object({
    token: TokenIdentity,
    /** Pool context when the provider knows one; advisory. */
    poolAddress: z.string().min(1).optional(),
    tvlUsd: z.number().min(0).optional(),
    observedAt: z.string(),
  })
  .strict();
export type DiscoveredToken = z.infer<typeof DiscoveredToken>;

// ---------------------------------------------------------------------------
// Provider interfaces
// ---------------------------------------------------------------------------

/** Contract metadata ingestion (ERC-20 / SPL metadata reads). */
export interface TokenMetadataProvider {
  readonly name: string;
  getContractMetadata(chain: SupportedChain, address: string): Promise<ContractMetadata>;
}

/** Token discovery: candidate tokens; results are (chain, address) keyed. */
export interface TokenDiscoveryProvider {
  readonly name: string;
  discoverTokens(chain: SupportedChain, query: { symbolHint?: string; limit?: number; cursor?: string | null }): Promise<Paginated<DiscoveredToken>>;
}

/** Liquidity observations for a token's pools. */
export interface LiquidityProvider {
  readonly name: string;
  getLiquidity(chain: SupportedChain, token: TokenIdentity, opts?: { cursor?: string | null }): Promise<Paginated<LiquidityObservation>>;
}

/** Wallet activity ingestion with Solana commitment semantics. */
export interface WalletActivityProvider {
  readonly name: string;
  getActivity(
    chain: SupportedChain,
    wallet: string,
    query: { fromHeight?: number; limit?: number; cursor?: string | null; commitment?: SolanaCommitmentLevel },
  ): Promise<Paginated<WalletActivityEvent>>;
}

/** Transaction fee estimation (advisory estimates only; nothing executes). */
export interface FeeEstimationProvider {
  readonly name: string;
  estimateFee(chain: SupportedChain, opts?: { kind?: "transfer" | "swap"; commitment?: SolanaCommitmentLevel }): Promise<FeeEstimate>;
}

/** Block/slot provenance for freshness and reorg checks. */
export interface BlockProvenanceProvider {
  readonly name: string;
  getProvenance(chain: SupportedChain, opts?: { commitment?: SolanaCommitmentLevel }): Promise<BlockProvenance>;
}

/** The full read-only surface, one bundle per implementation. */
export interface ChainDataProviders {
  metadata: TokenMetadataProvider;
  discovery: TokenDiscoveryProvider;
  liquidity: LiquidityProvider;
  activity: WalletActivityProvider;
  fees: FeeEstimationProvider;
  provenance: BlockProvenanceProvider;
}
