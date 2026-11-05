/**
 * Agent-facing offer document at /llms.txt.
 *
 * A buying agent that lands on the dashboard should be able to read what is
 * sold, at what price, and how to pay, in a single request. Prices and the
 * receiver here mirror GET /api/v1/payments/catalog, which is the authority:
 * if the two ever disagree, the catalog wins.
 */
export function GET() {
  const body = `# Sentinel Mesh — paid market data for agents, settled in USDC on Base

Sentinel Mesh sells market and risk data per request over x402. There is no
account, no API key and no subscription: you pay for the call you make, from a
wallet, in USDC. Settlement is exact-in EIP-3009 on Base mainnet, verified
cryptographically and then confirmed against chain state before any content is
released.

API base:      https://sentinel-mesh-orchestrator.onrender.com
Free routes:   GET /health, GET /api/v1/payments/catalog (the price authority)
Asset:         USDC on Base, 0x833589fcd6edb6e08f4c7c32d4f71b54bda02913, 6 decimals
Network:       eip155:8453 (Base mainnet)
Receiver:      0x250cf8852e5236dcaf5ee7f06d1e0f5800413866
Scheme:        exact-in (EIP-3009 transferWithAuthorization)
Machine copy:  /x402.json  (this same offer, as JSON)

## What is for sale

| service            | call                                    | price  |
|--------------------|-----------------------------------------|--------|
| tokens.snapshot    | GET  /api/v1/tokens                     | $0.01  |
| fees.snapshot      | GET  /api/v1/fees                       | $0.01  |
| token.detail       | GET  /api/v1/tokens/:chain/:address     | $0.01  |
| price.check        | GET  /api/v1/price?chain=&address=      | $0.01  |
| risk.check         | GET  /api/v1/risk?chain=                | $0.02  |
| whales.list        | GET  /api/v1/whales?chain=              | $0.02  |
| signals.evaluate   | POST /api/v1/signals                    | $0.02  |
| tasks.research     | POST /api/v1/tasks                      | $0.10  |
| workflows.research | POST /api/v1/workflows/research         | $0.50  |

## How to buy, in three steps

1. Call the route unpaid. It answers 402 with a \`requirement\` object: scheme
   exactInEvm, network 8453, asset, maxAmountRequired in atomic units, payTo,
   maxTimeoutSeconds.
2. Sign an EIP-3009 TransferWithAuthorization for exactly that amount to payTo,
   then POST it to /api/v1/payments/verify. The facilitator verifies the
   signature and the amount, and returns a paymentId.
3. Retry the original call with header \`X-PAYMENTS: <paymentId>\`. Content is
   unlocked only once settlement is confirmed on chain.

## What this is not

Execution is not for sale here. Sentinel Mesh also runs a guarded copy-trading
pipeline, and nothing on this API places a trade. The data routes are read-only
and the signal route returns a policy verdict, not an order.

The service sleeps when idle on its current hosting tier: the first request
after a quiet period can take tens of seconds. Send a warm-up GET /health before
a timed call.

## Where else to find this

https://1f916.ai/records/orebot — the operator agent's public, signed record.
`;
  return new Response(body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });
}
