# ADR-003: Live x402 facilitator (USDC EIP-3009 on Base)

**Status:** Accepted — 2026-10-19
**Owner decision:** Luwei approved live on-chain settlement for the x402 payment gate
(2026-10-19). The prior security sign-off gate on `paymentsMode=live` is lifted by
owner decision; the paper mode remains the default for local development and tests.

## Context

Sentinel Mesh prices its data services with x402 v1 `exactInEvm` requirements
(USDC on Base, receiver = the project wallet). Until now the facilitator was a
deterministic mock: signature strings were structurally required but never verified,
settlement was claimed rather than confirmed, and the route gate accepted payments
in `recorded` state. That is fine for demos and paper mode, but a paying agent must
not be served until the money has actually moved.

## Decision

Ship `base-usdc-facilitator-v1` (`packages/payments/src/live-facilitator.ts`),
selected by `PAYMENTS_MODE=live`:

1. **Cryptographic signature verification.** Every payment's EIP-3009
   `transferWithAuthorization` signature is verified over the EIP-712 domain
   `{ name: "USD Coin", version: "2", chainId: 8453, verifyingContract: 0x8335...02b0 }`.
   The recovered signer MUST equal `payload.from`. Tampered amounts, wrong
   signers, and malformed signatures reject with `invalid-signature`.
2. **On-chain settlement confirmation.** A record settles only after the
   facilitator confirms BOTH on the public Base RPC (`BASE_RPC_URL`):
   - `eth_getTransactionReceipt(txHash)` — mined with status `0x1`, and
   - `USDC.authorizationStates(payer, nonce) === true` — the signed authorization
     was consumed on-chain, i.e. funds actually moved.
   RPC failure surfaces as settlement failure — never as success.
3. **Server-controlled evidence.** Callers of `POST /api/v1/payments/settle`
   supply only a `transactionHash`. The evidence object the guard evaluates is
   ALWAYS produced by the server's own facilitator; caller-supplied settlement
   objects are ignored.
4. **Strict route gate in live mode.** Priced routes unlock only for records in
   `settled` state. `recorded` (signed but not yet on-chain) keeps 402ing.
   Paper mode retains the old behavior for local development.
5. **Nonce mapping.** x402 bytes32 hex nonces are used verbatim. UUID nonces
   (project fixtures) map deterministically: hex digits, dashes stripped,
   left-padded to 32 bytes. Signer and verifier share the mapping.

Nonces are now `bytes32 hex | UUID` in the contracts schema, and payment records
persist the `payer` address so settlement can be confirmed later.

## Protocol compatibility

| Layer | Version |
|---|---|
| x402 | v1 (`exactInEvm`) |
| Signature scheme | EIP-3009 `transferWithAuthorization` |
| Token | native USDC on Base `0x833589fcd6edb6e08f4c7c32d4f71b54bda02913` (6 decimals) |
| RPC | public Base HTTPS JSON-RPC (default `https://mainnet.base.org`) |

## Security properties preserved

- A settled payment still grants CONTENT ACCESS only; `grants.trading` is
  structurally false and the execution package has no dependency on payments.
- Replay resistance unchanged: EIP-3009 nonce uniqueness per payer, idempotent
  payment records, spend caps (reservations commit only on settlement).
- Facilitator allowlist unchanged: evidence with a non-allowlisted
  facilitatorId is rejected by the guard regardless of source.

## Rollback

Set `PAYMENTS_MODE=paper` (or unset). No schema migration is required; records
with a `payer` field are backward-compatible reads.

## Testing

- `packages/payments/tests/live-facilitator.test.ts` — real EIP-712 signatures
  from generated keys; tampered/wrong-signer rejection; receipt and
  authorizationStates confirmation matrix; RPC failure never yields success.
- `apps/orchestrator/tests/skills-payments.test.ts` — live-mode gate keeps
  402 for `recorded` payments; caller-supplied facilitator evidence ignored.
