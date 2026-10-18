# Architecture

## Overview

Sentinel Mesh is a collaborative multi-agent platform for Web3 intelligence and
guarded trading. Phase 0 establishes the skeleton: contracts, guarded
decisioning, and deterministic infrastructure. The guiding constraints are:

1. **Safety by schema.** Dangerous capabilities (signing, live execution) are
   not merely switched off; the contracts make representing them impossible.
2. **Determinism by default.** With zero configuration the platform runs
   entirely in-process with mock adapters and an in-memory event bus. Every
   mock value is a pure function of its input (sha256-derived), so runs are
   reproducible.
3. **Contracts before services.** All cross-package data shapes live in one
   package (`contracts`) and are validated at every boundary.

```
                       +--------------------------+
                       |  apps/web (Next.js 14)   |  read-only dashboard
                       +------------+-------------+
                                    |
                       +------------v-------------+
   clients, agents --> |  apps/api (Fastify 4)    |
                       |  health / agents / tasks |
                       |  guarded signal pipeline |
                       +---+-----------+----------+
                           |           |
              +------------v---+   +---v-----------------+
              | @sentinel-mesh |   | @sentinel-mesh     |
              | /queue         |   | /policy-engine     |
              | in-mem or      |   | deterministic rules|
              | BullMQ (Redis) |   | (independent iface)|
              +------+---------+   +---+-----------------+
                     |                 |
        +------------v-----------------v-------------+
        |            @sentinel-mesh/contracts        |
        | schemas: manifests, tasks, events, workflow |
        +--------------------------------------------+
                     |                 |
      +--------------v---+      +-------v--------------+
      | /chain-adapters  |      | /database           |
      | mock EVM/Solana  |      | pg pool + SQL       |
      | mock signer      |      | migrations          |
      | mock simulator   |      +--------------------+
      +------------------+
```

## Packages

| Package | Responsibility | Depends on |
| --- | --- | --- |
| `contracts` | Single source of truth for all data shapes: agent manifests, task/result contracts, versioned event envelopes + catalog, policy decision/request, durable workflow states + pure reducer, fixture manifests | zod |
| `config` | Strict env validation; phase 0 legal-value guardrails; deterministic dev defaults | zod |
| `logger` | Structured JSON logging (pino), ISO timestamps, sensitive-key redaction | pino |
| `chain-adapters` | `EvmChainAdapter` / `SolanaChainAdapter` interfaces, deterministic mock implementations, `MockSigner`, `MockTradeSimulator` | contracts |
| `policy-engine` | `PolicyEngine` interface + `DeterministicPolicyEngine`; the only code allowed to construct `PolicyDecision` | contracts |
| `queue` | `EventPublisher` / `EventSubscriber` interfaces; in-memory bus (dev/test); BullMQ publisher (Redis, opt-in) | contracts, bullmq, ioredis |
| `database` | pg Pool factory; dependency-free transactional SQL migration runner; bundled migrations | pg |
| `api` | Fastify app factory (all deps injectable): health, readiness, agent registry, task issuing, guarded signal endpoint | all of the above |
| `web` | Next.js App Router dashboard rendering the fixture manifests and guardrails | contracts |

Dependency direction is strictly one-way: `contracts` depends on nothing but
zod; services depend on contracts and infrastructure adapters; nothing
depends on the apps.

## The guarded signal pipeline

`POST /api/v1/signals` exercises the core phase 0 flow:

1. Validate the request body (Zod).
2. Build a `SignalCreatedPayload`, wrap it in a `signal.created` envelope,
   publish it.
3. Ask the **policy engine** to evaluate the signal (allowed chains, notional
   cap, advisory review threshold).
4. Wrap the resulting `PolicyDecision` in a `policy.decision.recorded`
   envelope (same `correlationId` as the signal) and publish it.
5. Respond with the signal, the decision, and an explicit
   `execution.status: "not-executed"` notice.

There is no step 6. Trade execution does not exist in this build; the policy
engine decides, and nothing acts on an "allow" beyond the recorded decision.

### Policy engine rules (phase 0)

- Signal chain must be in `allowedChains`, else reject `chain-not-allowed`.
- Notional must not exceed `maxNotionalUsdCents`, else reject
  `notional-exceeds-cap`.
- Notional above 50% of the cap (configurable) adds an advisory reason and the
  verdict becomes `requires-review`.
- Otherwise verdict `allow`. Every decision carries
  `executionMode: "simulation"` (schema literal).

## Event envelopes and versioning policy

Every cross-boundary message is an envelope:

```
{ schemaVersion, eventId, type, occurredAt, actor, correlationId?, payload }
```

- `type` must exist in `EventCatalog`; producers build envelopes through
  `createEnvelope(definition, payload, ctx)`, which validates the payload
  against the registered schema. Unknown event types cannot be published.
- **Breaking changes** (envelope structure) bump `EVENT_ENVELOPE_VERSION`;
  consumers must reject unknown versions (tests cover this).
- **Additive payload changes** stay in the event definition's schema, with the
  change documented in the changelog.
- The catalog is the registry: `agent.task.issued`, `agent.task.completed`,
  `signal.created`, `policy.decision.recorded`, `workflow.state.changed`.

## Durable workflow states

Workflows (e.g. the future "observe wallet -> generate signal -> evaluate ->
simulate" pipeline) are modeled as JSON documents validated by
`WorkflowRun`. State advances only through `applyWorkflowCommand(run, cmd)`,
a pure reducer that:

- rejects invalid transitions with `WorkflowTransitionError`,
- re-validates the whole document after each transition (no invalid state can
  be persisted),
- never mutates its input.

Postgres tables (`workflow_runs`, `workflow_steps`) store these documents.
A crashed process can reload a run and continue applying commands. The
`waiting` status exists in the contract for future pause/resume semantics;
phase 0 transitions are: pending -> running -> completed/failed/cancelled.

## Agents

Agents are described by **manifests** (data, not code). Phase 0 ships four
fixture manifests (trend-scout, wallet-watcher, policy-guard, sim-executor)
in `contracts`. The API serves them and validates task requests against them
(supported task types, coherence of capabilities vs task types). A future
phase adds an agent runtime that consumes `agent.task.issued` events and
produces `agent.task.completed` events.

Guardrail: `permissions.canSignTransactions` is `z.literal(false)`. Any
manifest claiming signing capability fails validation, and the fixture loader
asserts coherence at module load.

## Chain adapters

Two chain-specific interfaces (`EvmChainAdapter`, `SolanaChainAdapter`) extend
a common read-only surface (`getTokenMetadata`, `getWalletActivity`,
`getBlockHeight`). The `mode` field (`mock` | `readonly`) is part of the
interface so capability is explicit at the type level. Only deterministic
mock implementations exist in phase 0. **There is no transaction broadcast
method anywhere in the package.**

## Configuration and logging

- `@sentinel-mesh/config` validates the environment at startup with strict
  Zod schemas. Phase 0 legal values are enforced (simulation/dry-run/mock
  only), with errors that name each bad variable.
- `@sentinel-mesh/logger` wraps pino: one JSON object per line, ISO
  timestamps, `service` in every line, redaction of key-like fields
  (`privateKey`, `mnemonic`, `seedPhrase`, `password` at any depth).

## Deterministic development environment

- Zero env vars needed; unset infra URLs select in-process drivers.
- All mock data derives from sha256 of inputs; fixed block heights and
  observation timestamps.
- Tests run offline: Postgres is faked with an in-process query executor;
  Redis is never contacted (BullMQ module is dynamically imported only when
  `REDIS_URL` is set).
- Docker Compose pins Postgres 16 / Redis 7 images with healthchecks for the
  full stack; the API container runs migrations before serving.
