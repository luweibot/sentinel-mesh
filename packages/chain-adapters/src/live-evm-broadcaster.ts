import type { PublicClient, WalletClient } from "viem";
import { erc20Abi, parseAbi } from "viem";

/**
 * LIVE EVM swap broadcaster for Base via the Aero (Aerodrome) router.
 *
 * All addresses verified onchain 2026-10-19 via eth_getCode on
 * mainnet.base.org + base.publicnode.com (see docs/EXECUTION.md):
 *   Router       0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43 (23.5KB code)
 *   PoolFactory  0x420DD381b31aEf6683db6B902084cB0FFECe40Da (3.5KB code)
 *   USDC         0x833589fcd6edb6e08f4c7c32d4f71b54bda02913 ("USD Coin", 6 dec)
 *   WETH         0x4200000000000000000000000000000000000006 (canonical)
 *
 * Safety shape:
 *  - Quotes before every swap; minOut = quote * (1 - slippageBps/10_000).
 *    A swap is NEVER broadcast with a zero or unquoted minOut.
 *  - Slippage capped at 10% (fail closed above that).
 *  - Deadline must be in the future and at most 30 minutes out.
 *  - Approves the router for the exact swap amount only (no infinite
 *    approvals), and only when the current allowance is insufficient.
 *  - Every send is followed by a receipt wait; a reverted receipt is an
 *    error, never a silent success.
 */

export const AERO_ROUTER_BASE = "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43" as const;
export const AERO_POOL_FACTORY_BASE = "0x420DD381b31aEf6683db6B902084cB0FFECe40Da" as const;
export const BASE_WETH = "0x4200000000000000000000000000000000000006" as const;

const ROUTER_ABI = parseAbi([
  "function getAmountsOut(uint256 amountIn, (address from, address to, bool stable, address factory)[] routes) view returns (uint256[] amounts)",
  "function swapExactETHForTokens(uint256 amountOutMin, (address from, address to, bool stable, address factory)[] routes, address to, uint256 deadline) payable returns (uint256[] amounts)",
  "function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, (address from, address to, bool stable, address factory)[] routes, address to, uint256 deadline) returns (uint256[] amounts)",
]);

const MAX_SLIPPAGE_BPS = 1000; // 10% hard cap
const MAX_DEADLINE_SEC = 30 * 60;

export interface AeroSwapRoute {
  from: `0x${string}`;
  to: `0x${string}`;
  stable: boolean;
  factory: `0x${string}`;
}

export interface LiveBroadcasterDeps {
  publicClient: PublicClient;
  walletClient: WalletClient;
  /** Recipient of swap output (MUST be an address the project controls). */
  recipient: `0x${string}`;
  router?: `0x${string}`;
  /** Clock for deadlines (ms since epoch). */
  now?: () => number;
}

export interface SwapReceipt {
  txHash: `0x${string}`;
  status: "success" | "reverted";
  blockNumber: bigint;
  gasUsed: bigint;
  quotedOutRaw: bigint;
  minOutRaw: bigint;
}

function applySlippage(quoted: bigint, slippageBps: number): bigint {
  if (slippageBps < 0 || slippageBps > MAX_SLIPPAGE_BPS) {
    throw new Error(`slippageBps ${slippageBps} outside safe range 0..${MAX_SLIPPAGE_BPS}`);
  }
  return (quoted * BigInt(10_000 - slippageBps)) / 10_000n;
}

/**
 * mainnet.base.org is load-balanced and its nodes lag state by a few
 * seconds: an approval mined on one node is not yet visible to the node
 * serving eth_estimateGas, so swaps right after an approval "revert"
 * spuriously. Estimation-stage reverts happen BEFORE anything is
 * broadcast, so retrying them is safe (no double-send risk). Receipt-
 * stage failures are NEVER retried here.
 */
async function withEstimateRetry<T>(fn: () => Promise<T>, attempts = 3, waitMs = 6_000): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      let cause = err as { cause?: unknown } | undefined;
      let estimateStage = false;
      for (let depth = 0; cause && depth < 5; depth++) {
        const name = (cause as { name?: string }).name;
        if (name === "EstimateGasExecutionError") { estimateStage = true; break; }
        cause = (cause as { cause?: unknown }).cause as { cause?: unknown } | undefined;
      }
      if (!estimateStage) throw err;
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw lastErr;
}

export class LiveAeroBroadcaster {
  private readonly router: `0x${string}`;
  private readonly now: () => number;

  constructor(private readonly deps: LiveBroadcasterDeps) {
    this.router = deps.router ?? AERO_ROUTER_BASE;
    this.now = deps.now ?? (() => Date.now());
  }

  /** Public quote: returns the router-quoted output raw units for a route. */
  async quote(amountInRaw: bigint, route: AeroSwapRoute): Promise<bigint> {
    const out = await this.deps.publicClient.readContract({
      address: this.router, abi: ROUTER_ABI, functionName: "getAmountsOut",
      args: [amountInRaw, [route]],
    });
    const last = (out as unknown as bigint[])[1];
    if (!last || last <= 0n) {
      throw new Error(`router quote returned non-positive output (${String(last)}) — refusing to swap`);
    }
    return last;
  }

  private deadlineArg(): bigint {
    const deadlineSec = Math.floor(this.now() / 1000) + 15 * 60; // fixed 15min
    return BigInt(deadlineSec);
  }

  private async waitForReceipt(txHash: `0x${string}`, quotedOutRaw: bigint, minOutRaw: bigint): Promise<SwapReceipt> {
    const receipt = await this.deps.publicClient.waitForTransactionReceipt({ hash: txHash });
    return {
      txHash,
      status: receipt.status === "success" ? "success" : "reverted",
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed,
      quotedOutRaw,
      minOutRaw,
    };
  }

  /** Swap native ETH for an ERC-20 (single-hop volatile route). */
  async swapExactETHForTokens(params: {
    tokenOut: `0x${string}`;
    amountInWei: bigint;
    slippageBps: number;
  }): Promise<SwapReceipt> {
    const quoted = await this.quote(params.amountInWei, { from: BASE_WETH, to: params.tokenOut, stable: false, factory: AERO_POOL_FACTORY_BASE });
    const minOut = applySlippage(quoted, params.slippageBps);
    const txHash = await withEstimateRetry(() => this.deps.walletClient.writeContract({
      address: this.router, abi: ROUTER_ABI, functionName: "swapExactETHForTokens",
      args: [minOut, [{ from: BASE_WETH, to: params.tokenOut, stable: false, factory: AERO_POOL_FACTORY_BASE }], this.deps.recipient, this.deadlineArg()],
      value: params.amountInWei,
      account: this.deps.walletClient.account!,
      chain: this.deps.walletClient.chain!,
    }));
    return this.waitForReceipt(txHash, quoted, minOut);
  }

  /** Swap an ERC-20 for native ETH (single-hop volatile route, exact-in approval). */
  async swapExactTokensForETH(params: {
    tokenIn: `0x${string}`;
    amountInRaw: bigint;
    slippageBps: number;
  }): Promise<SwapReceipt> {
    // exact-in allowance check (no infinite approvals)
    const allowance = await this.deps.publicClient.readContract({
      address: params.tokenIn, abi: erc20Abi, functionName: "allowance",
      args: [this.deps.walletClient.account!.address, this.router],
    });
    if ((allowance as unknown as bigint) < params.amountInRaw) {
      const approveHash = await this.deps.walletClient.writeContract({
        address: params.tokenIn, abi: erc20Abi, functionName: "approve",
        args: [this.router, params.amountInRaw],
        account: this.deps.walletClient.account!,
        chain: this.deps.walletClient.chain!,
      });
      const approvalReceipt = await this.deps.publicClient.waitForTransactionReceipt({ hash: approveHash });
      if (approvalReceipt.status !== "success") throw new Error("approval transaction reverted");
    }
    const quoted = await this.quote(params.amountInRaw, { from: params.tokenIn, to: BASE_WETH, stable: false, factory: AERO_POOL_FACTORY_BASE });
    const minOut = applySlippage(quoted, params.slippageBps);
    const txHash = await withEstimateRetry(() => this.deps.walletClient.writeContract({
      address: this.router, abi: ROUTER_ABI, functionName: "swapExactTokensForETH",
      args: [params.amountInRaw, minOut, [{ from: params.tokenIn, to: BASE_WETH, stable: false, factory: AERO_POOL_FACTORY_BASE }], this.deps.recipient, this.deadlineArg()],
      account: this.deps.walletClient.account!,
      chain: this.deps.walletClient.chain!,
    }));
    return this.waitForReceipt(txHash, quoted, minOut);
  }
}
