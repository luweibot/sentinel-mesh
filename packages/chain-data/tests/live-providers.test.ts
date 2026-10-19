import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GeckoTrendingDiscoveryProvider, DexScreenerLiquidityProvider, RpcMetadataProvider, buildProviders } from "../src/live-providers.js";
import { fixtureProviders } from "../src/fixtures.js";
import { getChain } from "../src/registry.js";
import type { Paginated } from "../src/providers.js";

/**
 * Live provider tests: mock global fetch; no network.
 * Covers: mapping correctness, honest source labels, fixture fallback.
 */

const GECKO_TRENDING = {
  data: [
    {
      id: "0xpool1_base_eth",
      attributes: { base_token_symbol: "DOGE", reserve_in_usd: "123456.78" },
      relationships: { base_token: { data: { id: "0x1111111111111111111111111111111111111111" } } },
    },
    {
      id: "0xpool2_usdc_eth",
      attributes: { base_token_symbol: "PEPE", reserve_in_usd: "999" },
      relationships: { base_token: { data: { id: "0x2222222222222222222222222222222222222222" } } },
    },
  ],
  links: { next: "https://api.geckoterminal.com/api/v2/networks/base/trending_pools?page=2" },
};

const DEX_PAIRS = {
  pairs: [
    {
      chainId: "base",
      dexId: "uniswap",
      pairAddress: "0xpair1",
      baseToken: { address: "0x1111111111111111111111111111111111111111", name: "Doge", symbol: "DOGE" },
      quoteToken: { address: "0x833589fcd6edb6e08f4c2c6ff80ffe7fd34502b0", name: "USDC", symbol: "USDC" },
      priceUsd: "0.1234",
      liquidity: { usd: 50_000, base: 200_000, quote: 25_000 },
      volume: { h24: 120_000 },
      priceChange: { h1: 0.5, h6: -1.2, h24: 3.4 },
      txns: { h24: { buys: 800, sells: 400 } },
      pairCreatedAt: Date.now() - 3_600_000 * 5,
    },
  ],
};

const BLOCK_RESULT = { number: "0x1312d00", hash: "0xabc123", timestamp: "0x67000000" };

const hexStr = (value: string) => {
  const buf = Buffer.from(value, "utf8");
  const len = buf.length.toString(16).padStart(64, "0");
  const padded = buf.toString("hex").padEnd(Math.ceil(buf.length / 32) * 64, "0");
  return "0x" + "0".repeat(64) + len + padded;
};

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GeckoTrendingDiscoveryProvider", () => {
  it("maps trending pools to discovered tokens and labels live", async () => {
    fetchMock.mockResolvedValueOnce(ok(GECKO_TRENDING));
    const provider = new GeckoTrendingDiscoveryProvider();
    const result = await provider.discoverTokens(getChain("base"), { limit: 10 });
    expect(result.items).toHaveLength(2);
    expect(result.items[0]!.token.address).toBe("0x1111111111111111111111111111111111111111");
    expect(result.items[0]!.tvlUsd).toBeCloseTo(123456.78);
    expect(result.nextCursor).toBe("1");
    expect(provider.lastSource).toBe("live");
  });

  it("falls back to fixtures and labels honestly when upstream fails", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    const provider = new GeckoTrendingDiscoveryProvider();
    const result = await provider.discoverTokens(getChain("base"), { limit: 10 });
    expect(provider.lastSource).toBe("fixture-fallback");
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items[0]!.token.address).toMatch(/^0x/);
  });
});

describe("DexScreenerLiquidityProvider", () => {
  it("maps the best pair to a liquidity observation with live provenance", async () => {
    fetchMock.mockResolvedValueOnce(ok(DEX_PAIRS)); // dexscreener
    fetchMock.mockResolvedValueOnce(ok({ result: BLOCK_RESULT })); // eth_getBlockByNumber
    const provider = new DexScreenerLiquidityProvider();
    const result = await provider.getLiquidity(getChain("base"), {
      chainId: "base",
      address: "0x1111111111111111111111111111111111111111",
      symbol: "DOGE",
    });
    expect(provider.lastSource).toBe("live");
    expect(result.items[0]!.tvlUsd).toBe(50_000);
    expect(result.items[0]!.baseReserve).toBe("200000");
    expect(result.items[0]!.blockProvenance.height).toBe(Number(BLOCK_RESULT.number));
  });

  it("getPrice returns the highest-liquidity pair with rug context fields", async () => {
    fetchMock.mockResolvedValueOnce(ok(DEX_PAIRS));
    const provider = new DexScreenerLiquidityProvider();
    const { pair, source } = await provider.getPrice(getChain("base"), "0x1111111111111111111111111111111111111111");
    expect(source).toBe("live");
    expect(pair.priceUsd).toBe("0.1234");
    expect(pair.txns!.h24!.buys).toBe(800);
  });
});

describe("RpcMetadataProvider", () => {
  it("decodes ERC-20 metadata from eth_call results", async () => {
    fetchMock.mockResolvedValueOnce(ok({ result: hexStr("Dogecoin") })); // name
    fetchMock.mockResolvedValueOnce(ok({ result: hexStr("DOGE") })); // symbol
    fetchMock.mockResolvedValueOnce(ok({ result: "0x" + (18).toString(16).padStart(64, "0") })); // decimals
    fetchMock.mockResolvedValueOnce(ok({ result: BLOCK_RESULT })); // provenance
    const provider = new RpcMetadataProvider();
    const meta = await provider.getContractMetadata(getChain("base"), "0x1111111111111111111111111111111111111111");
    expect(provider.lastSource).toBe("live");
    expect(meta.name).toBe("Dogecoin");
    expect(meta.symbol).toBe("DOGE");
    expect(meta.decimals).toBe(18);
    expect(meta.standard).toBe("erc-20");
  });

  it("falls back to fixture metadata on RPC failure", async () => {
    fetchMock.mockRejectedValue(new Error("rpc down"));
    const provider = new RpcMetadataProvider();
    const meta = await provider.getContractMetadata(getChain("base"), "0x1111111111111111111111111111111111111111");
    expect(provider.lastSource).toBe("fixture-fallback");
    expect(meta.symbol).toMatch(/^FX/i);
  });
});

describe("buildProviders mode selection", () => {
  it("fixture mode returns the deterministic bundle", () => {
    const providers = buildProviders("fixture");
    expect(providers.discovery.name).toBe(fixtureProviders().discovery.name);
  });

  it("live mode returns the live bundle with a prices provider", () => {
    const providers = buildProviders("live");
    expect(providers.discovery.name).toBe("geckoterminal-trending");
    expect((providers as { prices?: unknown }).prices).toBeDefined();
  });
});

function ok(body: unknown): Response {
  return { ok: true, status: 200, json: () => Promise.resolve(body) } as unknown as Response;
}

// Type-only sanity: paginated shape is preserved end-to-end.
it("keeps the Paginated contract", async () => {
  fetchMock.mockResolvedValueOnce(ok(GECKO_TRENDING));
  const provider = new GeckoTrendingDiscoveryProvider();
  const result: Paginated<unknown> = await provider.discoverTokens(getChain("base"), {});
  expect(typeof result.hasMore).toBe("boolean");
});
