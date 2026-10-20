# Execution go-live checklist (executionMode: live)

Owner approved live trading on 2026-10-19; the config-level reject gate
was removed in ADR-016 (2026-10-20). Remaining unchecked items still block
the release steps below — this file remains the go-live gate.

## Hard prerequisites (code + infrastructure)
- [x] Live trade adapters implemented and tested: Base swap routing via
      Aero (formerly Aerodrome) with Uniswap V3 fallback, Jupiter v6 on
      Solana; real EVM + Solana signers behind the existing signer port.
      (2026-10-20: ADR-016, commit 0b399fa; LiveAeroUniswapTradeExecutor +
      LiveJupiterTradeExecutor behind the existing ports, suite green.)
- [x] `policyMode=enforce` implemented (limits enforced, not just evaluated).
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
1. [x] Owner confirms this checklist is satisfied and explicitly authorizes
   `EXECUTION_MODE=live` (recorded in docs/DECISIONS.md).
   (2026-10-19 approval; ADR-016 records it 2026-10-20.)
2. [x] Remove the `executionMode` refine gate in packages/config; keep
   `"disabled"` as the fail-closed default for new environments.
   (2026-10-20: done, ADR-016.)
3. Set `EXECUTION_MODE=live` (and only then) in the orchestrator service env.
4. Deploy, verify health, execute ONE minimal live trade, reconcile the
   journal entry against the onchain receipt.
5. Enable the 5-minute signal pipeline only after step 4 reconciles.

## Rollback
Set `EXECUTION_MODE=paper` (or `disabled`) and redeploy; the kill switch
plus spend caps remain effective across the rollback.
