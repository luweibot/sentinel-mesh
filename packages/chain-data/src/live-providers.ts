import { FixtureDiscoveryProvider, fixtureProviders } from "./fixtures.js";
import {
  type BlockProvenance,
  type ChainDataProviders,
  type ContractMetadata,
  type DiscoveredToken,
  type FeeEstimate,
  type LiquidityObservation,
  type Paginated,
  RpcError,
  type WalletActivityEvent,
} from "./providers.js";
import type { SupportedChain } from "./registry.js";
import { type TokenIdentity } from "./token-identity.js";
import { evmToken, solanaToken } from "./token-identity.js";

/**
 * LIVE read-only data providers: free public sources, no API keys.
 *
 *  - Trending discovery: GeckoTerminal v2 public API (free, ~30 req/min)
 *  - Liquidity + price: DexScreener public API (free, no key)
 *  - Metadata / fees / provenance / activity: public EVM JSON-RPC
 *    (Base https://mainnet.base.org, Ethereum https://eth.llamarpc.com)
 *
 * Fail-closed semantics per call: if a live upstream fails, the provider
 * falls back to the deterministic fixture and records
 * `lastSource = "fixture-fallback"`. Callers surface that label so no
 * consumer mistakes fixture data for live data.
 */

export type DataSourceLabel = "live" | "fixture-fallback";

const GECKO_NETWORK: Record<string, string> = {
  base: "base",
  ethereum: "eth",
  "solana-mainnet": "solana",
};

const EVM_RPC: Record<string, string> = {
  base: "https://mainnet.base.org",
  ethereum: "https://eth.llamarpc.com",
};

const SOLANA_RPC = "https://api.mainnet-beta.solana.com";

/** Reference tokens used to price gas/compute estimates (canonical wrapped natives). */
const NATIVE_PRICE_TOKEN: Record<string, string> = {
  base: "0x4200000000000000000000000000000000000006", // WETH on Base
  ethereum: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", // WETH mainnet
  "solana-mainnet": "So11111111111111111111111111111111111111112", // wrapped SOL
};

async function httpJson(url: string, init?: RequestInit, timeoutMs = 10_000): Promise<unknown> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json", ...(init?.headers ?? {}) } });
  if (res.status === 429) throw new RpcError("http-429", `rate limited by ${url}`);
  if (!res.ok) throw new RpcError("http-5xx", `upstream ${res.status} from ${url}`);
  return res.json();
}

async function rpcCall<T>(chain: SupportedChain, method: string, params: unknown[]): Promise<T> {
  const url = chain.kind === "evm" ? EVM_RPC[chain.id] : SOLANA_RPC;
  if (!url) throw new RpcError("connection-refused", `no live endpoint for chain ${chain.id}`);
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  const json = (await httpJson(url, { method: "POST", body, headers: { "content-type": "application/json" } })) as
    | { result?: T; error?: { message?: string } };
  if (json.error) throw new RpcError("bad-response", json.error.message ?? "rpc error");
  return json.result as T;
}

/** Fresh chain-tip provenance for an observation (reorg/freshness marker). */
async function evmProvenance(chain: SupportedChain): Promise<BlockProvenance> {
  const block = await rpcCall<{ number: string; hash: string; timestamp: string }>(chain, "eth_getBlockByNumber", ["latest", false]);
  return {
    chainId: chain.id,
    height: Number(BigInt(block.number)),
    hash: block.hash,
    timestamp: new Date(Number(BigInt(block.timestamp)) * 1_000).toISOString(),
  };
}

async function solanaProvenance(chain: SupportedChain, commitment?: string): Promise<BlockProvenance> {
  const [height, blockhash] = await Promise.all([
    rpcCall<number>(chain, "getBlockHeight", []),
    rpcCall<{ context: { slot: number }; value: { blockhash: string } }>(chain, "getLatestBlockhash", []),
  ]);
  return {
    chainId: chain.id,
    height,
    hash: blockhash.value.blockhash,
    timestamp: new Date().toISOString(),
    ...(commitment ? { commitment: commitment as BlockProvenance["commitment"] } : {}),
  };
}

// ---------------------------------------------------------------------------
// Trending discovery (GeckoTerminal)
// ---------------------------------------------------------------------------

export class GeckoTrendingDiscoveryProvider {
  readonly name = "geckoterminal-trending";
  lastSource: DataSourceLabel = "live";
  private readonly fixture = new FixtureDiscoveryProvider();

  constructor(
    private readonly geckoBase = "https://api.geckoterminal.com/api/v2",
    private readonly now: () => Date = () => new Date(),
  ) {}

  async discoverTokens(chain: SupportedChain, query: { symbolHint?: string; limit?: number; cursor?: string | null }): Promise<Paginated<DiscoveredToken>> {
    try {
      const network = GECKO_NETWORK[chain.id];
      if (!network) throw new RpcError("connection-refused", `no gecko network for chain ${chain.id}`);
      const page = query.cursor ? Number(query.cursor) + 1 : 1;
      const res = (await httpJson(`${this.geckoBase}/networks/${network}/trending_pools?page=${page}`)) as {
        data?: Array<{
          id: string;
          attributes: Record<string, unknown>;
          relationships?: { base_token?: { data?: { id?: string } } };
        }>;
        links?: { next?: string | null };
      };
      const items: DiscoveredToken[] = [];
      const seen = new Set<string>();
      const limit = query.limit ?? 10;
      for (const pool of res.data ?? []) {
        const address = pool.relationships?.base_token?.data?.id;
        const attrs = pool.attributes ?? {};
        if (!address || seen.has(address) || !/^(0x|so|So|EP|CA)/i.test(address)) continue;
        seen.add(address);
        items.push({
          token: chain.kind === "evm" ? evmToken(chain, address) : solanaToken(chain, address),
          poolAddress: pool.id,
          tvlUsd: Number(attrs.reserve_in_usd ?? 0) || 0,
          observedAt: this.now().toISOString(),
        });
        if (items.length >= limit) break;
      }
      const hasMore = Boolean(res.links?.next);
      this.lastSource = "live";
      return { items, hasMore, nextCursor: hasMore ? String(page) : null };
    } catch {
      this.lastSource = "fixture-fallback";
      return this.fixture.discoverTokens(chain, query);
    }
  }
}

// ---------------------------------------------------------------------------
// Liquidity + prices (DexScreener)
// ---------------------------------------------------------------------------

interface DexPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; name: string; symbol: string };
  priceUsd?: string;
  liquidity?: { usd?: number; base?: number; quote?: number };
  volume?: { h24?: number };
  priceChange?: { h1?: number; h6?: number; h24?: number };
  txns?: Record<string, { buys?: number; sells?: number }>;
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
}

export class DexScreenerLiquidityProvider {
  readonly name = "dexscreener";
  lastSource: DataSourceLabel = "live";

  constructor(private readonly now: () => Date = () => new Date()) {}

  async getLiquidity(chain: SupportedChain, token: TokenIdentity, opts?: { cursor?: string | null }): Promise<Paginated<LiquidityObservation>> {
    try {
      const res = (await httpJson(`https://api.dexscreener.com/latest/dex/tokens/${token.address}`)) as { pairs?: DexPair[] };
      const pairs = (res.pairs ?? []).filter((p) => GECKO_NETWORK[chain.id] === p.chainId || chain.id === "solana-mainnet" && p.chainId === "solana");
      const provenance = chain.kind === "evm" ? await evmProvenance(chain) : await solanaProvenance(chain);
      const items: LiquidityObservation[] = pairs.slice(0, 10).map((pair) => ({
        poolAddress: pair.pairAddress,
        poolKind: "other",
        quoteToken: pair.quoteToken.address,
        baseReserve: String(pair.liquidity?.base ?? 0),
        quoteReserve: String(pair.liquidity?.quote ?? 0),
        tvlUsd: Number(pair.liquidity?.usd ?? 0) || 0,
        blockProvenance: provenance,
        observedAt: this.now().toISOString(),
      }));
      this.lastSource = "live";
      return { items, hasMore: (res.pairs?.length ?? 0) > 10, nextCursor: opts?.cursor ?? null };
    } catch {
      this.lastSource = "fixture-fallback";
      return fixtureProviders().liquidity.getLiquidity(chain, token, opts);
    }
  }

  /** Price snapshot used by the paid price-check route (not part of ChainDataProviders). */
  async getPrice(chain: SupportedChain, address: string): Promise<{ pair: DexPair; source: DataSourceLabel }> {
    try {
      const res = (await httpJson(`https://api.dexscreener.com/latest/dex/tokens/${address}`)) as { pairs?: DexPair[] };
      const pairs = (res.pairs ?? []).filter((p) => (chain.id === "solana-mainnet" ? p.chainId === "solana" : p.chainId === chain.id));
      const best = [...pairs].sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
      if (!best) throw new RpcError("bad-response", `no dex pair for ${address} on ${chain.id}`);
      this.lastSource = "live";
      return { pair: best, source: "live" };
    } catch {
      this.lastSource = "fixture-fallback";
      throw new RpcError("bad-response", `no live price available for ${address}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Metadata (public EVM RPC; Solana falls back to fixture)
// ---------------------------------------------------------------------------

const ERC20_ABI = {
  name: "0x06fdde03" as const,
  symbol: "0x95d89b41" as const,
  decimals: "0x313ce567" as const,
};

function decodeString(result: string): string {
  const hex = result.slice(130); // skip 32-byte offset word + 32-byte length word (2*64 hex chars + 0x)
  return hex ? Buffer.from(hex, "hex").toString("utf8").replace(/\0/g, "").trim() : "";
}

export class RpcMetadataProvider {
  readonly name = "evm-rpc-metadata";
  lastSource: DataSourceLabel = "live";

  constructor(private readonly now: () => Date = () => new Date()) {}

  async getContractMetadata(chain: SupportedChain, address: string): Promise<ContractMetadata> {
    try {
      if (chain.kind !== "evm") throw new RpcError("bad-response", "live metadata is EVM-only; solana falls back to fixture");
      const call = (data: string) => rpcCall<string>(chain, "eth_call", [{ to: address, data }, "latest"]);
      const [name, symbol, decimalsHex, provenance] = await Promise.all([
        call(ERC20_ABI.name),
        call(ERC20_ABI.symbol),
        call(ERC20_ABI.decimals),
        evmProvenance(chain),
      ]);
      const decimals = Number(BigInt(decimalsHex || "0x0"));
      this.lastSource = "live";
      return {
        address,
        name: decodeString(name) || "unknown",
        symbol: decodeString(symbol) || "unknown",
        decimals: Number.isFinite(decimals) ? Math.min(decimals, 36) : 0,
        standard: "erc-20",
        blockProvenance: provenance,
        observedAt: this.now().toISOString(),
      };
    } catch {
      this.lastSource = "fixture-fallback";
      return fixtureProviders().metadata.getContractMetadata(chain, address);
    }
  }
}

// ---------------------------------------------------------------------------
// Fees (public RPC gas prices; USD via DexScreener native price)
// ---------------------------------------------------------------------------

export class RpcFeeProvider {
  readonly name = "rpc-fees";
  lastSource: DataSourceLabel = "live";

  constructor(
    private readonly dex: DexScreenerLiquidityProvider,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async estimateFee(chain: SupportedChain, opts?: { kind?: "transfer" | "swap"; commitment?: string }): Promise<FeeEstimate> {
    try {
      if (chain.kind === "evm") {
        const [gasPriceHex, provenance] = await Promise.all([
          rpcCall<string>(chain, "eth_gasPrice", []),
          evmProvenance(chain),
        ]);
        const gwei = Number(BigInt(gasPriceHex)) / 1e9;
        const units = opts?.kind === "swap" ? 150_000 : 21_000;
        const { pair } = await this.dex.getPrice(chain, NATIVE_PRICE_TOKEN[chain.id]!);
        const ethUsd = Number(pair.priceUsd ?? 0) || 0;
        const feeUsd = (units * gwei * 1e-9) * ethUsd;
        this.lastSource = "live";
        return { kind: "evm-gas", units, unitPrice: gwei, feeUsd, blockProvenance: provenance, observedAt: this.now().toISOString() };
      }
      // Solana: recent prioritization fees + static CU reference
      const fees = await rpcCall<Array<{ prioritizationFee: number }>>(chain, "getRecentPrioritizationFees", []);
      const priorityFee = fees?.length ? Math.max(...fees.map((f) => f.prioritizationFee)) : 0;
      const { pair } = await this.dex.getPrice(chain, NATIVE_PRICE_TOKEN[chain.id]!);
      const solUsd = Number(pair.priceUsd ?? 0) || 0;
      const units = 10_000;
      const feeUsd = (units * priorityFee * 1e-9) * solUsd;
      const provenance = await solanaProvenance(chain, opts?.commitment);
      this.lastSource = "live";
      return { kind: "solana-compute-units", units, unitPrice: priorityFee, feeUsd, blockProvenance: provenance, observedAt: this.now().toISOString() };
    } catch {
      this.lastSource = "fixture-fallback";
      return fixtureProviders().fees.estimateFee(chain, opts as never);
    }
  }
}

// ---------------------------------------------------------------------------
// Provenance (chain tip)
// ---------------------------------------------------------------------------

export class RpcProvenanceProvider {
  readonly name = "rpc-provenance";
  lastSource: DataSourceLabel = "live";

  async getProvenance(chain: SupportedChain, opts?: { commitment?: string }): Promise<BlockProvenance> {
    try {
      this.lastSource = "live";
      return chain.kind === "evm" ? await evmProvenance(chain) : await solanaProvenance(chain, opts?.commitment);
    } catch {
      this.lastSource = "fixture-fallback";
      return fixtureProviders().provenance.getProvenance(chain, opts as never);
    }
  }
}

// ---------------------------------------------------------------------------
// Wallet activity (EVM: ERC-20 Transfer logs; Solana: fixture fallback)
// ---------------------------------------------------------------------------

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export class RpcActivityProvider {
  readonly name = "evm-rpc-activity";
  lastSource: DataSourceLabel = "live";

  constructor(private readonly now: () => Date = () => new Date()) {}

  async getActivity(
    chain: SupportedChain,
    wallet: string,
    query: { fromHeight?: number; limit?: number; cursor?: string | null; commitment?: string },
  ): Promise<Paginated<WalletActivityEvent>> {
    try {
      if (chain.kind !== "evm") throw new RpcError("bad-response", "live activity is EVM-only; solana falls back to fixture");
      const latest = await rpcCall<string>(chain, "eth_blockNumber", []);
      const tip = Number(BigInt(latest));
      const span = chain.id === "base" ? 20_000 : 12_000;
      const fromBlock = query.fromHeight ?? Math.max(0, tip - span);
      const logs = await rpcCall<Array<{
        transactionHash: string; logIndex: string; blockNumber: string; data: string;
        topics: string[]; address: string;
      }>>(chain, "eth_getLogs", [{
        fromBlock: `0x${fromBlock.toString(16)}`,
        toBlock: "latest",
        topics: [TRANSFER_TOPIC, null, `0x${wallet.replace(/^0x/i, "").toLowerCase().padStart(64, "0")}`],
      }]);
      const events = logs.slice(0, query.limit ?? 50).map((log, i) => {
        const from = `0x${log.topics[1]!.slice(-40)}`;
        const to = `0x${log.topics[2]!.slice(-40)}`;
        return {
          txId: log.transactionHash,
          eventIndex: Number(BigInt(log.logIndex)),
          kind: to.toLowerCase() === wallet.toLowerCase() ? ("transfer-in" as const) : ("transfer-out" as const),
          tokenAddress: log.address,
          counterparty: to.toLowerCase() === wallet.toLowerCase() ? from : to,
          amountRaw: String(BigInt(log.data)),
          blockProvenance: {
            chainId: chain.id,
            height: Number(BigInt(log.blockNumber)),
            hash: `0x${Number(BigInt(log.blockNumber)).toString(16)}`,
            timestamp: this.now().toISOString(),
          },
          observedAt: this.now().toISOString(),
        };
      });
      this.lastSource = "live";
      return { items: events, hasMore: logs.length > (query.limit ?? 50), nextCursor: null };
    } catch {
      this.lastSource = "fixture-fallback";
      return fixtureProviders().activity.getActivity(chain, wallet, query as never);
    }
  }
}

// ---------------------------------------------------------------------------
// Bundle
// ---------------------------------------------------------------------------

/**
 * The live bundle: every provider falls back to fixtures per call and
 * reports its lastSource so routes can label responses honestly.
 */
export interface LiveProviderBundle extends ChainDataProviders {
  /** Price lookup used by the paid price-check route (rug/bull snapshot). */
  readonly prices: DexScreenerLiquidityProvider;
  /** Combined label after the most recent calls: "live" or "fixture-fallback". */
  combinedSource(): DataSourceLabel;
}

export function liveProviders(now: () => Date = () => new Date()): LiveProviderBundle {
  const discovery = new GeckoTrendingDiscoveryProvider(undefined, now);
  const liquidity = new DexScreenerLiquidityProvider(now);
  const metadata = new RpcMetadataProvider(now);
  const fees = new RpcFeeProvider(liquidity, now);
  const provenance = new RpcProvenanceProvider();
  const activity = new RpcActivityProvider(now);
  const all = [discovery, liquidity, metadata, fees, provenance, activity];
  return {
    discovery,
    liquidity,
    metadata,
    fees,
    provenance,
    activity,
    prices: liquidity,
    combinedSource(): DataSourceLabel {
      return all.some((p) => p.lastSource === "live") && all.every((p) => p.lastSource !== "fixture-fallback") ? "live" : "fixture-fallback";
    },
  };
}

/**
 * Select providers by config mode. "fixture" (default) keeps the
 * deterministic bundle; "live" uses public free sources with fixture
 * fallback per call.
 */
export function buildProviders(mode: "live" | "fixture", now: () => Date = () => new Date()): ChainDataProviders {
  return mode === "live" ? liveProviders(now) : fixtureProviders();
}
