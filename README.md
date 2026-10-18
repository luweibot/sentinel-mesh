# Sentinel Mesh

Collaborative multi-agent Web3 intelligence and **guarded**-trading platform.

This repository is the **phase 0 skeleton**: a fully typed, tested, and runnable
monorepo that establishes the architecture, contracts, and guardrails for the
platform. It deliberately contains **no real signing functionality, no private
key handling, and no live trading**. Chain data comes from deterministic mock
adapters, and every policy decision is simulation-only.

## Status

| Capability | Status |
| --- | --- |
| Monorepo (pnpm + Turborepo, TypeScript strict) | Implemented |
| Shared Zod contracts (manifests, tasks, events, workflow states, policy) | Implemented |
| Agent manifests + registry (signing forbidden at the schema level) | Implemented |
| Versioned event envelopes + event catalog | Implemented |
| Durable workflow state machine (pure, validated reducer) | Implemented |
| Chain adapter interfaces (EVM, Solana) + deterministic mocks | Implemented |
| Mock signer (no cryptography, clearly labelled) | Implemented |
| Independent policy-engine interface + deterministic implementation | Implemented |
| Event publishing (in-memory bus, optional BullMQ publisher) | Implemented |
| Fastify API (health, readiness, agents, tasks, guarded signals) | Implemented |
| Next.js dashboard (read-only overview) | Implemented |
| Config validation, structured logging, SQL migrations | Implemented |
| Live chain reads (RPC), live signing, live trade execution | **Not implemented (phase decision)** |
| Agent execution runtime (workers consuming tasks) | **Not implemented (next phase)** |
| Postgres/Redis wiring in the API (persistence beyond migrations) | **Partially: migrations + probes only** |

See `docs/LIMITATIONS.md` for the full list of what this build does not do.

## Quick start

Prerequisites: Node.js >= 20, pnpm >= 9 (`corepack enable` or `npm i -g pnpm`).

```bash
pnpm install
pnpm build        # build all packages (turbo)
pnpm typecheck    # strict TypeScript check
pnpm lint         # eslint across the workspace
pnpm test         # all unit/integration tests
```

Run the API and web in development (zero external services needed):

```bash
pnpm --filter @sentinel-mesh/api dev        # Fastify on :3001
pnpm --filter @sentinel-mesh/web dev        # Next.js on :3000
```

Try the guarded signal pipeline:

```bash
curl -s -X POST localhost:3001/api/v1/signals \
  -H 'content-type: application/json' \
  -d '{"chain":"solana","tokenIn":"MckSo1anaTkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1","tokenOut":"MckSo1anaTkBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB2","notionalUsdCents":1000}'
```

Full environment and Docker instructions: `docs/SETUP.md`.

## Repository layout

```
sentinel-mesh/
├── apps/
│   ├── api/        Fastify API (health, agents, tasks, guarded signals)
│   └── web/        Next.js dashboard (read-only overview)
├── packages/
│   ├── contracts/      Zod schemas: manifests, tasks, events, workflow states
│   ├── config/         environment validation (strict, dev runs with no env)
│   ├── logger/          structured JSON logging (pino) with redaction
│   ├── chain-adapters/  EVM/Solana adapter interfaces + deterministic mocks
│   ├── policy-engine/   independent policy-engine interface + rules engine
│   ├── queue/           event publisher (in-memory / BullMQ)
│   └── database/        pg client factory + dependency-free SQL migrations
├── docker/          Dockerfiles for api and web
├── docs/            architecture, setup, decisions, limitations
├── docker-compose.yml
└── .env.example     placeholders only; never add real credentials
```

## Safety guardrails (enforced in code)

1. `AgentManifest.permissions.canSignTransactions` is `z.literal(false)`.
2. `PolicyDecision.executionMode` is `z.literal("simulation")`.
3. Config rejects `EXECUTION_MODE=live`, `POLICY_MODE=enforce`, and
   `CHAIN_ADAPTER_MODE=readonly` in phase 0.
4. `chain-adapters` defines **no interface for broadcasting transactions**.
5. The mock signer accepts no key material of any kind.

## Documentation

- `docs/SETUP.md` - prerequisites, environment variables, commands
- `docs/ARCHITECTURE.md` - system design, event flow, versioning policy
- `docs/DECISIONS.md` - architecture decision records
- `docs/EXECUTION.md` - guarded execution and the production go-live checklist
- `docs/SKILLS.md` - review-gated skill registry and sandbox
- `docs/X402.md` - x402 payment guard
- `docs/LIMITATIONS.md` - what this build explicitly does not do
