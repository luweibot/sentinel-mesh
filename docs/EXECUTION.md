# Execution go-live checklist (executionMode: live)

The config schema rejects `EXECUTION_MODE=live` until every item below is
deliberately released by the platform owner. This file is the gate the
error message points to.

## Hard prerequisites (code + infrastructure)
- [ ] Live trade adapters implemented and tested: Base swap routing via
      Aero (formerly Aerodrome) with Uniswap V3 fallback, Jupiter v6 on
      Solana; real EVM + Solana signers behind the existing signer port.
- [ ] `policyMode=enforce` implemented (limits enforced, not just evaluated).
- [ ] Trading keys present ONLY in the orchestrator runtime environment
      (never in git, never in the API service, never in the frontend).
- [ ] Gas-funded wallets: Base ETH for EVM trades, SOL for Solana trades.
- [x] Durable journal: sleep/wake regression test green (state survives
      restarts; idempotency + spend caps restore from Postgres).
      (2026-10-20: durable-state.test.ts green 9/9.)
- [x] External uptime pinger so free-tier services never sleep mid-cycle.
      (2026-10-20: Sentinel Mesh Uptime Pinger workflow active.)
- [ ] Zero-trust access (Cloudflare Access or equivalent) on API + dashboard.
- [x] Kill-switch drill executed and documented: operator can halt all
      execution in one call; fail-closed on missing journal state.
      (2026-10-20: drill run on production orchestrator, ADR-015 in DECISIONS.md.)

## Release steps (in order)
1. Owner confirms this checklist is satisfied and explicitly authorizes
   `EXECUTION_MODE=live` (recorded in docs/DECISIONS.md).
2. Remove the `executionMode` refine gate in packages/config; keep
   `"disabled"` as the fail-closed default for new environments.
3. Set `EXECUTION_MODE=live` (and only then) in the orchestrator service env.
4. Deploy, verify health, execute ONE minimal live trade, reconcile the
   journal entry against the onchain receipt.
5. Enable the 5-minute signal pipeline only after step 4 reconciles.

## Rollback
Set `EXECUTION_MODE=paper` (or `disabled`) and redeploy; the kill switch
plus spend caps remain effective across the rollback.
