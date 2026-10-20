import type { ChainId, TradeIntent } from "@sentinel-mesh/contracts";
import type { LiveQuote, LiveExecution } from "@sentinel-mesh/chain-adapters";
import type { TransactionSimulationPort, SimulationResult } from "./signing.js";

/**
 * Trade broadcast port for EXECUTION_MODE=live (ADR-016).
 *
 * The executor calls quote() — via the simulator seam — and execute()
 * only after every guard (kill switch, idempotency, policy, authorization,
 * limits, liquidity, bounds, validation, signing) has passed. The port is
 * deliberately narrow: chain, token in/out, amounts, bounds. There is no
 * generic "send transaction" surface.
 *
 * Implementations live in @sentinel-mesh/chain-adapters:
 *  - Base: LiveAeroUniswapTradeExecutor (Aero primary, Uniswap V3 fallback)
 *  - Solana: LiveJupiterTradeExecutor (Jupiter Swap API V2 Meta-Aggregator)
 * The orchestrator wires a chain-dispatching composite; a chain without
 * a wired leg fails closed inside dispatch.
 */
export interface LiveTradeRequest {
  chain: ChainId;
  tokenIn: string;
  tokenOut: string;
  amountInRaw: bigint;
  minAmountOutRaw: bigint;
  slippageBps: number;
}

export interface TradeBroadcastPort {
  quote(params: LiveTradeRequest): Promise<LiveQuote>;
  execute(params: LiveTradeRequest): Promise<LiveExecution>;
}

/** A live leg for one chain family. */
export interface ChainTradeLeg {
  quote(params: Omit<LiveTradeRequest, "chain">): Promise<LiveQuote>;
  execute(params: Omit<LiveTradeRequest, "chain">): Promise<LiveExecution>;
}

/**
 * Chain-dispatching composite: EVM legs (base + ethereum) share the EVM
 * executor; Solana uses the Jupiter executor. A request for a chain with
 * no wired leg fails closed.
 */
export class DispatchingTradeBroadcast implements TradeBroadcastPort {
  constructor(
    private readonly evm: ChainTradeLeg | undefined,
    private readonly solana: ChainTradeLeg | undefined,
  ) {}

  private legFor(chain: ChainId): ChainTradeLeg {
    if (chain === "solana" || chain === "solana-mainnet" || chain === "solana-devnet") {
      if (!this.solana) throw new Error("no live solana trade leg is wired; failing closed");
      return this.solana;
    }
    if (!this.evm) throw new Error(`no live EVM trade leg is wired for chain '${chain}'; failing closed`);
    return this.evm;
  }

  async quote(params: LiveTradeRequest): Promise<LiveQuote> {
    const { chain, ...rest } = params;
    return await this.legFor(chain).quote(rest);
  }

  async execute(params: LiveTradeRequest): Promise<LiveExecution> {
    const { chain, ...rest } = params;
    return await this.legFor(chain).execute(rest);
  }
}

/**
 * Live-quote simulator: implements the executor's TransactionSimulationPort
 * on top of a live TradeBroadcastPort's quote(). Fail closed: a quote
 * failure reports status "uncertain" (the executor rejects on uncertainty);
 * a quote below the intent bound reports "failed".
 */
export class LiveQuoteSimulator implements TransactionSimulationPort {
  constructor(
    private readonly broadcaster: TradeBroadcastPort,
    private readonly opts: { slippageBps: number },
  ) {}

  async simulate(intent: TradeIntent): Promise<SimulationResult> {
    try {
      const quote = await this.broadcaster.quote({
        chain: intent.chain,
        tokenIn: intent.tokenIn,
        tokenOut: intent.tokenOut,
        amountInRaw: BigInt(intent.amountInRaw),
        minAmountOutRaw: BigInt(intent.minAmountOutRaw),
        slippageBps: this.opts.slippageBps,
      });
      const quotedOut = BigInt(quote.quotedOutRaw);
      if (quotedOut < BigInt(intent.minAmountOutRaw)) {
        return {
          status: "failed",
          simulatedOutRaw: "0",
          feeUsdCents: 0,
          priceImpactBps: 0,
          detail: `live quote ${quote.quotedOutRaw} is below the intent bound ${intent.minAmountOutRaw}`,
        };
      }
      return {
        status: "succeeded",
        simulatedOutRaw: quote.quotedOutRaw,
        feeUsdCents: quote.feeUsdCents,
        priceImpactBps: quote.priceImpactBps,
        detail: quote.detail,
      };
    } catch (error) {
      return {
        status: "uncertain",
        simulatedOutRaw: "0",
        feeUsdCents: 0,
        priceImpactBps: 0,
        detail: `live quote failed: ${String(error)}`,
      };
    }
  }
}
