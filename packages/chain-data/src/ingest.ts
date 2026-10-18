import { randomUUID } from "node:crypto";
import {
  toEvidenceId,
  sanitizeUntrustedText,
  detectSuspiciousInstructions,
  type EvidenceItem as EvidenceItemType,
} from "@sentinel-mesh/contracts";
import type { SupportedChain } from "./registry.js";
import type {
  ContractMetadata,
  DiscoveredToken,
  FeeEstimate,
  LiquidityObservation,
  WalletActivityEvent,
  BlockProvenance,
} from "./providers.js";
import { finalityDepth } from "./registry.js";
import type { SourceFreshness } from "@sentinel-mesh/contracts";

/**
 * Ingestion: converts provider observations into evidence items.
 *
 * Every piece of external data enters the platform through these builders,
 * which enforce: evidence ids, provenance (provider + retrieval method),
 * observation timestamps, and UNTRUSTED text handling. Observed facts stay
 * numeric/structured wherever possible (numbers cannot carry instructions).
 */

export interface IngestContext {
  chain: SupportedChain;
  /** Provider name recorded in provenance, e.g. "fixture-liquidity". */
  providerName: string;
  retrievalMethod: "mock-fixture" | "api-fetch";
  providerRunId?: string;
}

function buildEvidence(
  ctx: IngestContext,
  fields: {
    kind: EvidenceItemType["kind"];
    summary: string;
    sourceName?: string;
    sourceUrl?: string;
    publishedAt?: string;
    fetchedAt: string;
    confidence: number;
    limitations: string[];
    flaggedSuspicious?: boolean;
  },
): EvidenceItemType {
  const summary = sanitizeUntrustedText(fields.summary);
  const suspicious = detectSuspiciousInstructions(summary);
  return {
    evidenceId: toEvidenceId(randomUUID()),
    kind: fields.kind,
    summary,
    sourceName: fields.sourceName,
    sourceUrl: fields.sourceUrl,
    publishedAt: fields.publishedAt ?? fields.fetchedAt,
    fetchedAt: fields.fetchedAt,
    provenance: {
      provider: ctx.providerName,
      retrievalMethod: ctx.retrievalMethod,
      providerRunId: ctx.providerRunId,
      retrievedBy: "chain-data-ingest",
    },
    confidence: fields.confidence,
    limitations: [...fields.limitations, ...(suspicious ? ["summary matched injection patterns; quarantined as untrusted text"] : [])],
    flaggedSuspicious: fields.flaggedSuspicious || suspicious,
  };
}

/** Contract metadata -> evidence. Numbers are kept as facts, name as untrusted text. */
export function ingestContractMetadata(ctx: IngestContext, metadata: ContractMetadata, fetchedAt: string): EvidenceItemType {
  return buildEvidence(ctx, {
    kind: "onchain-observation",
    summary: `Token contract ${metadata.address} (${metadata.standard}) reports symbol '${metadata.symbol}', ${metadata.decimals} decimals, name '${metadata.name}'.`,
    sourceName: ctx.providerName,
    publishedAt: metadata.blockProvenance.timestamp,
    fetchedAt,
    confidence: 0.9,
    limitations: [
      `observed at ${ctx.chain.kind === "evm" ? "block" : "slot"} ${metadata.blockProvenance.height}`,
      "contract metadata is self-reported by the contract itself; symbols and names are not verified identities",
    ],
  });
}

/** Liquidity observation -> evidence. */
export function ingestLiquidity(ctx: IngestContext, observation: LiquidityObservation, tokenAddress: string, fetchedAt: string): EvidenceItemType {
  return buildEvidence(ctx, {
    kind: "price-observation",
    summary: `Pool ${observation.poolAddress} (${observation.poolKind}) holds ${observation.baseReserve} base / ${observation.quoteReserve} quote; TVL estimate ${observation.tvlUsd.toFixed(2)} USD.`,
    sourceName: ctx.providerName,
    publishedAt: observation.blockProvenance.timestamp,
    fetchedAt,
    confidence: 0.7,
    limitations: [
      `observed at ${ctx.chain.kind === "evm" ? "block" : "slot"} ${observation.blockProvenance.height}`,
      "TVL is a provider estimate, not a guaranteed executable depth",
      "pool reserves are a snapshot and may be stale or reorged",
    ],
  });
  // tokenAddress is intentionally part of the caller's structured facts, not
  // of the untrusted summary text.
}

/** Wallet activity event -> evidence. */
export function ingestWalletActivity(ctx: IngestContext, event: WalletActivityEvent, wallet: string, fetchedAt: string): EvidenceItemType {
  const usdText = event.amountUsd !== undefined ? `, ~${event.amountUsd.toFixed(2)} USD` : "";
  return buildEvidence(ctx, {
    kind: "onchain-observation",
    summary: `Wallet ${wallet} ${event.kind.replace("-", " ")} ${event.amountRaw} of ${event.tokenAddress} with ${event.counterparty}${usdText}.`,
    sourceName: ctx.providerName,
    publishedAt: event.blockProvenance.timestamp,
    fetchedAt,
    confidence: event.amountUsd === undefined ? 0.6 : 0.75,
    limitations: [
      `observed at ${ctx.chain.kind === "evm" ? "block" : "slot"} ${event.blockProvenance.height}`,
      event.amountUsd === undefined ? "USD value unknown for this event" : "USD value is a provider estimate",
      "event classification (transfer-in/out/swap-like) is heuristic",
    ],
  });
}

/** Fee estimate -> evidence. */
export function ingestFeeEstimate(ctx: IngestContext, estimate: FeeEstimate, fetchedAt: string): EvidenceItemType {
  return buildEvidence(ctx, {
    kind: "onchain-observation",
    summary: `Estimated fee: ${estimate.units} ${estimate.kind === "evm-gas" ? "gas units" : "compute units"} at ${estimate.unitPrice} per unit; total estimate ${estimate.feeUsd.toFixed(4)} USD.`,
    sourceName: ctx.providerName,
    publishedAt: estimate.blockProvenance.timestamp,
    fetchedAt,
    confidence: 0.8,
    limitations: [
      "fee estimates are advisory; actual costs depend on execution-time market conditions",
      "USD conversion uses the provider's reference price",
    ],
  });
}

/** Discovered token -> evidence. */
export function ingestDiscoveredToken(ctx: IngestContext, discovered: DiscoveredToken, fetchedAt: string): EvidenceItemType {
  return buildEvidence(ctx, {
    kind: "research-note",
    summary: `Discovered token ${discovered.token.address} on chain ${discovered.token.chainId}${discovered.tvlUsd !== undefined ? ` with pool TVL estimate ${discovered.tvlUsd.toFixed(2)} USD` : ""}.`,
    sourceName: ctx.providerName,
    publishedAt: discovered.observedAt,
    fetchedAt,
    confidence: 0.5,
    limitations: [
      "discovery results are candidates, not endorsements",
      "ticker symbols in discovery output are display metadata and never identity",
    ],
  });
}

/**
 * Source freshness: flags staleness against the chain's target block/slot
 * time and the observation's distance from the provenance tip.
 */
export function computeFreshness(
  source: string,
  observation: { blockProvenance: BlockProvenance },
  tip: BlockProvenance,
  chain: SupportedChain,
  ingestedAt: string,
): SourceFreshness {
  const expectedBlockTime = chain.kind === "evm" ? chain.targetBlockTimeSec : chain.targetSlotTimeSec;
  const depth = Math.max(0, tip.height - observation.blockProvenance.height);
  const lagSec = depth * expectedBlockTime;
  const declaredMaxLagSec = Math.max(1, expectedBlockTime * finalityDepth(chain));
  return {
    source,
    observedAt: observation.blockProvenance.timestamp,
    ingestedAt,
    stale: lagSec > declaredMaxLagSec,
    declaredMaxLagSec,
    note: `${depth} ${chain.kind === "evm" ? "blocks" : "slots"} behind the ${chain.kind === "solana" ? tip.commitment ?? "finalized" : "latest"} tip`,
  };
}
