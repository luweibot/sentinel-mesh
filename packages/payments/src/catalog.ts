/**
 * x402 service catalog: every paid API route, its exact price, and the
 * requirement generator a payer needs.
 *
 * PRICING BENCHMARK (2026-10, per-call rates on agentic API marketplaces):
 *  - CoinGecko x402 & CoinMarketCap x402: $0.01/request flat for data
 *  - Laevitas x402: $0.001/request for tick data
 *  - OpenAI Agents web search: $10/1,000 calls = $0.01/call; file search $0.0025/call
 *  - Google Agent Search: $1.50/1,000 queries = $0.0015/query
 *  - Multi-step agent tasks and workflows command 10-50x simple data calls.
 *
 * All prices are exact-in USDC (6 decimals) on Base (chain id 8453).
 * Amounts are atomic-unit decimal strings (bigint-safe), NOT numbers.
 */

/** USDC contract on Base mainnet (x402 settlement asset). */
export const X402_ASSET_BASE_USDC = "0x833589fcd6edb6e08f4c2c6ff80ffe7fd34502b0";
/** x402 v1 settlements on this deployment settle on Base. */
export const X402_NETWORK_BASE = 8453;

export interface PricedService {
  serviceId: string;
  /** Exact price in USDC atomic units (6 decimals), as a decimal string. */
  amountAtomic: string;
  /** Same price in USD, for display and comparison. */
  priceUsd: string;
  description: string;
  /** "METHOD path" route keys this price gates. */
  routes: string[];
  /** Human-readable pricing rationale (published in the catalog endpoint). */
  rationale: string;
}

const cents = (usd: number): string => String(Math.round(usd * 1_000_000));

/**
 * Catalog decisions (see benchmark above):
 *  - tokens/fees snapshots match the $0.01 market rate for crypto data x402 APIs.
 *  - signal evaluation adds a deterministic policy verdict: 2x the data rate.
 *  - a research task runs several provider calls behind one request: 10x data
 *    rate, in line with per-call agent search pricing scaled up.
 *  - a research workflow runs 5+ tasks: 5x the single-task price (bundle
 *    discount over paying per task).
 */
export const SERVICE_CATALOG: readonly PricedService[] = [
  {
    serviceId: "tokens.snapshot",
    amountAtomic: cents(0.01),
    priceUsd: "0.01",
    description: "GET /api/v1/tokens — trending token snapshot (chain, price, volume, liquidity).",
    routes: ["GET /api/v1/tokens"],
    rationale: "Matches the $0.01/request flat rate of CoinGecko and CoinMarketCap x402 crypto-data APIs.",
  },
  {
    serviceId: "fees.snapshot",
    amountAtomic: cents(0.01),
    priceUsd: "0.01",
    description: "GET /api/v1/fees — current chain fee snapshot per chain.",
    routes: ["GET /api/v1/fees"],
    rationale: "Simple snapshot read; market rate for x402 data endpoints is $0.01 (CoinMarketCap, CoinGecko).",
  },
  {
    serviceId: "signals.evaluate",
    amountAtomic: cents(0.02),
    priceUsd: "0.02",
    description: "POST /api/v1/signals — evaluate a trade signal through the deterministic policy engine.",
    routes: ["POST /api/v1/signals"],
    rationale: "Data call plus a policy verdict; 2x the $0.01 data rate, still far below bespoke signal APIs.",
  },
  {
    serviceId: "tasks.research",
    amountAtomic: cents(0.1),
    priceUsd: "0.10",
    description: "POST /api/v1/tasks — issue one agent task (e.g. research-topic, trend-scan).",
    routes: ["POST /api/v1/tasks"],
    rationale: "A task fans out to several provider calls; 10x the data rate, aligned with agent-search call pricing (OpenAI ~$0.01/call, multi-step agents higher).",
  },
  {
    serviceId: "workflows.research",
    amountAtomic: cents(0.5),
    priceUsd: "0.50",
    description: "POST /api/v1/workflows/research — run a multi-step research workflow (5+ agent tasks).",
    routes: ["POST /api/v1/workflows/research"],
    rationale: "Bundle price: 5x a single task with a built-in discount vs paying $0.10 per task 5+ times.",
  },
  {
    serviceId: "token.detail",
    amountAtomic: cents(0.01),
    priceUsd: "0.01",
    description: "GET /api/v1/tokens/:chain/:address — single-token audit: on-chain metadata, pools, liquidity, fees, provenance.",
    routes: ["GET /api/v1/tokens/:chain/:address"],
    rationale: "Single-token deep read across public RPC + DexScreener; matches the $0.01 market flat rate for x402 data endpoints.",
  },
  {
    serviceId: "price.check",
    amountAtomic: cents(0.01),
    priceUsd: "0.01",
    description: "GET /api/v1/price?chain=&address= — current price, 24h change, liquidity and rug/bull context.",
    routes: ["GET /api/v1/price"],
    rationale: "Real-time quote plus momentum context; matches the $0.01 market rate for x402 price feeds.",
  },
  {
    serviceId: "risk.check",
    amountAtomic: cents(0.02),
    priceUsd: "0.02",
    description: "GET /api/v1/risk?chain= — rug/bull risk findings over live liquidity evidence for trending tokens.",
    routes: ["GET /api/v1/risk"],
    rationale: "Runs the deterministic risk agent over fresh liquidity evidence for several tokens; 2x the data rate.",
  },
  {
    serviceId: "whales.list",
    amountAtomic: cents(0.02),
    priceUsd: "0.02",
    description: "GET /api/v1/whales?chain= — recent wallet activity classified by the whale-tracking agent.",
    routes: ["GET /api/v1/whales"],
    rationale: "RPC log scan plus agent classification; 2x the data rate.",
  },
];

/** Routes that stay free: discovery, health, payment plumbing, task retrieval. */
export const FREE_ROUTES: readonly string[] = [
  "GET /health",
  "GET /health/ready",
  "GET /api/v1/agents",
  "GET /api/v1/skills",
  "GET /api/v1/payments",
  "GET /api/v1/payments/catalog",
  "GET /api/v1/payments/requirement",
  "POST /api/v1/payments/verify",
  "POST /api/v1/payments/settle",
];

export function findServiceByRoute(routeKey: string): PricedService | undefined {
  return SERVICE_CATALOG.find((service) => service.routes.includes(routeKey));
}

export function findServiceById(serviceId: string): PricedService | undefined {
  return SERVICE_CATALOG.find((service) => service.serviceId === serviceId);
}

/**
 * Build the x402 v1 payment requirement for a catalog service.
 * `payTo` is the project wallet; the amount is the exact catalog price.
 */
export function requirementForService(service: PricedService, payTo: string, assetAddress: string = X402_ASSET_BASE_USDC): {
  scheme: "exactInEvm";
  network: number;
  asset: string;
  maxAmountRequired: string;
  payTo: string;
  maxTimeoutSeconds: number;
  mimeType: string;
  extra: { name: string; version: string; description: string };
} {
  return {
    scheme: "exactInEvm",
    network: X402_NETWORK_BASE,
    asset: assetAddress,
    maxAmountRequired: service.amountAtomic,
    payTo,
    maxTimeoutSeconds: 300,
    mimeType: "application/json",
    extra: {
      name: `sentinel-mesh/${service.serviceId}`,
      version: "1",
      description: service.description,
    },
  };
}
