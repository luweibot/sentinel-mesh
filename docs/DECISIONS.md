# Architecture Decision Records

Phase 0 decisions, recorded so future phases can revisit them deliberately.
Each entry lists the decision, the rationale, and the tradeoff accepted.

## ADR-001: pnpm workspaces + Turborepo

**Decision.** pnpm workspaces with Turborepo for task orchestration.
**Rationale.** Strict, symlinked node_modules prevent phantom dependencies;
turbo caches and orders build/test tasks across packages via the `^build`
dependency graph.
**Tradeoff.** Contributors must use pnpm (enforced by `packageManager`).

## ADR-002: Per-package `tsc` builds to `dist`, NodeNext modules

**Decision.** Each package compiles with its own `tsc` to `dist` (ESM,
`.js` extension imports, NodeNext). Apps consume built artifacts.
**Rationale.** Predictable, tool-agnostic outputs; `next build`, `node`, and
`tsx` all consume the same artifacts; no bundler magic in the dependency graph.
**Tradeoff.** Relative imports inside packages need `.js` extensions. A
switch to `tsup`/`unbuild` would remove that, at the cost of bundler
complexity in the toolchain.

## ADR-003: Zod-first contracts in a single package

**Decision.** Every cross-package shape lives in `@sentinel-mesh/contracts`
as Zod schemas; inferred types everywhere; strict object mode.
**Rationale.** One place to change; validation reused at every boundary
(HTTP, queue, database); the schema is executable documentation.
**Tradeoff.** The package is a dependency hub; it must stay runtime-light
(zod only) and free of Node-only APIs so the web app can import it (only
`node:crypto`'s `randomUUID` is used, safe in Next server components).

## ADR-004: Schema-level safety guards instead of runtime flags

**Decision.** Signing and live trading are excluded structurally:
`canSignTransactions: z.literal(false)` in manifests, `executionMode:
z.literal("simulation")` in policy decisions, config enums that reject
`live`/`enforce`/`readonly`, and no broadcast interface in chain-adapters.
**Rationale.** Flags can be flipped by one bad deploy; literals cannot be
represented at all. Adding real signing becomes a schema change with review,
not a config change.
**Tradeoff.** Enabling these capabilities in a later phase requires deliberate
schema migrations and an explicit ADR (the intended future ADR-011: signing).

## ADR-005: pino for structured logging

**Decision.** pino with ISO timestamps, `service` base field, redaction list
for key material.
**Rationale.** Fast, JSON by default, redaction built in, near-zero config.
**Tradeoff.** pino's numeric levels leak in raw output; acceptable.

## ADR-006: Plain SQL migrations with a 100-line runner

**Decision.** No ORM/migration framework. Ordered `.sql` files applied
transactionally by `runMigrations`, tracked in `schema_migrations`.
**Rationale.** SQL is reviewable in PRs; the runner is testable with a fake
query executor; zero extra dependencies.
**Tradeoff.** No DSL for common operations; migrations are Postgres-specific.

## ADR-007: In-memory event bus by default, BullMQ opt-in

**Decision.** `EventPublisher` interface with two implementations:
`InMemoryEventBus` (deterministic, sequential, records published envelopes)
and `BullMqEventPublisher` (Redis-backed, used only when `REDIS_URL` is set,
dynamically imported).
**Rationale.** Development and CI need zero infrastructure and deterministic
results; production gets a real queue later without touching call sites.
**Tradeoff.** The in-memory bus loses events on restart and retains all
envelopes in memory; fine for dev/test only by design.

## ADR-008: Policy engine as an independent package

**Decision.** `@sentinel-mesh/policy-engine` depends only on `contracts`,
exposes `PolicyEngine` as an interface, and is the only code allowed to
construct `PolicyDecision` objects.
**Rationale.** Independence is the point of a guarded-trading platform: the
decider must be swappable, testable in isolation, and impossible to bypass
because consumers only ever parse decisions produced by the engine.
**Tradeoff.** The engine cannot enrich decisions with chain state in phase
0; a future engine implementation can accept injected read-only data sources.

## ADR-009: Mock signer, deliberately not real crypto

**Decision.** `MockSigner` produces `mock-sig-<sha256>` strings and accepts
no key material. No ethers/viem/solana-web3.js dependency anywhere.
**Rationale.** Phase 0 must be un-buildable-as-a-live-trader. Removing
crypto libraries entirely removes the entire class of key-handling bugs and
keeps installs light.
**Tradeoff.** The simulation artifacts are obviously fake (intended).

## ADR-010: Single-stage Docker images

**Decision.** `docker/Dockerfile.api` and `Dockerfile.web` are single-stage
node:20-alpine images that install, build, and run.
**Rationale.** Simple, standard, hard to get wrong for a skeleton. Multi-stage
with `turbo prune` adds real complexity (dist copying across stages) that
should be introduced when images are actually exercised in CI.
**Tradeoff.** Larger images and longer cold builds; deferred deliberately.

## ADR-011 (future, explicitly NOT decided): real signing and execution

Adding real signing requires, at minimum: a dedicated ADR, a secret-management
design (vault/KMS, never env files), an audit trail for key usage, a second
independent policy review of the enforcement path, and the removal of the
schema literals from ADR-004. Nothing in phase 0 should be read as a step in
that direction; the guards exist precisely to force that conversation.

## ADR-012: Review-gated skill registry with a no-execution sandbox

**Status:** accepted (skills phase)

Skills (manifest + SKILL.md) are untrusted. The strict manifest schema
REJECTS injected keys at parse time instead of dropping them — a skill
that tries to smuggle `permissions` or `reviewStatus` fails intake loudly
(422), which is more honest and more debuggable than silently stripping.
Review status, approval, and installation are registry-controlled states
driven only by explicit human API calls; a skill can never affect them.
Sandbox checks run in `node:vm` with no host access and a hard timeout;
throwing or timing out counts as a failed check (fail closed). Skill
capabilities are bounded by a deployment allowlist that excludes all
execution-related capabilities.

## ADR-013: x402 payments verify everything and grant only content access

**Status:** accepted (payments phase)

The payment guard checks schema, chain, asset, recipient, amount, expiry
window, nonce uniqueness, and per-agent spend caps before recording
anything, and accepts settlement evidence only from allowlisted
facilitators. Grants are structural: `trading` is hard-coded `false` and
the payments package has no import path into the execution stack, so no
bug or forged payment can mint trading authority. Only a deterministic
mock facilitator is wired in; enabling a live facilitator requires an ADR
plus a config flag, and real EIP-3009 signature recovery is a documented
prerequisite for that step.

- **ADR-014 (2026-10-18): Atomic cap reservation + duplicate-in-flight semantics.**
  Guard step 5 now checks and reserves limit-cap space in one synchronous step
  (`LimitsService.evaluateAndReserve`), releasing it on later rejection; this
  closes the check-then-act race where concurrent intents could both pass caps.
  A `duplicate-submission-conflict` rejection no longer aborts the winning
  request's idempotency reservation (previously this enabled double execution).
  Reconciliation now flags duplicate execution as >1 paper-filled receipt per
  intent, so legitimate reject-then-retry flows are not false positives.
  Rationale and adversarial tests: docs/SECURITY-AUDIT.md.

- **ADR-015 (2026-10-20): Kill-switch drill executed on production (checklist item 8).**
  Ran the drill against the live orchestrator (sentinel-mesh-orchestrator.onrender.com,
  paper mode, durable Postgres journal):
  1. Baseline snapshot `global: clear`; engaged via one
     `POST /api/v1/execution/kill-switch {scope: global, state: engaged}`
     (state journaled before applied — an ENGAGED switch cannot be lost to a restart).
  2. Authorized intent `a2c74839` submitted while engaged → receipt
     `a158e0b0` **rejected `kill-switch-engaged`** (fail-closed, journaled).
  3. Duplicate resubmission of the same intent after clear → rejected
     (one decision per intent; idempotency holds).
  4. Intent for an unconfigured user → rejected `user-limit-exceeded`
     "no limit policy configured… refusing to execute" (fail-closed on missing state).
  5. Authorized demo-user intent with switch clear → **paper-filled**
     receipt `e243c82e`; normal pipeline restored.
  Also verified: `durable-state.test.ts` (journal sleep/wake regression) green 9/9
  locally; uptime pinger keeps the free-tier service warm (no mid-cycle sleeps).
  Observation, non-blocking: `/api/v1/execution/reconcile` lists receipts from
  pre-restart test runs as "orphan" because the submitted-intent-ids set is
  in-memory only (cross-check cosmetic; executor idempotency itself restores
  from Postgres). Worth durably restoring that set before EXECUTION_MODE=live.
  Operator drill recorded; global switch left **clear**.
