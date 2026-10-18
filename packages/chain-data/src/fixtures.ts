import { createHash } from "node:crypto";
import type {
  BlockProvenance,
  ChainDataProviders,
  ContractMetadata,
  DiscoveredToken,
  FeeEstimate,
  LiquidityObservation,
  Paginated,
  WalletActivityEvent,
} from "./providers.js";
import type { TokenIdentity } from "./token-identity.js";
import type { SupportedChain } from "./registry.js";
import type { SolanaCommitmentLevel } from "./registry.js";
import { normalizeEvmAddress, normalizeSolanaAddress } from "./token-identity.js";

/**
 * Deterministic fixture providers implementing the full read-only surface.
 *
 * No network, no paid APIs. Every value is a pure function (sha256) of the
 * query, so tests are hermetic and reproducible. Solana fixture provenance
 * honors commitment levels: "processed" reads report a tip slot 2 slots
 * ahead of "finalized" reads, exercising the commitment handling path.
 */

const BASE_TIME = Date.parse("2026-01-10T00:00:00.000Z");

function sha(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

function pick(seed: string, modulo: number): number {
  return parseInt(sha(seed).slice(0, 8), 16) % modulo;
}

export class FixtureMetadataProvider {
  readonly name = "fixture-metadata";

  async getContractMetadata(chain: SupportedChain, address: string): Promise<ContractMetadata> {
    const normalized = chain.kind === "evm" ? normalizeEvmAddress(address) : normalizeSolanaAddress(address);
    const hash = sha(`${chain.id}:meta:${normalized}`);
    return {
      address: normalized,
      name: `Fixture Token ${hash.slice(0, 6)}`,
      symbol: `FX${hash.slice(6, 9).toUpperCase()}`,
      decimals: chain.kind === "evm" ? 18 : (pick(hash, 9) + 1),
      standard: chain.kind === "evm" ? "erc-20" : "spl",
      blockProvenance: {
        chainId: chain.id,
        height: fixtureHeight(chain, "finalized"),
        hash: `0x${sha(`${chain.id}:provenance`).slice(0, 40)}`,
        timestamp: new Date(BASE_TIME).toISOString(),
        ...(chain.kind === "solana" ? { commitment: "finalized" as const } : {}),
      },
      observedAt: new Date(BASE_TIME).toISOString(),
    };
  }
}

/** Fixture tip height per commitment level (Solana commitment semantics). */
export function fixtureHeight(chain: SupportedChain, commitment: SolanaCommitmentLevel | undefined): number {
  const base = chain.kind === "evm" ? 20_000_000 : 250_000_000;
  const offset =
    chain.kind === "solana"
      ? commitment === "processed"
        ? 2
        : commitment === "confirmed"
          ? 1
          : 0
      : 0;
  return base + offset;
}

export class FixtureDiscoveryProvider {
  readonly name = "fixture-discovery";

  async discoverTokens(chain: SupportedChain, query: { symbolHint?: string; limit?: number; cursor?: string | null }): Promise<Paginated<DiscoveredToken>> {
    const pageSize = Math.min(Math.max(query.limit ?? 3, 1), 5);
    const page = query.cursor ? Number(query.cursor) : 0;
    // Deliberately returns MULTIPLE tokens sharing a symbol: symbols are not identities.
    const symbol = query.symbolHint ?? "FX";
    const items: DiscoveredToken[] = [];
    for (let i = 0; i < pageSize; i += 1) {
      const index = page * pageSize + i;
      const address =
        chain.kind === "evm"
          ? `0x${sha(`${chain.id}:discover:${index}`).slice(0, 40)}`
          : sha(`${chain.id}:discover-sol:${index}`).slice(0, 44);
      items.push({
        token: {
          chainId: chain.id,
          address,
          symbol,
          name: `Fixture Token ${sha(`${chain.id}:discover:${index}`).slice(0, 6)}`,
          decimals: chain.kind === "evm" ? 18 : 6,
        },
        poolAddress: chain.kind === "evm" ? `0x${sha(`pool:${chain.id}:${index}`).slice(0, 40)}` : sha(`pool-sol:${index}`).slice(0, 44),
        tvlUsd: 10_000 + pick(`tvl:${index}`, 90_000),
        observedAt: new Date(BASE_TIME).toISOString(),
      });
    }
    const hasMore = page < 1; // two pages total, always
    return { items, hasMore, nextCursor: hasMore ? String(page + 1) : null };
  }
}

export class FixtureLiquidityProvider {
  readonly name = "fixture-liquidity";

  async getLiquidity(chain: SupportedChain, token: TokenIdentity, opts?: { cursor?: string | null }): Promise<Paginated<LiquidityObservation>> {
    const page = opts?.cursor ? Number(opts.cursor) : 0;
    const seed = sha(`${chain.id}:liq:${token.address}`);
    const items: LiquidityObservation[] = [
      {
        poolAddress: `0x${sha(`pool:${token.chainId}:${token.address}`).slice(0, 40)}`,
        poolKind: chain.kind === "evm" ? "v3-pool" : "clmm",
        quoteToken: chain.kind === "evm" ? "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" : "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        baseReserve: String(1_000 + pick(`${seed}:0`, 900_000)),
        quoteReserve: String(10_000 + pick(`${seed}:1`, 900_000)),
        tvlUsd: 5_000 + pick(`${seed}:2`, 95_000),
        blockProvenance: {
          chainId: chain.id,
          height: fixtureHeight(chain, "finalized"),
          hash: `0x${sha(`${chain.id}:provenance`).slice(0, 40)}`,
          timestamp: new Date(BASE_TIME).toISOString(),
          ...(chain.kind === "solana" ? { commitment: "finalized" as const } : {}),
        },
        observedAt: new Date(BASE_TIME).toISOString(),
      },
    ];
    const hasMore = page === 0 && pick(`${seed}:more`, 2) === 0;
    return { items, hasMore, nextCursor: hasMore ? String(page + 1) : null };
  }
}

export class FixtureActivityProvider {
  readonly name = "fixture-activity";

  async getActivity(
    chain: SupportedChain,
    wallet: string,
    query: { fromHeight?: number; limit?: number; cursor?: string | null; commitment?: SolanaCommitmentLevel },
  ): Promise<Paginated<WalletActivityEvent>> {
    const commitment = query.commitment ?? "finalized";
    const pageSize = Math.min(Math.max(query.limit ?? 4, 1), 10);
    const page = query.cursor ? Number(query.cursor) : 0;
    const items: WalletActivityEvent[] = [];
    for (let i = 0; i < pageSize; i += 1) {
      const index = page * pageSize + i;
      const seed = sha(`${chain.id}:activity:${wallet}:${index}`);
      const kind = pick(seed, 4) as 0 | 1 | 2 | 3;
      items.push({
        txId: chain.kind === "evm" ? `0x${seed.slice(0, 64)}` : seed.slice(0, 88),
        eventIndex: 0,
        kind: ["transfer-in", "transfer-out", "swap-like", "other"][kind] as WalletActivityEvent["kind"],
        tokenAddress: chain.kind === "evm" ? `0x${sha(`token:${index}`).slice(0, 40)}` : sha(`token-sol:${index}`).slice(0, 44),
        counterparty: chain.kind === "evm" ? `0x${sha(`party:${wallet}:${index}`).slice(0, 40)}` : sha(`party-sol:${wallet}:${index}`).slice(0, 44),
        amountRaw: String(1 + pick(seed, 10_000_000_000)),
        amountUsd: pick(seed, 100) > 60 ? 50_000 + pick(seed, 450_000) : undefined,
        blockProvenance: {
          chainId: chain.id,
          height: (query.fromHeight ?? fixtureHeight(chain, commitment)) + index,
          hash: `0x${sha(`block:${index}`).slice(0, 40)}`,
          timestamp: new Date(BASE_TIME + index * 1_000).toISOString(),
          ...(chain.kind === "solana" ? { commitment } : {}),
        },
        observedAt: new Date(BASE_TIME + index * 1_000).toISOString(),
      });
    }
    const hasMore = page < 2;
    return { items, hasMore, nextCursor: hasMore ? String(page + 1) : null };
  }
}

export class FixtureFeeProvider {
  readonly name = "fixture-fees";

  async estimateFee(chain: SupportedChain, opts?: { kind?: "transfer" | "swap"; commitment?: SolanaCommitmentLevel }): Promise<FeeEstimate> {
    const commitment = opts?.commitment ?? "finalized";
    const seed = sha(`${chain.id}:fee`);
    if (chain.kind === "evm") {
      const gasUnits = opts?.kind === "swap" ? 150_000 : 21_000;
      const baseFeeGwei = (5 + pick(seed, 30)) / 10;
      return {
        kind: "evm-gas",
        units: gasUnits,
        unitPrice: baseFeeGwei,
        feeUsd: Math.round(((gasUnits * baseFeeGwei * 1e-9) * 3_000) * 100) / 100,
        blockProvenance: {
          chainId: chain.id,
          height: fixtureHeight(chain, undefined),
          hash: `0x${sha(`${chain.id}:provenance`).slice(0, 40)}`,
          timestamp: new Date(BASE_TIME).toISOString(),
        },
        observedAt: new Date(BASE_TIME).toISOString(),
      };
    }
    const units = opts?.kind === "swap" ? 250_000 : 25_000;
    const lamportsPerCu = 1 + pick(seed, 5);
    return {
      kind: "solana-compute-units",
      units,
      unitPrice: lamportsPerCu,
      feeUsd: Math.round(units * lamportsPerCu * 5e-8 * 100) / 100,
      blockProvenance: {
        chainId: chain.id,
        height: fixtureHeight(chain, commitment),
        hash: sha(`${chain.id}:provenance`).slice(0, 44),
        timestamp: new Date(BASE_TIME).toISOString(),
        commitment,
      },
      observedAt: new Date(BASE_TIME).toISOString(),
    };
  }
}

export class FixtureProvenanceProvider {
  readonly name = "fixture-provenance";

  async getProvenance(chain: SupportedChain, opts?: { commitment?: SolanaCommitmentLevel }): Promise<BlockProvenance> {
    const commitment = opts?.commitment ?? (chain.kind === "solana" ? ("finalized" as const) : undefined);
    return {
      chainId: chain.id,
      height: fixtureHeight(chain, commitment),
      hash: `0x${sha(`${chain.id}:provenance`).slice(0, 40)}`,
      timestamp: new Date(BASE_TIME).toISOString(),
      ...(commitment ? { commitment } : {}),
    };
  }
}

/** The complete deterministic fixture bundle. */
export function fixtureProviders(): ChainDataProviders {
  return {
    metadata: new FixtureMetadataProvider(),
    discovery: new FixtureDiscoveryProvider(),
    liquidity: new FixtureLiquidityProvider(),
    activity: new FixtureActivityProvider(),
    fees: new FixtureFeeProvider(),
    provenance: new FixtureProvenanceProvider(),
  };
}
