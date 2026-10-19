import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { Logger } from "@sentinel-mesh/logger";
import {
  type LiveProviderBundle,
  fixtureProviders,
  getChain,
  evmToken,
  solanaToken,
  ingestLiquidity,
  ChainIdSchema,
  type IngestContext,
  type LiquidityObservation,
  type SupportedChain,
  type TokenIdentity,
} from "@sentinel-mesh/chain-data";
import { createTokenRiskAgent, createWhaleTrackingAgent, createFeeIntelligenceAgent, DEFAULT_RISK_THRESHOLDS } from "@sentinel-mesh/agents";
import type { AgentContext } from "@sentinel-mesh/agent-sdk";
import type { EvidenceItem } from "@sentinel-mesh/contracts";

/**
 * Explorer endpoints: read-only views over the DETERMINISTIC FIXTURE data
 * layer. Every response carries `dataSource: "fixture"` so the frontend can
 * clearly distinguish mock data from any future live provider data.
 *
 * Nothing here reaches a network, a paid API, or a chain RPC.
 */

const supportedChain = (value: string): SupportedChain => {
  const parsed = ChainIdSchema.safeParse(value);
  if (!parsed.success || !["base", "ethereum", "solana", "solana-mainnet", "solana-devnet"].includes(parsed.data)) {
    throw Object.assign(new Error(`unsupported chain '${value}'`), { statusCode: 400 });
  }
  return getChain(parsed.data);
};

/** Build schema-valid liquidity evidence from fixture observations. */
function liquidityEvidence(
  ctx: IngestContext,
  observations: LiquidityObservation[],
  token: TokenIdentity,
  fetchedAt: string,
): EvidenceItem[] {
  return observations.map((observation) => ingestLiquidity(ctx, observation, token.address, fetchedAt));
}

function agentContext(agentId: string, logger: Logger, now: () => Date): AgentContext {
  return {
    taskId: `explorer-${agentId}`,
    agentId,
    attempt: 1,
    now,
    isOverBudget: () => false,
    signal: { cancelled: false },
    logger,
  };
}

/** Fixture wallets shown on the whale page, one per EVM chain. */
const FIXTURE_WALLETS: Record<string, string> = {
  base: "0xdef0000000000000000000000000000000000009",
  ethereum: "0xdef0000000000000000000000000000000000010",
  "solana-mainnet": "9WzDXwBbmkg8ZTbNMqDmHADSafsSx4zJqF8EKkejiCFr",
  "solana-devnet": "9WzDXwBbmkg8ZTbNMqDmHADSafsSx4zJqF8EKkejiCFr",
  solana: "9WzDXwBbmkg8ZTbNMqDmHADSafsSx4zJqF8EKkejiCFr",
};

export interface ExplorerOptions {
  /**
   * Skip registering the honest no-data GET /api/v1/payments stub. The
   * merged orchestrator service serves the real x402 payment records on
   * that path, so it must not register the stub.
   */
  skipPaymentsStub?: boolean;
  /**
   * Data providers to serve from. Defaults to deterministic fixtures;
   * the merged orchestrator passes the live bundle (free public APIs with
   * per-call fixture fallback) when DATA_SOURCE=live.
   */
  providers?: LiveProviderBundle | ReturnType<typeof fixtureProviders>;
}

/** Honest per-response label: live, fixture, or fixture-fallback. */
function dataSourceLabel(provider: object): "live" | "fixture" | "fixture-fallback" {
  const src = (provider as { lastSource?: string }).lastSource;
  if (src === "live") return "live";
  if (src === "fixture-fallback") return "fixture-fallback";
  return "fixture";
}

/** Evidence retrieval method string mirrors the provider actually used. */
function retrievalMethodOf(provider: object): "api-fetch" | "mock-fixture" {
  const label = dataSourceLabel(provider);
  return label === "live" ? "api-fetch" : label === "fixture-fallback" ? "mock-fixture" : "mock-fixture";
}

export function registerExplorerRoutes(
  app: FastifyInstance,
  logger: Logger,
  now: () => Date,
  options: ExplorerOptions = {},
): void {
  const providers = options.providers ?? fixtureProviders();

  /** GET /api/v1/tokens?chain= — trending tokens (live GeckoTerminal or fixture). */
  app.get("/api/v1/tokens", async (request) => {
    const chain = supportedChain(((request.query as Record<string, string>).chain ?? "base"));
    const discovery = await providers.discovery.discoverTokens(chain, { limit: 10 });
    return {
      dataSource: dataSourceLabel(providers.discovery),
      chain: chain.id,
      tokens: discovery.items.map((t) => ({ address: t.token.address, symbol: t.token.symbol, tvlUsd: t.tvlUsd, observedAt: t.observedAt })),
      nextCursor: discovery.nextCursor,
    };
  });

  /** GET /api/v1/tokens/:chain/:address — audit: metadata, pools, liquidity, fees, provenance. */
  app.get("/api/v1/tokens/:chain/:address", async (request) => {
    const params = request.params as { chain: string; address: string };
    const chain = supportedChain(params.chain);
    const token = chain.kind === "evm" ? evmToken(chain, params.address) : solanaToken(chain, params.address);
    const metadata = await providers.metadata.getContractMetadata(chain, token.address);
    const liquidity = await providers.liquidity.getLiquidity(chain, token);
    const fees = await providers.fees.estimateFee(chain, { kind: "swap" });
    const provenance = await providers.provenance.getProvenance(chain);
    const labels = [providers.metadata, providers.liquidity, providers.fees, providers.provenance].map(dataSourceLabel);
    return {
      dataSource: labels.every((l) => l === "live") ? "live" : labels.every((l) => l === "fixture") ? "fixture" : "mixed",
      chain: chain.id,
      token,
      metadata,
      liquidity: liquidity.items,
      fees,
      provenance,
    };
  });

  /** GET /api/v1/evidence?chain= — schema-valid liquidity evidence for the first fixture token. */
  app.get("/api/v1/evidence", async (request) => {
    const chain = supportedChain(((request.query as Record<string, string>).chain ?? "base"));
    const address = (request.query as Record<string, string>).address;
    const discovery = await providers.discovery.discoverTokens(chain, { limit: 1 });
    const first = discovery.items[0]!;
    const tokenIdentity = chain.kind === "evm"
      ? evmToken(chain, address ?? first.token.address)
      : solanaToken(chain, address ?? first.token.address);
    const liquidity = await providers.liquidity.getLiquidity(chain, tokenIdentity);
    const evidence = liquidityEvidence(
      { chain, providerName: providers.liquidity.name, retrievalMethod: retrievalMethodOf(providers.liquidity) },
      liquidity.items,
      tokenIdentity,
      now().toISOString(),
    );
    return { dataSource: dataSourceLabel(providers.liquidity), chain: chain.id, token: tokenIdentity, evidence };
  });

  /** GET /api/v1/risk?chain= — rug/bull risk findings over live liquidity evidence. */
  app.get("/api/v1/risk", async (request) => {
    const chain = supportedChain(((request.query as Record<string, string>).chain ?? "base"));
    const discovery = await providers.discovery.discoverTokens(chain, { limit: 3 });
    const agent = createTokenRiskAgent(DEFAULT_RISK_THRESHOLDS);
    const findings = [];
    for (const token of discovery.items) {
      const tokenIdentity = token.token;
      const liquidity = await providers.liquidity.getLiquidity(chain, tokenIdentity);
      const evidence = liquidityEvidence(
        { chain, providerName: providers.liquidity.name, retrievalMethod: retrievalMethodOf(providers.liquidity) },
        liquidity.items,
        tokenIdentity,
        now().toISOString(),
      );
      if (evidence.length === 0) continue;
      const output = await agent.handle(agentContext("token-risk-agent", logger, now), {
        token: { chainId: chain.id, address: tokenIdentity.address, symbol: tokenIdentity.symbol },
        evidence,
      });
      findings.push({ token: { chainId: chain.id, address: tokenIdentity.address, symbol: tokenIdentity.symbol }, risk: output });
    }
    return { dataSource: dataSourceLabel(providers.discovery), chain: chain.id, findings };
  });

  /** GET /api/v1/whales?chain= — wallet activity (live RPC logs or fixture) classified by the whale agent. */
  app.get("/api/v1/whales", async (request) => {
    const chain = supportedChain(((request.query as Record<string, string>).chain ?? "base"));
    const wallet = (request.query as Record<string, string>).wallet ?? FIXTURE_WALLETS[chain.id] ?? (chain.kind === "evm" ? "0xdef0000000000000000000000000000000000009" : "9WzDXwBbmkg8ZTbNMqDmHADSafsSx4zJqF8EKkejiCFr");
    const tokenIdentity = chain.kind === "evm" ? evmToken(chain, "0xabc0000000000000000000000000000000000001") : solanaToken(chain, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    const liquidity = await providers.liquidity.getLiquidity(chain, tokenIdentity);
    const evidence = liquidityEvidence(
      { chain, providerName: providers.liquidity.name, retrievalMethod: retrievalMethodOf(providers.liquidity) },
      liquidity.items,
      tokenIdentity,
      now().toISOString(),
    );
    const agent = createWhaleTrackingAgent();
    const activity = await agent.handle(agentContext("whale-tracking-agent", logger, now), {
      wallet,
      chainId: chain.id,
      evidence,
    });
    const raw = await providers.activity.getActivity(chain, wallet, { limit: 20 });
    return {
      dataSource: dataSourceLabel(providers.activity),
      chain: chain.id,
      wallet,
      analysis: activity,
      events: raw.items,
      nextCursor: raw.nextCursor,
    };
  });

  /** GET /api/v1/fees?chain= — fixture fee estimate from the fee agent. */
  app.get("/api/v1/fees", async (request) => {
    const chain = supportedChain(((request.query as Record<string, string>).chain ?? "base"));
    const tokenIdentity = chain.kind === "evm" ? evmToken(chain, "0xabc0000000000000000000000000000000000001") : solanaToken(chain, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    const liquidity = await providers.liquidity.getLiquidity(chain, tokenIdentity);
    const evidence = liquidityEvidence(
      { chain, providerName: providers.liquidity.name, retrievalMethod: retrievalMethodOf(providers.liquidity) },
      liquidity.items,
      tokenIdentity,
      now().toISOString(),
    );
    const agent = createFeeIntelligenceAgent();
    const analysis = await agent.handle(agentContext("fee-intelligence-agent", logger, now), {
      chainId: chain.id,
      evidence,
    });
    return { dataSource: dataSourceLabel(providers.fees), chain: chain.id, analysis };
  });

  /** GET /api/v1/price?chain=&address= — current price + 24h momentum + rug/bull context (paid, price.check). */
  app.get("/api/v1/price", async (request, reply) => {
    const query = request.query as Record<string, string>;
    if (!query.address) {
      reply.code(400).send({ error: "ADDRESS_REQUIRED", detail: "pass ?chain=base&address=0x..." });
      return;
    }
    const prices = "prices" in providers ? (providers as LiveProviderBundle).prices : undefined;
    if (!prices) {
      reply.code(503).send({
        error: "PRICE_UNAVAILABLE",
        detail: "price.check requires live data providers; set DATA_SOURCE=live",
      });
      return;
    }
    const chain = supportedChain(query.chain ?? "base");
    try {
      const { pair, source } = await prices.getPrice(chain, query.address);
      const liquidityUsd = pair.liquidity?.usd ?? 0;
      const volume24hUsd = pair.volume?.h24 ?? 0;
      const ageHours = pair.pairCreatedAt ? (Date.now() - pair.pairCreatedAt) / 3_600_000 : undefined;
      const h24 = pair.priceChange?.h24 ?? 0;
      reply.send({
        dataSource: source === "live" ? "live" : "fixture-fallback",
        chain: chain.id,
        address: pair.baseToken.address,
        token: { symbol: pair.baseToken.symbol, name: pair.baseToken.name },
        pool: { dexId: pair.dexId, pairAddress: pair.pairAddress, quoteToken: pair.quoteToken.symbol },
        priceUsd: Number(pair.priceUsd ?? 0),
        priceChangePercent: { h1: pair.priceChange?.h1, h6: pair.priceChange?.h6, h24: h24 },
        liquidityUsd,
        volume24hUsd,
        marketCapUsd: pair.marketCap ?? pair.fdv,
        rugBullContext: {
          // Deterministic, explainable heuristics; no black-box score.
          poolAgeHours: ageHours,
          liquidityToVolume24h: volume24hUsd > 0 ? Number((liquidityUsd / volume24hUsd).toFixed(4)) : undefined,
          buys24h: pair.txns?.h24?.buys,
          sells24h: pair.txns?.h24?.sells,
          buySellRatio: pair.txns?.h24 && pair.txns.h24.sells ? Number(((pair.txns.h24.buys ?? 0) / pair.txns.h24.sells).toFixed(3)) : undefined,
          momentum: h24 >= 0 ? "bull" : "bear",
        },
      });
    } catch (err) {
      reply.code(502).send({
        error: "PRICE_UNAVAILABLE",
        detail: err instanceof Error ? err.message : "no live price available for this token",
      });
    }
  });

  if (!options.skipPaymentsStub) {
    /** GET /api/v1/payments — honest no-data page: no payments exist in this phase. */
    app.get("/api/v1/payments", async () => ({
      dataSource: "none",
      status: "no-data",
      items: [],
      detail:
        "No payments exist in Sentinel Mesh in this phase. No billing, subscriptions, or payment rails are implemented; this endpoint exists so the dashboard renders an honest empty state instead of fabricated numbers.",
    }));
  }

  /** GET /api/v1/portfolio — honest no-data page: no fills are attributed yet. */
  app.get("/api/v1/portfolio", async () => ({
    dataSource: "none",
    status: "no-data",
    detail:
      "Portfolio analytics require attributed fills, which do not exist in this phase. Paper trade receipts are available from the orchestrator's /api/v1/execution/receipts endpoint and shown on the journal page.",
  }));
}

export const ExplorerQuerySchema = z.object({ chain: z.string().optional() }).strict();
