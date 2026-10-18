# Limitations

> **Security audit (2026-10-18):** see [SECURITY-AUDIT.md](./SECURITY-AUDIT.md) —
> two execution race conditions were found and fixed with regression tests;
> deployment controls (authN, TLS, real credentials) remain owner actions
> before any production exposure. Live trading is NOT production-ready. and Non-Goals (Phase 0)

This document lists, without hedging, what this build does **not** do. None of
the items below are bugs; they are deliberate phase 0 exclusions. Where a
feature is partially present, the boundary is stated.

## Hard exclusions (by design)

- **No real signing.** The only signer is `MockSigner`: deterministic
  sha256-derived strings prefixed `mock-sig-`, no key material accepted,
  generated, or stored. No crypto libraries are in the dependency tree.
- **No private key handling.** No environment variable, config field, or
  code path accepts a private key or seed phrase. `.env.example` documents
  this explicitly.
- **No live trades.** There is no transaction-execution code in this
  repository. The guarded signal endpoint always returns
  `execution.status: "not-executed"`. `EXECUTION_MODE=live` fails validation
  at startup.
- **No live chain access.** All chain adapters are deterministic in-process
  mocks. The `readonly` adapter mode exists as an interface and a config
  value placeholder, but there is no RPC client in the tree and setting
  `CHAIN_ADAPTER_MODE=readonly` fails validation in phase 0.

## Not yet implemented (future phases)

- **Agent runtime.** Nothing consumes `agent.task.issued` events or produces
  `agent.task.completed` events. The API issues tasks and publishes them;
  execution is a next-phase worker.
- **Trade simulation service.** `MockTradeSimulator` exists in
  `chain-adapters` and is tested, but no service calls it over HTTP/queue
  yet.
- **Persistence wiring.** Migrations define the full schema (events outbox,
  agent registry, workflow runs/steps, signals, policy decisions), but the
  API does not yet write to these tables; only the migration runner and the
  readiness probe touch Postgres.
- **Enforcement.** `POLICY_MODE` accepts only `dry-run`; the policy engine
  evaluates and records, nothing enforces.
- **Consumers/projections.** No subscriber implementations exist beyond the
  in-memory bus used in tests.
- **Authentication/authorization.** None. The API is unauthenticated; do not
  expose it publicly.
- **Multi-instance operation.** The in-memory bus is single-process; only the
  BullMQ publisher is multi-process-ready (and it is untested against a live
  Redis in this phase).

## Verification environment caveats

These commands were run and pass in the authoring environment (Node 20,
pnpm 9.15.9, clean sandbox):

```
pnpm install
pnpm build        # 9/9 tasks
pnpm typecheck    # all packages, strict
pnpm lint         # eslint 9 flat config, zero errors
pnpm test         # 15 test files, 69 tests
```

Additionally the API was smoke-tested live (`tsx src/server.ts`): /health,
/health/ready, POST /api/v1/tasks, POST /api/v1/signals (allow,
requires-review, and reject paths), with structured JSON logs verified.

**Not executed** during authoring (no daemon available in the sandbox):

- `docker compose up` (and the Docker image builds). The Dockerfiles and
  compose file follow standard pnpm/Turborepo patterns but have never been
  built; validate them on first use.
- Live Postgres runs: the migration runner is tested against an in-process
  fake executor, and `db:migrate` against a real database was not exercised
  here.
- Live Redis runs: the BullMQ publisher is type-checked and integration-tested
  only via the in-memory path; it was never connected to a Redis server.

## Known rough edges

- The web dashboard is a static overview; it does not fetch live API data.
- The agent registry is a code fixture; there is no admin API or DB-backed
  registry yet (the table exists in the schema).
- Turborepo remote caching and CI pipelines are not configured (no CI file in
  this phase).

## Skills and payments (new packages)

Not implemented in this phase:

- Skill registry persistence: records are in-memory and reset on restart.
  Approval/install history therefore does not survive restarts; no guard
  behavior depends on persistence for safety.
- Skill content EXECUTION: SKILL.md is stored, hashed, and scanned, but no
  agent loads or follows skill instructions at runtime yet. The registry is
  infrastructure for that capability, not the capability itself.
- Live x402 facilitator: only the deterministic mock is wired in. Real
  EIP-3009 signature recovery (`ecrecover` against `from`) is NOT
  implemented; any forged-but-schema-valid payload passes the guard's
  opaque-evidence check in this phase, which is acceptable ONLY because
  no live facilitator exists and the demo fixtures are trusted.
- Payment record persistence and a real recipient settlement path: records
  and cap reservations are in-memory; the mock facilitator never moves
  funds anywhere.
