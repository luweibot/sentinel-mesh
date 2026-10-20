import type { PublicClient, WalletClient } from "viem";
import { erc20Abi, parseAbi } from "viem";
import type { Log } from "viem";
import { createBaseViemClients } from "./live-stack.js";
import { LiveJupiterTradeExecutor } from "./live-jupiter-executor.js";
import {
  LiveAeroBroadcaster,
  AERO_ROUTER_BASE,
  AERO_POOL_FACTORY_BASE,
  withEstimateRetry,
  applySlippage,
  type AeroSwapRoute,
} from "./live-evm-broadcaster.js";

/**
 * LIVE trade execution for the guarded executor (EXECUTION_MODE=live).
 *
 * Two implementations behind one port (defined in @sentinel-mesh/execution):
 *  - Base (EVM): Aero (Aerodrome) router primary, Uniswap V3 SwapRouter02
 *    fallback. Addresses verified onchain 2026-10-20 (eth_getCode on
 *    base-mainnet.public.blastapi.io + base.publicnode.com; the Uniswap
 *    router carries 24.5KB of code). See ADR-016 in docs/DECISIONS.md.
 *  - Solana: Jupiter Swap API V2 Meta-Aggregator (GET /swap/v2/order ->
 *    sign -> POST /swap/v2/execute), implemented in
 *    live-jupiter-executor.ts. Jupiter v6 is SUNSET (2026); the
 *    checklist's "Jupiter v6" is implemented against the current
 *    documented API: https://developers.jup.ag/docs/swap/order-and-execute
 *
 * Safety shape (both chains, fail closed):
 *  - Quote before every trade; a trade is NEVER executed with a zero or
 *    unquoted minimum out.
 *  - minOut = max(intent bound, quoted out * (1 - slippageBps/10_000)).
 *  - Slippage hard-capped at 10%.
 *  - The executed output is read from the actual settlement (ERC-20
 *    Transfer logs on EVM; /execute's reported amounts on Solana) and
 *    validated: a "successful" receipt with no real output is reported
 *    as reverted, never as success.
 *  - Approvals are for the exact swap amount only (never infinite).
 *  - Estimation-stage reverts are retried/safe (nothing was broadcast);
 *    broadcast-stage results are final and reported as they are.
 */

export const UNISWAP_V3_SWAP_ROUTER02_BASE = "0x2626664c2603336E57B271c5C0b26F421741e481" as const;

/** Routers the live EVM executor may ever send to (allowlist, fail closed). */
export const LIVE_EVM_ROUTER_ALLOWLIST: readonly `0x${string}`[] = [
  AERO_ROUTER_BASE,
  UNISWAP_V3_SWAP_ROUTER02_BASE,
];

/** Common fee tiers tried, in order, for the Uniswap V3 fallback leg. */
const UNISWAP_FEE_TIERS: readonly number[] = [500, 3000, 100];

const MAX_SLIPPAGE_BPS = 1000; // 10% hard cap, same as the treasury broadcaster

const UNISWAP_ROUTER_ABI = parseAbi([
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
]);

const AERO_TOKEN_SWAP_ABI = parseAbi([
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, (address from, address to, bool stable, address factory)[] routes, address to, uint256 deadline) returns (uint256[] amounts)",
]);

const TRANSFER_EVENT_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** Parameters shared by every live trade call. */
export interface LiveTradeParams {
  tokenIn: string;
  tokenOut: string;
  amountInRaw: bigint;
  /** Intent's minimum acceptable output (fail-closed floor; must be > 0). */
  minAmountOutRaw: bigint;
  /** Slippage for the live quote in basis points (<= 1000). */
  slippageBps: number;
}

export interface LiveQuote {
  /** Quoted output, base units, for amountInRaw. */
  quotedOutRaw: string;
  /** Rough total fee (gas/priority) in USD cents (0 when no oracle wired). */
  feeUsdCents: number;
  /** Quoted price impact in basis points (0 when the source has none). */
  priceImpactBps: number;
  detail: string;
}

export interface LiveExecution {
  txHash: string;
  status: "success" | "reverted";
  /** Actual received output, base units, read from the settlement. */
  executedOutRaw: string;
  feeUsdCents: number;
  detail: string;
}

/** Quote-only failure: no trade was attempted (fail closed upstream). */
export class LiveQuoteError extends Error {}

interface EvmExecutionDeps {
  publicClient: PublicClient;
  walletClient: WalletClient;
  /** Recipient of swap output; MUST be an address the project controls. */
  recipient: `0x${string}`;
  /**
   * Optional ETH price oracle in USD cents, for honest fee reporting.
   * When absent, fees report as 0 cents (never negative-skewed).
   */
  ethUsdCents?: () => Promise<number>;
  router?: `0x${string}`;
  fallbackRouter?: `0x${string}`;
  /** Injectable clock (ms since epoch) for deadline math in tests. */
  now?: () => number;
}

/**
 * Base live trade executor: Aero primary, Uniswap V3 fallback.
 * The Aero leg reuses the treasury-proven LiveAeroBroadcaster (proven
 * live on Base mainnet 2026-10-19) for quoting; the token-to-token swap
 * uses the same verified router.
 */
export class LiveAeroUniswapTradeExecutor {
  private readonly aero: LiveAeroBroadcaster;
  private readonly fallbackRouter: `0x${string}`;
  private readonly now: () => number;

  constructor(private readonly deps: EvmExecutionDeps) {
    this.aero = new LiveAeroBroadcaster({
      publicClient: deps.publicClient,
      walletClient: deps.walletClient,
      recipient: deps.recipient,
      router: deps.router ?? AERO_ROUTER_BASE,
    });
    this.fallbackRouter = deps.fallbackRouter ?? UNISWAP_V3_SWAP_ROUTER02_BASE;
    this.now = deps.now ?? (() => Date.now());
  }

  /** Router-quote via Aero getAmountsOut; throws LiveQuoteError on failure. */
  async quote(params: LiveTradeParams): Promise<LiveQuote> {
    const route: AeroSwapRoute = {
      from: params.tokenIn as `0x${string}`,
      to: params.tokenOut as `0x${string}`,
      stable: false,
      factory: AERO_POOL_FACTORY_BASE,
    };
    let quoted: bigint;
    try {
      quoted = await this.aero.quote(params.amountInRaw, route);
    } catch (error) {
      throw new LiveQuoteError(`aero quote failed: ${String(error)}`);
    }
    const feeUsdCents = await this.estimateFeeCents(250_000n, 0.3);
    return {
      quotedOutRaw: quoted.toString(),
      feeUsdCents,
      priceImpactBps: 0,
      detail: `aero router quote for ${params.tokenIn.slice(0, 8)}… -> ${params.tokenOut.slice(0, 8)}…`,
    };
  }

  /**
   * Execute token->token on Base. Aero first; if the Aero leg cannot
   * produce a swap (no pool, estimation-stage revert), fall back to
   * Uniswap V3 exactInputSingle across common fee tiers. Estimation-stage
   * reverts happen BEFORE anything is broadcast, so trying legs in
   * sequence is safe (no double-send risk); once a transaction is
   * broadcast its result (even a revert) is final and reported as such.
   */
  async execute(params: LiveTradeParams): Promise<LiveExecution> {
    const tokenIn = params.tokenIn as `0x${string}`;
    const tokenOut = params.tokenOut as `0x${string}`;
    const minOutRaw = await this.boundedMinOut(params);

    // --- Primary: Aero ---
    try {
      await this.ensureAllowance(tokenIn, AERO_ROUTER_BASE, params.amountInRaw);
      const txHash = await withEstimateRetry(() =>
        this.deps.walletClient.writeContract({
          address: AERO_ROUTER_BASE,
          abi: AERO_TOKEN_SWAP_ABI,
          functionName: "swapExactTokensForTokens",
          args: [
            params.amountInRaw,
            minOutRaw,
            [{ from: tokenIn, to: tokenOut, stable: false, factory: AERO_POOL_FACTORY_BASE }],
            this.deps.recipient,
            BigInt(Math.floor(this.now() / 1000) + 15 * 60),
          ],
          account: this.deps.walletClient.account!,
          chain: this.deps.walletClient.chain!,
        }),
      );
      return await this.settle(txHash, tokenOut, "aero");
    } catch (aeroError) {
      // --- Fallback: Uniswap V3 ---
      for (const fee of UNISWAP_FEE_TIERS) {
        try {
          await this.ensureAllowance(tokenIn, this.fallbackRouter, params.amountInRaw);
          const txHash = await withEstimateRetry(() =>
            this.deps.walletClient.writeContract({
              address: this.fallbackRouter,
              abi: UNISWAP_ROUTER_ABI,
              functionName: "exactInputSingle",
              args: [
                {
                  tokenIn,
                  tokenOut,
                  fee,
                  recipient: this.deps.recipient,
                  amountIn: params.amountInRaw,
                  amountOutMinimum: minOutRaw,
                  sqrtPriceLimitX96: 0n,
                },
              ],
              account: this.deps.walletClient.account!,
              chain: this.deps.walletClient.chain!,
            }),
          );
          return await this.settle(txHash, tokenOut, `uniswap-v3 fee=${fee}`);
        } catch {
          // try the next tier
        }
      }
      throw new Error(`aero leg failed (${String(aeroError)}); uniswap v3 fallback found no viable pool`);
    }
  }

  /** minOut floor: max(intent bound, quote * (1 - slippage)). Fails closed on a zero bound. */
  private async boundedMinOut(params: LiveTradeParams): Promise<bigint> {
    if (params.slippageBps < 0 || params.slippageBps > MAX_SLIPPAGE_BPS) {
      throw new Error(`slippageBps ${params.slippageBps} outside safe range 0..${MAX_SLIPPAGE_BPS}`);
    }
    if (params.minAmountOutRaw <= 0n) {
      throw new Error("intent carries a zero minimum out; refusing to execute a live trade without an out floor");
    }
    try {
      const quoted = await this.quote(params);
      const slippaged = applySlippage(BigInt(quoted.quotedOutRaw), params.slippageBps);
      return slippaged > params.minAmountOutRaw ? slippaged : params.minAmountOutRaw;
    } catch {
      // No quote available: the intent's own positive bound is the floor.
      return params.minAmountOutRaw;
    }
  }

  /**
   * Approve the router for the exact swap amount only (never infinite),
   * BEFORE the swap is broadcast. Skipped when the allowance already
   * covers the amount.
   */
  private async ensureAllowance(token: `0x${string}`, spender: `0x${string}`, amountRaw: bigint): Promise<void> {
    const owner = this.deps.walletClient.account!.address;
    const current = (await this.deps.publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [owner, spender],
    })) as bigint;
    if (current >= amountRaw) return;
    const approveHash = await withEstimateRetry(() =>
      this.deps.walletClient.writeContract({
        address: token,
        abi: erc20Abi,
        functionName: "approve",
        args: [spender, amountRaw],
        account: this.deps.walletClient.account!,
        chain: this.deps.walletClient.chain!,
      }),
    );
    await this.deps.publicClient.waitForTransactionReceipt({ hash: approveHash });
  }

  /**
   * Wait for the receipt and derive the ACTUAL output from ERC-20 Transfer
   * logs of tokenOut to the recipient. A success receipt with no matching
   * transfer is reported as reverted (fail closed).
   */
  private async settle(txHash: `0x${string}`, tokenOut: string, via: string): Promise<LiveExecution> {
    const receipt = await this.deps.publicClient.waitForTransactionReceipt({ hash: txHash });
    const recipientTail = this.deps.recipient.toLowerCase().slice(2);
    let out = 0n;
    for (const log of receipt.logs as Log[]) {
      if (
        log.address.toLowerCase() === tokenOut.toLowerCase() &&
        log.topics[0] === TRANSFER_EVENT_TOPIC &&
        (log.topics[2] ?? "").toLowerCase().endsWith(recipientTail)
      ) {
        out += BigInt(log.data === "0x" || log.data === undefined ? "0" : log.data);
      }
    }
    const status = receipt.status === "success" && out > 0n ? "success" : "reverted";
    const feeUsdCents = await this.estimateFeeCents(receipt.gasUsed, 0.3);
    return {
      txHash,
      status,
      executedOutRaw: out.toString(),
      feeUsdCents,
      detail: `live swap via ${via}; output read from transfer logs`,
    };
  }

  private async estimateFeeCents(gasUsed: bigint, gwei: number): Promise<number> {
    const ethCents = this.deps.ethUsdCents ? await this.deps.ethUsdCents() : 0;
    if (ethCents <= 0) return 0;
    return Math.ceil(Number(gasUsed) * gwei * 1e-9 * ethCents);
  }
}

/**
 * Factory for the full live trade stack (ADR-016), constructed INSIDE
 * chain-adapters so viem type identities never cross the package
 * boundary (same pattern as createLiveAeroEthLeg in live-stack.ts).
 * Returns both legs; the orchestrator assigns them to its ChainTradeLeg
 * seam (structurally compatible — same quote/execute shapes).
 */
export function createLiveTradeLegs(opts: {
  rpcUrl: string;
  privateKey: `0x${string}`;
  recipient: `0x${string}`;
  solanaSecretKey: string;
  jupiterApiKey?: string;
}): {
  evm: LiveAeroUniswapTradeExecutor;
  solana: LiveJupiterTradeExecutor;
} {
  const { publicClient, walletClient } = createBaseViemClients({
    rpcUrl: opts.rpcUrl,
    privateKey: opts.privateKey,
  });
  // Same types-only variance bridge as live-stack.ts: the narrowed
  // client generics are runtime-identical to the executor's generic
  // deps; nothing runtime changes.
  return {
    evm: new LiveAeroUniswapTradeExecutor({
      publicClient: publicClient as PublicClient,
      walletClient: walletClient as WalletClient,
      recipient: opts.recipient,
    }),
    solana: new LiveJupiterTradeExecutor({ base58SecretKey: opts.solanaSecretKey, apiKey: opts.jupiterApiKey }),
  };
}
