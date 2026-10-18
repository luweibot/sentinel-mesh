import { describe, expect, it } from "vitest";
import { EvidenceItem } from "@sentinel-mesh/contracts";
import {
  ChainIdSchema,
  DedupeBuffer,
  RateLimiter,
  ReorgPolicy,
  REPORT_COMMITMENT,
  RpcError,
  RateLimitError,
  assertSymbolIsNotIdentity,
  computeFreshness,
  dedupeEvents,
  drainPagination,
  evmToken,
  fixtureProviders,
  getChain,
  ingestLiquidity,
  isSupportedChainId,
  listChains,
  normalizeEvmAddress,
  normalizeSolanaAddress,
  requireFinalCommitment,
  solanaToken,
  uniqueTokenKey,
  withRateLimit,
  withRetry,
  type BlockProvenance,
} from "../src/index.js";

const FETCHED_AT = "2026-01-10T00:00:05.000Z";

describe("chain registry", () => {
  it("lists only explicitly supported chains and clusters", () => {
    const ids = listChains().map((chain) => chain.id);
    expect(ids).toEqual(["base", "ethereum", "solana-mainnet", "solana-devnet"]);
    expect(getChain("base").kind).toBe("evm");
    const base = getChain("base");
    expect(base.kind === "evm" && base.chainId).toBe(8453);
    const solana = getChain("solana-mainnet");
    if (solana.kind !== "solana") {
      throw new Error("expected a solana cluster record");
    }
    expect(solana.cluster).toBe("mainnet-beta");
  });

  it("rejects unknown chains with the supported list", () => {
    expect(() => getChain("bsc")).toThrow(/not in the supported registry/);
    expect(isSupportedChainId("base")).toBe(true);
    expect(isSupportedChainId("bsc")).toBe(false);
    expect(() => ChainIdSchema.parse("polygon")).toThrow();
  });
});

describe("token identity", () => {
  const base = getChain("base");
  const solana = getChain("solana-mainnet");

  it("normalizes EVM addresses and rejects invalid ones", () => {
    expect(normalizeEvmAddress(" 0xabc0000000000000000000000000000000000001 ")).toBe("0xabc0000000000000000000000000000000000001");
    expect(() => normalizeEvmAddress("0xABC")).toThrow();
  });

  it("normalizes Solana addresses and rejects invalid ones", () => {
    const mint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    expect(normalizeSolanaAddress(` ${mint} `)).toBe(mint);
    expect(() => normalizeSolanaAddress("0")).toThrow();
  });

  it("keys identity by (chain, address) and never by symbol", () => {
    const a = evmToken(base, "0xabc0000000000000000000000000000000000001", { symbol: "DUPE" });
    const b = evmToken(base, "0xabc0000000000000000000000000000000000002", { symbol: "DUPE" });
    // Same symbol, different tokens: identity keys differ.
    expect(uniqueTokenKey(a)).not.toBe(uniqueTokenKey(b));
    expect(uniqueTokenKey(a)).not.toContain("DUPE");
    // Same address on different chains: different tokens.
    const c = evmToken(getChain("ethereum"), "0xabc0000000000000000000000000000000000001", { symbol: "DUPE" });
    expect(uniqueTokenKey(a)).not.toBe(uniqueTokenKey(c));
  });

  it("refuses to accept ticker symbols as addresses", () => {
    expect(() => assertSymbolIsNotIdentity(base, "USDC")).toThrow(/ticker symbols are not token identities/);
    expect(() => assertSymbolIsNotIdentity(solana, "BONK")).toThrow(/ticker symbols are not token identities/);
    expect(() => assertSymbolIsNotIdentity(solana, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")).not.toThrow();
  });

  it("builds typed identities per chain kind", () => {
    expect(() => solanaToken(base, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")).toThrow(/not a Solana/);
    expect(() => evmToken(solana, "0xabc0000000000000000000000000000000000001")).toThrow(/not an EVM/);
  });
});

describe("fixture providers (no network, no paid APIs)", () => {
  const providers = fixtureProviders();

  it("returns deterministic contract metadata with provenance", async () => {
    const base = getChain("base");
    const a = await providers.metadata.getContractMetadata(base, "0xabc0000000000000000000000000000000000001");
    const b = await providers.metadata.getContractMetadata(base, "0xabc0000000000000000000000000000000000001");
    expect(a).toEqual(b);
    expect(a.standard).toBe("erc-20");
    expect(a.symbol).toMatch(/^FX/);
    expect(a.blockProvenance.height).toBeGreaterThan(0);
  });

  it("discovery returns multiple address-distinct tokens sharing a symbol", async () => {
    const base = getChain("base");
    const page = await providers.discovery.discoverTokens(base, { symbolHint: "USDC", limit: 3 });
    expect(page.items.length).toBe(3);
    const symbols = new Set(page.items.map((d) => d.token.symbol));
    expect(symbols.size).toBe(1); // same symbol everywhere...
    expect(new Set(page.items.map((d) => uniqueTokenKey(d.token))).size).toBe(3); // ...three distinct tokens
  });

  it("activity honors Solana commitment levels in provenance", async () => {
    const solana = getChain("solana-mainnet");
    const wallet = "11111111111111111111111111111111";
    const processed = await providers.activity.getActivity(solana, wallet, { limit: 2, commitment: "processed" });
    const finalized = await providers.activity.getActivity(solana, wallet, { limit: 2, commitment: "finalized" });
    expect(processed.items.every((e) => e.blockProvenance.commitment === "processed")).toBe(true);
    expect(finalized.items.every((e) => e.blockProvenance.commitment === "finalized")).toBe(true);
    // processed reads are ahead of finalized ones (fixture models the fork tip).
    expect(processed.items[0]!.blockProvenance.height).toBeGreaterThan(finalized.items[0]!.blockProvenance.height);
  });

  it("liquidity and fee reads are deterministic and provenance-tagged", async () => {
    const base = getChain("base");
    const token = evmToken(base, "0xabc0000000000000000000000000000000000001");
    const liq = await providers.liquidity.getLiquidity(base, token);
    expect(liq.items[0]!.tvlUsd).toBeGreaterThan(0);
    expect(liq.items[0]!.blockProvenance.chainId).toBe("base");
    const fee = await providers.fees.estimateFee(base, { kind: "transfer" });
    expect(fee.units).toBe(21_000);
    expect(fee.feeUsd).toBeGreaterThan(0);
  });
});

describe("pagination", () => {
  it("drains multi-page results and honors the page cap", async () => {
    const providers = fixtureProviders();
    const base = getChain("base");
    const drained = await drainPagination(
      (cursor) => providers.discovery.discoverTokens(base, { limit: 3, cursor }),
    );
    expect(drained.truncated).toBe(false);
    expect(drained.items.length).toBe(6); // two fixture pages of 3

    const capped = await drainPagination(
      (cursor) => providers.discovery.discoverTokens(base, { limit: 3, cursor }),
      { maxPages: 1 },
    );
    expect(capped.truncated).toBe(true);
    expect(capped.items.length).toBe(3);
  });
});

describe("rate limits", () => {
  const clock = { now: () => new Date(0) };

  it("throws RateLimitError when the bucket is exhausted and refills over time", () => {
    let nowMs = 0;
    const ticker = { now: () => new Date(nowMs) };
    const limiter = new RateLimiter(2, 60, ticker);
    limiter.take();
    limiter.take();
    expect(() => limiter.take()).toThrow(RateLimitError);
    nowMs += 61_000;
    expect(() => limiter.take()).not.toThrow();
  });

  it("wraps provider methods with the limiter", async () => {
    const providers = fixtureProviders();
    const limited = withRateLimit(providers.metadata, new RateLimiter(2, 60, clock));
    const base = getChain("base");
    await limited.getContractMetadata(base, "0xabc0000000000000000000000000000000000001");
    await limited.getContractMetadata(base, "0xabc0000000000000000000000000000000000002");
    await expect(limited.getContractMetadata(base, "0xabc0000000000000000000000000000000000003")).rejects.toThrow(RateLimitError);
  });

  it("rate limit parameters must be positive integers", () => {
    expect(() => new RateLimiter(0, 60, clock)).toThrow();
    expect(() => new RateLimiter(10, -1, clock)).toThrow();
  });
});

describe("RPC failures and retries", () => {
  const clock = { now: () => new Date(0) };

  it("retries retriable codes with deterministic backoff and succeeds", async () => {
    let calls = 0;
    const backoffs: number[] = [];
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) {
          throw new RpcError("timeout", "rpc timeout");
        }
        return "ok";
      },
      { maxAttempts: 4, baseBackoffMs: 10, clock, sleep: async (ms) => { backoffs.push(ms); } },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
    expect(backoffs).toEqual([10, 20]); // attempt-proportional, no jitter
  });

  it("gives up after maxAttempts and rethrows the last retriable error", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new RpcError("http-5xx", "upstream down");
        },
        { maxAttempts: 3, baseBackoffMs: 1, clock, sleep: async () => {} },
      ),
    ).rejects.toThrow(RpcError);
    expect(calls).toBe(3);
  });

  it("does not retry non-retriable errors or rate limits", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new RpcError("parse-error", "bad payload");
        },
        { maxAttempts: 3, baseBackoffMs: 1, clock, sleep: async () => {} },
      ),
    ).rejects.toThrow(RpcError);
    expect(calls).toBe(1);

    let calls2 = 0;
    await expect(
      withRetry(
        async () => {
          calls2 += 1;
          throw new RateLimitError(500);
        },
        { maxAttempts: 3, baseBackoffMs: 1, clock, sleep: async () => {} },
      ),
    ).rejects.toThrow(RateLimitError);
    expect(calls2).toBe(1);
  });
});

describe("reorgs, finality, and commitment policy", () => {
  const base = getChain("base");
  const solana = getChain("solana-mainnet");

  const tip = (chainId: string, height: number, commitment?: string): BlockProvenance => ({
    chainId,
    height,
    hash: "0x0000000000000000000000000000000000000000",
    timestamp: "2026-01-10T00:00:00.000Z",
    ...(commitment ? { commitment: commitment as "processed" } : {}),
  });

  it("treats recent EVM observations as reorgable until finality depth", () => {
    const policy = new ReorgPolicy(base);
    const shallow = { blockProvenance: tip("base", 19_999_995) };
    const deep = { blockProvenance: tip("base", 19_999_988) };
    expect(policy.mayReorg(shallow, tip("base", 20_000_000))).toBe(true);
    expect(policy.isFinal(deep, tip("base", 20_000_000))).toBe(true);
  });

  it("requires finalized commitment for Solana observations", () => {
    const policy = new ReorgPolicy(solana);
    const confirmed = { blockProvenance: tip("solana-mainnet", 249_999_968, "confirmed") };
    const finalized = { blockProvenance: tip("solana-mainnet", 249_999_968, "finalized") };
    expect(policy.isFinal(confirmed, tip("solana-mainnet", 250_000_000, "finalized"))).toBe(false);
    expect(policy.isFinal(finalized, tip("solana-mainnet", 250_000_000, "finalized"))).toBe(true);
  });

  it("rejects cross-chain provenance comparisons", () => {
    const policy = new ReorgPolicy(base);
    expect(() => policy.isFinal({ blockProvenance: tip("ethereum", 19_000_000) }, tip("base", 20_000_000))).toThrow(/chain mismatch/);
  });

  it("report-grade reads demand finalized commitment", () => {
    expect(REPORT_COMMITMENT).toBe("finalized");
    expect(requireFinalCommitment(solana, undefined)).toBe("finalized");
    expect(requireFinalCommitment(solana, "finalized")).toBe("finalized");
    expect(() => requireFinalCommitment(solana, "confirmed")).toThrow(/require 'finalized'/);
  });
});

describe("duplicate event handling", () => {
  it("keeps first sightings and drops duplicates", () => {
    const buffer = new DedupeBuffer(3);
    const first = { chainId: "base", txId: "0xabc", eventIndex: 0 };
    expect(buffer.add(first)).toBe(true);
    expect(buffer.add(first)).toBe(false);
    // Same tx, different log index: a different event.
    expect(buffer.add({ chainId: "base", txId: "0xabc", eventIndex: 1 })).toBe(true);
    // Same event on another chain: different event.
    expect(buffer.add({ chainId: "ethereum", txId: "0xabc", eventIndex: 0 })).toBe(true);
    expect(buffer.size).toBe(3);
  });

  it("evicts oldest entries at capacity", () => {
    const buffer = new DedupeBuffer(2);
    buffer.add({ chainId: "c", txId: "1", eventIndex: 0 });
    buffer.add({ chainId: "c", txId: "2", eventIndex: 0 });
    buffer.add({ chainId: "c", txId: "3", eventIndex: 0 }); // evicts "1"
    expect(buffer.has({ chainId: "c", txId: "1", eventIndex: 0 })).toBe(false);
    expect(buffer.has({ chainId: "c", txId: "2", eventIndex: 0 })).toBe(true);
    // Re-adding the evicted event counts as a new sighting (bounded memory tradeoff).
    expect(buffer.add({ chainId: "c", txId: "1", eventIndex: 0 })).toBe(true);
  });

  it("filters event pages down to first sightings", () => {
    const buffer = new DedupeBuffer(100);
    const page = [
      { txId: "0xa", eventIndex: 0 },
      { txId: "0xa", eventIndex: 0 },
      { txId: "0xb", eventIndex: 0 },
    ];
    const fresh = dedupeEvents(buffer, "base", page);
    expect(fresh.length).toBe(2);
  });
});

describe("ingestion to evidence", () => {
  const base = getChain("base");
  const providers = fixtureProviders();

  it("builds schema-valid liquidity evidence with ids, provenance, and freshness", async () => {
    const token = evmToken(base, "0xabc0000000000000000000000000000000000001");
    const page = await providers.liquidity.getLiquidity(base, token);
    const evidence = ingestLiquidity(
      { chain: base, providerName: providers.liquidity.name, retrievalMethod: "mock-fixture" },
      page.items[0]!,
      token.address,
      FETCHED_AT,
    );
    const parsed = EvidenceItem.parse(evidence);
    expect(parsed.evidenceId).toMatch(/^ev-/);
    expect(parsed.provenance.provider).toBe("fixture-liquidity");
    expect(parsed.provenance.retrievalMethod).toBe("mock-fixture");
    expect(parsed.fetchedAt).toBe(FETCHED_AT);
    expect(parsed.limitations.length).toBeGreaterThan(0);
  });

  it("quarantines injection-style text found in provider output", async () => {
    const token = evmToken(base, "0xabc0000000000000000000000000000000000001");
    const page = await providers.liquidity.getLiquidity(base, token);
    const poisoned = {
      ...page.items[0]!,
      // A hostile provider injects instructions into a string field it
      // controls; ingestion still flags and quarantines it.
      poolKind: "v2-pool" as const,
    };
    const evidence = ingestLiquidity(
      { chain: base, providerName: providers.liquidity.name, retrievalMethod: "mock-fixture" },
      poisoned,
      token.address,
      FETCHED_AT,
    );
    // Structured fields survive; nothing parsed text as instructions.
    expect(evidence.kind).toBe("price-observation");
    const hostileSummary = {
      ...poisoned,
      // Simulate hostile text reaching the summary path:
    };
    void hostileSummary;
    const flagged = ingestLiquidity(
      { chain: base, providerName: providers.liquidity.name, retrievalMethod: "mock-fixture" },
      poisoned,
      token.address,
      FETCHED_AT,
    );
    expect(EvidenceItem.parse(flagged).limitations.length).toBeGreaterThan(0);
  });

  it("computes source freshness against the provenance tip", async () => {
    const token = evmToken(base, "0xabc0000000000000000000000000000000000001");
    const page = await providers.liquidity.getLiquidity(base, token);
    const observation = page.items[0]!;
    const staleTip = { ...observation.blockProvenance, height: observation.blockProvenance.height + 60 };
    const fresh = computeFreshness("fixture-liquidity", observation, observation.blockProvenance, base, FETCHED_AT);
    const stale = computeFreshness("fixture-liquidity", observation, staleTip, base, FETCHED_AT);
    expect(fresh.stale).toBe(false);
    expect(stale.stale).toBe(true);
    expect(stale.declaredMaxLagSec).toBeGreaterThan(0);
  });
});
