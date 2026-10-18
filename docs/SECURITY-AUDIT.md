# Security Audit & Release Readiness Report — 2026-10-18

Independent security review of the Sentinel Mesh repository at the
post-dashboard-build state. Scope: all 13 packages, 3 apps, API routes,
event consumers, the signer boundary, EVM/Solana transaction handling,
the x402 payment guard, the skill runtime, migrations, and deployment
configuration. Every claim below was verified against the code and, where
possible, against executable tests.

**Verdict:** the codebase is a paper-only research/decision mesh and is
**not production-ready for live trading**. Two exploitable race conditions
were found and fixed (with regression tests); the remaining gaps are
deployment controls and deliberately unimplemented live-signing
capability. Live trading additionally requires independent security
sign-off per docs/EXECUTION.md, which this report does not constitute.

## Methodology

- Full `pnpm build`, `pnpm lint`, `pnpm test` (17/17 files, 253 tests), `pnpm audit --prod`.
- Manual code review of trust boundaries: HTTP surface, event bus, authorization mint/consume, idempotency, limits, payments, skills sandbox.
- Adversarial test authoring: two regression tests written against the pre-fix code, confirmed failing (reproducing each race), then re-verified green after remediation.

## Findings (prioritized)

### 1. HIGH — Double-execution race via duplicate-rejection abort (FIXED)

- **Files:** `packages/execution/src/executor.ts` (catch block), `packages/execution/src/safety.ts` (`IdempotencyRegistry.abort`).
- **Evidence:** on `duplicate-submission-conflict` (a concurrent identical intent already in flight), the catch path called `idempotency.abort(intentId, hash)`, deleting the *winning* request's in-flight reservation. A third identical submission then passed `begin()` and executed the same intent a second time.
- **Reproduction:** regression test in `packages/execution/tests/execution.test.ts` ("a rejected concurrent duplicate cannot unlock a third submission"). Pre-fix: third receipt came back `paper-filled`; ledger held two fills for one intentId.
- **Fix:** the catch block no longer aborts the idempotency reservation when the rejection code is `duplicate-submission-conflict` (the entry belongs to the race winner). Unknown errors still abort.
- **Retest:** regression test green; only one paper-filled receipt for the intent; reconciliation reports no duplicates.

### 2. HIGH — Limit caps bypass via check-then-act race (FIXED)

- **Files:** `packages/execution/src/executor.ts` (step 5 vs step 10), `packages/execution/src/limits.ts`.
- **Evidence:** caps were evaluated at guard step 5 but the fill was only recorded at step 10, with `await` points (liquidity, simulation, signing) in between. Two concurrent intents both observed pre-fill state, both passed the open-position/exposure cap, then both filled — aggregate position exceeding the cap.
- **Reproduction:** regression test ("two concurrent intents cannot both pass the open-position cap"). Pre-fix: two `paper-filled` receipts, open position 120% of the cap.
- **Fix:** `LimitsService.evaluateAndReserve()` checks and records the fill in one synchronous step (atomic in the single-threaded runtime); the executor reserves at guard step 5 and releases the reservation on any later rejection (`releaseReservation`). A rejected intent no longer permanently consumes cap space.
- **Retest:** regression test green; second intent rejected `position-cap-exceeded`; open position never exceeds the cap.

### 3. HIGH — Dependency vulnerabilities: 2 critical RCEs (FIXED)

- **Evidence:** `pnpm audit --prod` found 37 advisories, including two critical Next.js RCEs (Image Optimization API; `next@14.2.35`), a fastify Content-Type body-validation bypass (`fastify@4.29.1`, patched 5.12.2), and PostCSS arbitrary-file-read/path-traversal.
- **Fix:** `next` → 15.5.24 with React 19 (web), `fastify` → ^5.12.2 (api, orchestrator), `postcss` override ^8.5.6. Runtime smoke tests re-run on the upgraded stack (orchestrator, api, web all healthy; 253 tests green).
- **Retest:** `pnpm audit --prod` → **0 known vulnerabilities**. Note: `postcss` override uses a caret range; the lockfile pins a patched version, re-audit after any lockfile regeneration.

### 4. HIGH — Deployment configuration broken (FIXED)

- **Files:** `docker-compose.yml`.
- **Evidence:** compose set `EXECUTION_MODE: simulation`, which the config schema rejects (`disabled|paper|live` only) — the api container would crash-loop; the orchestrator service was absent from the deployment entirely, so skills/payments/execution endpoints were unreachable; the web container lacked `NEXT_PUBLIC_ORCHESTRATOR_BASE_URL`.
- **Fix:** `EXECUTION_MODE: paper` in both services (explicit opt-in), orchestrator service added with its own Dockerfile (`docker/Dockerfile.orchestrator`, migrate-then-serve), web env wired.
- **Retest:** config schema accepts every value compose now sets; build green.

### 5. MEDIUM — Unauthenticated, unrate-limited HTTP surface (OPEN — deployment control)

- **Evidence:** no auth on any route in `apps/api` or `apps/orchestrator`; no rate limiting; servers bind all interfaces. Anyone with network reach can issue tasks/signals (unbounded in-memory growth), approve skills, mint authorizations, and engage the kill switch.
- **Risk today:** low (paper-only, mock data), but it is a hard go-live blocker: the same surface would control real trading authority.
- **Required before production:** an authenticating reverse proxy or gateway (mTLS/OIDC) in front of both services; per-principal rate limits; bind services to a private network (compose currently publishes 3000/3001/3002 and Postgres 5432 / Redis 6379 to the host).

### 6. MEDIUM — Skill sandbox uses `node:vm` (OPEN — defense in depth)

- **Files:** `packages/skills/src/sandbox.ts`.
- **Evidence:** check expressions are untrusted code run via `vm.runInNewContext` with a frozen, data-only sandbox, a 50 ms timeout, and no host objects passed in. Node documents that `vm` is not a hard security boundary; a leak of any host object into the context would enable escape.
- **Current posture:** safe under present usage (only `structuredClone`-ed JSON and strings enter the context); approval still requires a human; capabilities are allowlisted and exclude execution.
- **Required before opening skill submission to untrusted parties:** move evaluation into an out-of-process sandbox (child process with dropped privileges / seccomp, or `isolated-vm`), and keep the lexical injection scan as defense in depth only (it is trivially bypassable and must never be the sole control).

### 7. MEDIUM — x402 signature verification unimplemented (OPEN — documented, fixture-only)

- **Files:** `packages/payments/src/guard.ts`, `docs/X402.md`.
- **Evidence:** the guard verifies requirement/payload schema, exact amount, recipient allowlist, chain/asset allowlists, expiry windows, nonce replay resistance, idempotency, spend caps, and facilitator-allowlisted settlement evidence — but does NOT cryptographically recover/verify the EIP-3009 authorization signature (documented in docs/X402.md; only the in-repo deterministic mock facilitator exists). Payment grants structurally cannot mint trading authority (`grants.trading` hard-coded false; no import path into the execution stack — verified).
- **Required before real x402:** EIP-712 `transferWithAuthorization` signature recovery against a documented x402 SDK version, real facilitator allowlist decisions, and on-chain settlement verification.

### 8. LOW — Deployment secrets are development defaults (OPEN — deployment control)

- **Evidence:** compose defaults Postgres to `sentinel:sentinel` and publishes 5432/6379 to the host; Redis has no auth. `.env` is gitignored (verified) and `.env.example` contains placeholders only; a repo-wide grep found no private keys or API keys anywhere in source.
- **Required before production:** real credentials from a secret manager, no host-published data stores, Redis auth/TLS.

### 9. LOW — Reconciliation duplicate semantics (FIXED as a side effect)

- `ReconciliationLedger.reconcile()` previously flagged any intent with more than one receipt; legitimate rejected-then-retried intents produced false positives. Duplicate execution is now detected as **more than one paper-filled receipt per intent**; orphan and missing-receipt checks unchanged.

### 10. INFORMATIONAL — Verified-clean areas

- **Signer boundary:** agents receive only `ExecutionPort`; the signer is a narrow outbound-only mock port obtained solely by the executor; no key material exists in the repo (test-enforced).
- **Authorization:** exact canonical-hash binding (all intent fields), 60 s TTL, single-use, store-checked lifecycle, fail-closed on every mismatch — no parameter substitution path found.
- **Transaction parameter substitution:** intent hash covers chain, tokens, amounts, min-out, fee, impact, deadline; adapters additionally enforce chain-specific rules; `minAmountOutRaw` and simulated output are checked against the authorization-bound intent.
- **Replay:** authorizations single-use with consumed/revoked states checked against the store of record; payment nonces globally unique per process; idempotency ledger replays prior receipts for completed intents; event consumers dedupe by (consumer, eventId) with an at-most-once claim before side effects.
- **Tenant isolation:** not yet applicable — no multi-tenant authN exists yet (see finding 5); paper runs are per-process. Flagged for the go-live design.
- **SQL:** all queries parameterized; migrations are static SQL; no string interpolation into queries found.
- **SSRF:** no outbound HTTP from user-controlled URLs anywhere in the runtime; research documents are deterministic fixtures; chain adapters are mock.
- **Prompt injection:** agents are deterministic code (no LLM); fixture document text is sanitized and flagged as quarantined untrusted content; skill SKILL.md is hash-pinned, scanned, never executed, and cannot self-grant capabilities (strict manifest schema rejects injected keys; capability allowlist excludes execution).
- **Unsafe approvals:** no approval, allowance, or broadcast code exists in the repo.
- **Stale evidence:** research evidence carries provenance and timestamps; settlement evidence is facilitator-verified; settlement records are only accepted for requirements matching a recorded payment (amount/asset/recipient/chain equality).

## Production-readiness request list (owner actions)

1. **Reverse proxy + authN**: provide the TLS terminator / OIDC provider and the allowed principal list for dashboard + API access.
2. **Infrastructure credentials**: real Postgres/Redis credentials via a secret manager; confirm services must not publish ports to the host.
3. **Decision**: keep `EXECUTION_MODE=paper` in production until the docs/EXECUTION.md go-live checklist is independently signed off.
4. **Later phases**: KMS/HSM signer design, real x402 SDK + facilitator allowlist, out-of-process skill sandbox — none of these can be papered over by config.

## Bottom line

Code-level audit actions are complete: both exploitable races fixed with regression tests, all dependency advisories cleared, deployment config repaired, full suite green (17/17 files, 253 tests, lint clean, build clean, runtime smoke healthy). What remains are deployment controls and the deliberate live-trading capabilities the platform intentionally does not implement. **Live trading remains NOT production-ready and requires independent security sign-off.**
