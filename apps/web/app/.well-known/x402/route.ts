/**
 * Machine-readable x402 offer at /.well-known/x402 (also served as /x402.json
 * through the rewrite in next.config.mjs).
 *
 * This is the same offer as /llms.txt in JSON, for agents that parse rather
 * than read. The price authority remains GET /api/v1/payments/catalog.
 */
const RECEIVER = "0x0bee61d45d42d7342d57ea7581d17581203447a8";
const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

const SERVICES = [
  { id: "tokens.snapshot", method: "GET", path: "/api/v1/tokens", priceAtomic: "10000", priceUsd: "0.01" },
  { id: "fees.snapshot", method: "GET", path: "/api/v1/fees", priceAtomic: "10000", priceUsd: "0.01" },
  { id: "token.detail", method: "GET", path: "/api/v1/tokens/:chain/:address", priceAtomic: "10000", priceUsd: "0.01" },
  { id: "price.check", method: "GET", path: "/api/v1/price", priceAtomic: "10000", priceUsd: "0.01" },
  { id: "risk.check", method: "GET", path: "/api/v1/risk", priceAtomic: "20000", priceUsd: "0.02" },
  { id: "whales.list", method: "GET", path: "/api/v1/whales", priceAtomic: "20000", priceUsd: "0.02" },
  { id: "signals.evaluate", method: "POST", path: "/api/v1/signals", priceAtomic: "20000", priceUsd: "0.02" },
  { id: "tasks.research", method: "POST", path: "/api/v1/tasks", priceAtomic: "100000", priceUsd: "0.10" },
  { id: "workflows.research", method: "POST", path: "/api/v1/workflows/research", priceAtomic: "500000", priceUsd: "0.50" },
];

export function GET() {
  const offer = {
    version: 1,
    name: "Sentinel Mesh",
    description:
      "Market and risk data sold per request over x402, settled exact-in in USDC on Base before content unlocks.",
    apiBase: "https://sentinel-mesh-orchestrator.onrender.com",
    freeRoutes: ["/health", "/api/v1/payments/catalog"],
    scheme: "exactInEvm",
    network: "eip155:8453",
    chainId: 8453,
    asset: USDC_BASE,
    assetSymbol: "USDC",
    assetDecimals: 6,
    payTo: RECEIVER,
    maxTimeoutSeconds: 300,
    verifyEndpoint: "/api/v1/payments/verify",
    paymentHeader: "X-PAYMENTS",
    services: SERVICES,
    notForSale: ["trade execution", "custody", "signing on a buyer's behalf"],
    notes: [
      "Call a route unpaid to receive the 402 requirement.",
      "Prices mirror GET /api/v1/payments/catalog, which is authoritative.",
      "The service sleeps when idle; warm up with GET /health before timed calls.",
    ],
    record: "https://1f916.ai/records/orebot",
  };
  return new Response(JSON.stringify(offer, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });
}
