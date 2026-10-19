import { hashTypedData, recoverAddress } from "viem";
import type { X402Settlement } from "@sentinel-mesh/contracts";

/**
 * LIVE x402 facilitator for native USDC (EIP-3009) on Base.
 *
 * Protocol versions (see docs/ADR/ADR-003-live-x402-facilitator.md):
 *   - x402 v1 ("exactInEvm")
 *   - EIP-3009 transferWithAuthorization, signed over EIP-712
 *   - USDC domain: { name: "USD Coin", version: "2", chainId: 8453,
 *                   verifyingContract: 0x833589fCD5eDb6e08f4c7FF80ffFd34502b0 }
 *
 * A payment counts as RECEIVED only when BOTH hold:
 *   1. The EIP-712 signature recovers to the claimed payer, and
 *   2. The authorization nonce is CONSUMED on-chain (USDC
 *      authorizationStates(payer, nonce) === true) with a successful
 *      transaction receipt binding the payer's submitted tx hash.
 *
 * No private keys, no funds movement, no signature production here —
 * this adapter only VERIFIES. The payer submits transferWithAuthorization
 * themselves; we confirm receipt via a public Base RPC over HTTPS.
 */

export const LIVE_FACILITATOR_ID = "base-usdc-facilitator-v1";

export const USDC_BASE_ADDRESS = "0x833589fcd6edb6e08f4c2c6ff80ffe7fd34502b0";
export const BASE_CHAIN_ID = 8453;

const EIP3009_DOMAIN = {
  name: "USD Coin",
  version: "2",
  chainId: BASE_CHAIN_ID,
  verifyingContract: USDC_BASE_ADDRESS,
} as const;

const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/** 4-byte selector of authorizationStates(address,bytes32). */
const AUTHORIZATION_STATES_SELECTOR = "0x3f264ed9";
const EMPTY_BYTES32 = "0x" + "0".repeat(64);

export interface Eip3009PaymentPayload {
  from: string;
  to: string;
  value: string;
  nonce: string;
  validAfter: string;
  validBefore: string;
  signature: string;
}

/** Hex helpers (no ethers dependency needed). */
function to32HexAddress(address: string): string {
  const hex = address.toLowerCase().replace(/^0x/, "");
  return "0x" + hex.padStart(64, "0");
}

/** Deterministic nonce -> bytes32 mapping shared by signer and verifier. */
export function nonceToBytes32Hex(nonce: string): string {
  // Real x402 clients already send a bytes32 hex nonce.
  if (/^0x[0-9a-fA-F]{64}$/.test(nonce)) return nonce.toLowerCase();
  // UUIDs carry 16 bytes of hex payload (128 bits): strip dashes and
  // left-pad to bytes32.
  const hex = nonce.replace(/-/g, "");
  if (/^[0-9a-fA-F]{32}$/.test(hex)) return "0x" + hex.toLowerCase().padStart(64, "0");
  // Fallback for other short strings: right-padded ASCII.
  return "0x" + Buffer.from(nonce, "ascii").toString("hex").padEnd(64, "0");
}

function encodeAuthorizationStatesCall(payer: string, nonceBytes32: string): string {
  return AUTHORIZATION_STATES_SELECTOR + to32HexAddress(payer).slice(2) + nonceBytes32.slice(2);
}

/** JSON-RPC over HTTPS (Base public RPC). */
export interface RpcCaller {
  call<T = unknown>(method: string, params: unknown[]): Promise<T>;
}

export function createHttpRpcCaller(rpcUrl: string, fetchImpl: typeof fetch = fetch): RpcCaller {
  return {
    async call<T = unknown>(method: string, params: unknown[]): Promise<T> {
      const res = await fetchImpl(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`rpc http ${res.status}`);
      const body = (await res.json()) as { result?: T; error?: { message?: string } };
      if (body.error) throw new Error(body.error.message ?? "rpc error");
      return body.result as T;
    },
  };
}

export interface LiveFacilitatorClock {
  now(): Date;
}

export class LiveFacilitator {
  readonly facilitatorId = LIVE_FACILITATOR_ID;

  constructor(
    private readonly rpc: RpcCaller,
    private readonly clock: LiveFacilitatorClock = { now: () => new Date() },
  ) {}

  /**
   * Cryptographically verify the EIP-3009 transferWithAuthorization
   * signature: the recovered signer MUST equal payload.from. This proves
   * the payer authorized an exact transfer (to/value/window/nonce) —
   * it does NOT prove it happened on-chain yet (see confirmSettlement).
   */
  async verifySignature(payment: Eip3009PaymentPayload): Promise<boolean> {
    try {
      const digest = hashTypedData({
        domain: EIP3009_DOMAIN,
        types: EIP3009_TYPES,
        primaryType: "TransferWithAuthorization",
        message: {
          from: payment.from as `0x${string}`,
          to: payment.to as `0x${string}`,
          value: BigInt(payment.value),
          validAfter: BigInt(Math.floor(Date.parse(payment.validAfter) / 1000)),
          validBefore: BigInt(Math.floor(Date.parse(payment.validBefore) / 1000)),
          nonce: nonceToBytes32Hex(payment.nonce) as `0x${string}`,
        },
      });
      const recovered = await recoverAddress({ hash: digest, signature: payment.signature as `0x${string}` });
      return recovered.toLowerCase() === payment.from.toLowerCase();
    } catch {
      return false;
    }
  }

  /**
   * Confirm a payment was actually RECEIVED on Base:
   *   1. eth_getTransactionReceipt(txHash) — mined, status 0x1.
   *   2. USDC.authorizationStates(payer, nonce) === true — the signed
   *      authorization was consumed on-chain (funds moved).
   * Returns settlement evidence for the guard; never trusts the payer's
   * claim beyond the tx hash they point us at.
   */
  async confirmSettlement(input: { payer: string; nonce: string; transactionHash: string }): Promise<X402Settlement> {
    const base = {
      scheme: "exactInEvm" as const,
      network: BASE_CHAIN_ID,
      facilitatorId: this.facilitatorId,
      settledAt: this.clock.now().toISOString(),
    };
    try {
      const receipt = await this.rpc.call<{ status?: string } | null>("eth_getTransactionReceipt", [input.transactionHash]);
      if (!receipt || receipt.status !== "0x1") {
        return { ...base, payload: { success: false, error: { code: "receipt-not-found-or-failed", message: `no successful transaction ${input.transactionHash} on Base` } } };
      }
      const usedRaw = await this.rpc.call<string>("eth_call", [
        { to: USDC_BASE_ADDRESS, data: encodeAuthorizationStatesCall(input.payer, nonceToBytes32Hex(input.nonce)) },
        "latest",
      ]);
      const used = BigInt(usedRaw ?? "0x0") === 1n;
      if (!used) {
        return { ...base, payload: { success: false, error: { code: "authorization-not-consumed", message: `nonce ${input.nonce} is not yet consumed on-chain; payment not received` } } };
      }
      return { ...base, payload: { success: true, transactionHash: input.transactionHash } };
    } catch (error) {
      return { ...base, payload: { success: false, error: { code: "rpc-error", message: error instanceof Error ? error.message : "rpc call failed" } } };
    }
  }
}
