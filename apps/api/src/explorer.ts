import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { Logger } from "@sentinel-mesh/logger";
import {
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

export function registerExplorerRoutes(app: FastifyInstance, logger: Logger, now: () => Date): void {
  const providers = fixtureProviders();

  /** GET /api/v1/tokens?chain= — discovered fixture tokens. */
  app.get("/api/v1/tokens", async (request) => {
    const chain = supportedChain(((request.query as Record<string, string>).chain ?? "base"));
    const discovery = await providers.discovery.discoverTokens(chain, { limit: 10 });
    return {
      dataSource: "fixture",
      chain: chain.id,
      tokens: discovery.items.map((t) => ({ address: t.token.address, symbol: t.token.symbol, tvlUsd: t.tvlUsd, observedAt: t.observedAt })),
      nextCursor: discovery.nextCursor,
    };
  });

  /** GET /api/v1/tokens/:chain/:address — metadata, liquidity, fees, provenance. */
  app.get("/api/v1/tokens/:chain/:address", async (request) => {
    const params = request.params as { chain: string; address: string };
    const chain = supportedChain(params.chain);
    const token = chain.kind === "evm" ? evmToken(chain, params.address) : solanaToken(chain, params.address);
    const metadata = await providers.metadata.getContractMetadata(chain, token.address);
    const liquidity = await providers.liquidity.getLiquidity(chain, token);
    const fees = await providers.fees.estimateFee(chain, { kind: "swap" });
    const provenance = await providers.provenance.getProvenance(chain);
    return {
      dataSource: "fixture",
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
      { chain, providerName: providers.liquidity.name, retrievalMethod: "mock-fixture" },
      liquidity.items,
      tokenIdentity,
      now().toISOString(),
    );
    return { dataSource: "fixture", chain: chain.id, token: tokenIdentity, evidence };
  });

  /** GET /api/v1/risk?chain= — token risk findings from the risk agent over fixture evidence. */
  app.get("/api/v1/risk", async (request) => {
    const chain = supportedChain(((request.query as Record<string, string>).chain ?? "base"));
    const discovery = await providers.discovery.discoverTokens(chain, { limit: 3 });
    const agent = createTokenRiskAgent(DEFAULT_RISK_THRESHOLDS);
    const findings = [];
    for (const token of discovery.items) {
      const tokenIdentity = token.token;
      const liquidity = await providers.liquidity.getLiquidity(chain, tokenIdentity);
      const evidence = liquidityEvidence(
        { chain, providerName: providers.liquidity.name, retrievalMethod: "mock-fixture" },
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
    return { dataSource: "fixture", chain: chain.id, findings };
  });

  /** GET /api/v1/whales?chain= — fixture wallet activity classified by the whale agent. */
  app.get("/api/v1/whales", async (request) => {
    const chain = supportedChain(((request.query as Record<string, string>).chain ?? "base"));
    const wallet = (request.query as Record<string, string>).wallet ?? FIXTURE_WALLETS[chain.id] ?? (chain.kind === "evm" ? "0xdef0000000000000000000000000000000000009" : "9WzDXwBbmkg8ZTbNMqDmHADSafsSx4zJqF8EKkejiCFr");
    const tokenIdentity = chain.kind === "evm" ? evmToken(chain, "0xabc0000000000000000000000000000000000001") : solanaToken(chain, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    const liquidity = await providers.liquidity.getLiquidity(chain, tokenIdentity);
    const evidence = liquidityEvidence(
      { chain, providerName: providers.liquidity.name, retrievalMethod: "mock-fixture" },
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
      dataSource: "fixture",
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
      { chain, providerName: providers.liquidity.name, retrievalMethod: "mock-fixture" },
      liquidity.items,
      tokenIdentity,
      now().toISOString(),
    );
    const agent = createFeeIntelligenceAgent();
    const analysis = await agent.handle(agentContext("fee-intelligence-agent", logger, now), {
      chainId: chain.id,
      evidence,
    });
    return { dataSource: "fixture", chain: chain.id, analysis };
  });

  /** GET /api/v1/payments — honest no-data page: no payments exist in this phase. */
  app.get("/api/v1/payments", async () => ({
    dataSource: "none",
    status: "no-data",
    items: [],
    detail:
      "No payments exist in Sentinel Mesh in this phase. No billing, subscriptions, or payment rails are implemented; this endpoint exists so the dashboard renders an honest empty state instead of fabricated numbers.",
  }));

  /** GET /api/v1/portfolio — honest no-data page: no fills are attributed yet. */
  app.get("/api/v1/portfolio", async () => ({
    dataSource: "none",
    status: "no-data",
    detail:
      "Portfolio analytics require attributed fills, which do not exist in this phase. Paper trade receipts are available from the orchestrator's /api/v1/execution/receipts endpoint and shown on the journal page.",
  }));
}

export const ExplorerQuerySchema = z.object({ chain: z.string().optional() }).strict();
