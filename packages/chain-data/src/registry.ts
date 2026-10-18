import { z } from "zod";

/**
 * Chain registry: explicitly supported chains and clusters.
 *
 * Nothing in this package accepts a free-form chain name or id at runtime:
 * lookups go through `getChain`, which resolves ONLY registry entries.
 * Adding a chain means adding an entry here (plus adapters), never loosening
 * validation elsewhere.
 */

export const ChainKind = z.enum(["evm", "solana"]);
export type ChainKind = z.infer<typeof ChainKind>;

export const SolanaCommitmentLevel = z.enum(["processed", "confirmed", "finalized"]);
export type SolanaCommitmentLevel = z.infer<typeof SolanaCommitmentLevel>;

export interface EvmChainRecord {
  readonly kind: "evm";
  /** Canonical registry id, e.g. "base". */
  readonly id: string;
  readonly displayName: string;
  readonly chainId: number;
  /** Explorer base URL (advisory, for humans). */
  readonly explorerUrl: string;
  /** Blocks considered final at this depth (heuristic reorg window). */
  readonly reorgFinalityDepth: number;
  /** Seconds between blocks (used for freshness heuristics). */
  readonly targetBlockTimeSec: number;
}

export interface SolanaClusterRecord {
  readonly kind: "solana";
  readonly id: string;
  readonly displayName: string;
  /** Cluster name passed to RPC, e.g. "mainnet-beta". */
  readonly cluster: string;
  readonly explorerUrl: string;
  /** Slots considered final at this depth (heuristic fork window). */
  readonly slotFinalityDepth: number;
  readonly targetSlotTimeSec: number;
}

export type SupportedChain = EvmChainRecord | SolanaClusterRecord;

const EVM_CHAINS: readonly EvmChainRecord[] = [
  {
    kind: "evm",
    id: "base",
    displayName: "Base Mainnet",
    chainId: 8453,
    explorerUrl: "https://basescan.org",
    reorgFinalityDepth: 12,
    targetBlockTimeSec: 2,
  },
  {
    kind: "evm",
    id: "ethereum",
    displayName: "Ethereum Mainnet",
    chainId: 1,
    explorerUrl: "https://etherscan.io",
    reorgFinalityDepth: 12,
    targetBlockTimeSec: 12,
  },
];

const SOLANA_CLUSTERS: readonly SolanaClusterRecord[] = [
  {
    kind: "solana",
    id: "solana-mainnet",
    displayName: "Solana Mainnet Beta",
    cluster: "mainnet-beta",
    explorerUrl: "https://solscan.io",
    slotFinalityDepth: 32,
    targetSlotTimeSec: 1,
  },
  {
    kind: "solana",
    id: "solana-devnet",
    displayName: "Solana Devnet",
    cluster: "devnet",
    explorerUrl: "https://solscan.io",
    slotFinalityDepth: 32,
    targetSlotTimeSec: 1,
  },
];

const REGISTRY = new Map<string, SupportedChain>(
  [...EVM_CHAINS, ...SOLANA_CLUSTERS].map((chain) => [chain.id, chain]),
);

export function listChains(): readonly SupportedChain[] {
  return [...REGISTRY.values()];
}

/** Resolve a chain by registry id; unknown ids throw (no fallbacks). */
export function getChain(id: string): SupportedChain {
  const chain = REGISTRY.get(id);
  if (!chain) {
    throw new Error(
      `chain '${id}' is not in the supported registry; supported: ${[...REGISTRY.keys()].join(", ")}`,
    );
  }
  return chain;
}

export function isSupportedChainId(id: string): boolean {
  return REGISTRY.has(id);
}

/** Minimum blocks/slots an observation must be behind the tip to be final. */
export function finalityDepth(chain: SupportedChain): number {
  return chain.kind === "evm" ? chain.reorgFinalityDepth : chain.slotFinalityDepth;
}

export const ChainIdSchema = z.enum([
  "base",
  "ethereum",
  "solana-mainnet",
  "solana-devnet",
]);
export type ChainId = z.infer<typeof ChainIdSchema>;
