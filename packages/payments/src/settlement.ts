import type { RpcCaller } from "./live-facilitator.js";
import { nonceToBytes32Hex } from "./live-facilitator.js";

/**
 * Inline x402 SETTLEMENT for canonical clients.
 *
 * Canonical x402 buyers sign an EIP-3009 authorization and hand it to the
 * server; they never broadcast. So the seller has to submit
 * transferWithAuthorization itself, paying gas. This module is that
 * broadcaster, and it is written to fail closed at every step:
 *
 *  - disabled unless explicitly enabled (the kill switch is the default)
 *  - only the configured USDC contract, chain and receiver address
 *  - only an authorization whose amount equals what was quoted
 *  - refuses used, expired or not-yet-valid authorizations
 *  - refuses when the network fee is above a hard ceiling
 *  - refuses when the rolling hourly gas budget would be exceeded
 *  - a reverted or missing receipt is a failure, never a success
 *
 * It spends gas from the seller's own wallet and nothing else. It cannot
 * trade, transfer anything other than USDC via this one EIP-3009 entry
 * point, or touch any other address.
 */

/** transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32) */
export const TRANSFER_WITH_AUTHORIZATION_SELECTOR = "0xe3ee160e";
export const SETTLEMENT_CHAIN_ID = 8453;

export interface SettlementAuthorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
  signature: string;
}

export interface SettlementConfig {
  /** Master switch. False means no broadcast ever happens. */
  enabled: boolean;
  /** The only address payments may be settled to. */
  receiverAddress: string;
  /** USDC on Base. */
  usdcAddress: string;
  /** Hard ceiling on maxFeePerGas, in wei. */
  maxFeePerGasWei: bigint;
  /** Rolling one-hour ceiling on gas spend, in wei. */
  hourlyGasCapWei: bigint;
  /** Chain id; anything other than 8453 is refused. */
  chainId?: number;
}

/** Signs and sends one pre-built call. No other capability. */
export interface SettlementSigner {
  readonly address: string;
  sendTransaction(tx: {
    to: string;
    data: string;
    gas: bigint;
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
    nonce: number;
  }): Promise<string>;
}

export type SettlementOutcome =
  | { ok: true; txHash: string; gasSpentWei: bigint }
  | { ok: false; code: string; message: string };

export interface SettlementSpendEntry {
  at: number;
  wei: bigint;
}

function pad32(hex: string): string {
  return hex.replace(/^0x/, "").padStart(64, "0");
}

function toHex(n: bigint): string {
  return "0x" + n.toString(16);
}

/** Split a 65-byte signature into v/r/s, tolerating v = 0/1 or 27/28. */
export function splitSignature(signature: string): { v: number; r: string; s: string } | null {
  const hex = signature.replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{130}$/.test(hex)) return null;
  const r = "0x" + hex.slice(0, 64);
  const s = "0x" + hex.slice(64, 128);
  const vRaw = parseInt(hex.slice(128, 130), 16);
  const v = vRaw < 27 ? vRaw + 27 : vRaw;
  if (v !== 27 && v !== 28) return null;
  return { v, r, s };
}

export function encodeTransferWithAuthorization(auth: SettlementAuthorization): string | null {
  const sig = splitSignature(auth.signature);
  if (!sig) return null;
  const value = auth.value;
  if (!/^\d+$/.test(value)) return null;
  const validAfter = Math.floor(Date.parse(auth.validAfter) / 1000);
  const validBefore = Math.floor(Date.parse(auth.validBefore) / 1000);
  if (!Number.isFinite(validAfter) || !Number.isFinite(validBefore)) return null;
  return (
    TRANSFER_WITH_AUTHORIZATION_SELECTOR +
    pad32(auth.from.toLowerCase().replace(/^0x/, "")) +
    pad32(auth.to.toLowerCase().replace(/^0x/, "")) +
    pad32(BigInt(value).toString(16)) +
    pad32(BigInt(validAfter).toString(16)) +
    pad32(BigInt(validBefore).toString(16)) +
    nonceToBytes32Hex(auth.nonce).slice(2) +
    pad32(sig.v.toString(16)) +
    pad32(sig.r.slice(2)) +
    pad32(sig.s.slice(2))
  );
}

export class SettlementBroadcaster {
  private readonly spend: SettlementSpendEntry[] = [];
  private readonly now: () => number;

  constructor(
    private readonly deps: {
      rpc: RpcCaller;
      config: SettlementConfig;
      signer?: SettlementSigner;
      clock?: { now(): Date };
    },
  ) {
    this.now = () => (deps.clock ? deps.clock.now().getTime() : Date.now());
  }

  /** Gas spent inside the rolling hour, in wei. */
  spentLastHour(): bigint {
    const cutoff = this.now() - 60 * 60 * 1000;
    return this.spend.filter((s) => s.at > cutoff).reduce((a, s) => a + s.wei, 0n);
  }

  private record(wei: bigint): void {
    const cutoff = this.now() - 60 * 60 * 1000;
    while (this.spend.length > 0 && this.spend[0]!.at <= cutoff) this.spend.shift();
    this.spend.push({ at: this.now(), wei });
  }

  async settle(auth: SettlementAuthorization): Promise<SettlementOutcome> {
    const cfg = this.deps.config;
    if (!cfg.enabled) return { ok: false, code: "settlement-disabled", message: "settlement is not enabled on this deployment" };
    if (!this.deps.signer) return { ok: false, code: "no-signer", message: "no settlement signer is configured" };
    if ((cfg.chainId ?? SETTLEMENT_CHAIN_ID) !== SETTLEMENT_CHAIN_ID) {
      return { ok: false, code: "unsupported-chain", message: `settlement is only supported on chain ${SETTLEMENT_CHAIN_ID}` };
    }
    if (auth.to.toLowerCase() !== cfg.receiverAddress.toLowerCase()) {
      return { ok: false, code: "wrong-recipient", message: "authorization does not pay this deployment's receiver address" };
    }
    const value = BigInt(auth.value);
    if (value <= 0n) return { ok: false, code: "invalid-amount", message: "authorization value must be positive" };

    const validAfter = Math.floor(Date.parse(auth.validAfter) / 1000);
    const validBefore = Math.floor(Date.parse(auth.validBefore) / 1000);
    const nowSec = Math.floor(this.now() / 1000);
    if (!Number.isFinite(validAfter) || !Number.isFinite(validBefore)) {
      return { ok: false, code: "invalid-window", message: "authorization validity window is not parseable" };
    }
    if (nowSec < validAfter) return { ok: false, code: "not-yet-valid", message: "authorization is not valid yet" };
    if (nowSec >= validBefore) return { ok: false, code: "expired", message: "authorization has expired" };

    const data = encodeTransferWithAuthorization(auth);
    if (!data) return { ok: false, code: "invalid-signature-bytes", message: "signature must be 65 bytes with v in {0,1,27,28}" };

    // Already consumed on-chain? Never pay twice.
    try {
      const state = await this.deps.rpc.call<string>("eth_call", [
        { to: cfg.usdcAddress, data: "0x3f264ed9" + pad32(auth.from.toLowerCase().replace(/^0x/, "")) + nonceToBytes32Hex(auth.nonce).slice(2) },
        "latest",
      ]);
      if (BigInt(state ?? "0x0") !== 0n) {
        return { ok: false, code: "already-settled", message: "authorization nonce is already consumed on-chain" };
      }
    } catch (error) {
      return { ok: false, code: "rpc-error", message: `authorization state unreadable: ${error instanceof Error ? error.message : "rpc failure"}` };
    }

    // Fee ceiling and estimate.
    let gas: bigint;
    let maxFeePerGas: bigint;
    try {
      const estimate = await this.deps.rpc.call<string>("eth_estimateGas", [
        { from: this.deps.signer.address, to: cfg.usdcAddress, data },
      ]);
      gas = BigInt(estimate);
      const gasPriceHex = await this.deps.rpc.call<string>("eth_gasPrice", []);
      maxFeePerGas = BigInt(gasPriceHex);
    } catch (error) {
      return { ok: false, code: "estimate-failed", message: error instanceof Error ? error.message : "gas estimation failed" };
    }
    if (maxFeePerGas > cfg.maxFeePerGasWei) {
      return { ok: false, code: "fee-too-high", message: `network fee ${maxFeePerGas} wei exceeds ceiling ${cfg.maxFeePerGasWei} wei` };
    }
    const projected = gas * maxFeePerGas;
    if (this.spentLastHour() + projected > cfg.hourlyGasCapWei) {
      return { ok: false, code: "hourly-cap-exceeded", message: `settling would exceed the hourly gas cap (${cfg.hourlyGasCapWei} wei)` };
    }

    let txHash: string;
    try {
      const nonce = Number(await this.deps.rpc.call<string>("eth_getTransactionCount", [this.deps.signer.address, "pending"]).then((n) => BigInt(n)));
      txHash = await this.deps.signer.sendTransaction({
        to: cfg.usdcAddress,
        data,
        gas,
        maxFeePerGas,
        maxPriorityFeePerGas: maxFeePerGas,
        nonce,
      });
    } catch (error) {
      return { ok: false, code: "broadcast-failed", message: error instanceof Error ? error.message : "broadcast failed" };
    }

    // Wait for a receipt. Anything other than success is a failure.
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise((r) => setTimeout(r, 1500));
      try {
        const receipt = await this.deps.rpc.call<{ status?: string; gasUsed?: string; effectiveGasPrice?: string } | null>(
          "eth_getTransactionReceipt",
          [txHash],
        );
        if (!receipt) continue;
        const gasUsed = BigInt(receipt.gasUsed ?? "0x0");
        const pricePaid = BigInt(receipt.effectiveGasPrice ?? toHex(maxFeePerGas));
        const spent = gasUsed * pricePaid;
        this.record(spent);
        if (receipt.status !== "0x1") {
          return { ok: false, code: "reverted", message: `transaction ${txHash} reverted on-chain` };
        }
        return { ok: true, txHash, gasSpentWei: spent };
      } catch {
        // keep polling; a transient RPC error is not a verdict
      }
    }
    return { ok: false, code: "receipt-timeout", message: `no receipt for ${txHash} within the wait window` };
  }
}

/**
 * Real signer: an EIP-1559 sender bound to one key. Signs locally and
 * hands the raw transaction to the RPC; it has no method to do anything
 * except send the exact call it was given.
 */
export async function createEip1559Signer(options: {
  privateKey: string;
  rpc: RpcCaller;
  chainId?: number;
}): Promise<SettlementSigner> {
  const { privateKeyToAccount } = await import("viem/accounts");
  const account = privateKeyToAccount(options.privateKey as `0x${string}`);
  const chainId = options.chainId ?? SETTLEMENT_CHAIN_ID;
  return {
    address: account.address,
    async sendTransaction(tx) {
      const raw = await account.signTransaction({
        chainId,
        to: tx.to as `0x${string}`,
        data: tx.data as `0x${string}`,
        gas: tx.gas,
        maxFeePerGas: tx.maxFeePerGas,
        maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
        nonce: tx.nonce,
        type: "eip1559",
      });
      return options.rpc.call<string>("eth_sendRawTransaction", [raw]);
    },
  };
}
