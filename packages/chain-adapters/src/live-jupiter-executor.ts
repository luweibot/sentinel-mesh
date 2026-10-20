import { Keypair, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import type { LiveTradeParams, LiveQuote, LiveExecution } from "./live-trade-execution.js";
import { LiveQuoteError } from "./live-trade-execution.js";

/**
 * LIVE Solana trade executor via the Jupiter Swap API V2 Meta-Aggregator.
 *
 * Jupiter v6 is SUNSET (2026). This implements the current documented
 * flow (https://developers.jup.ag/docs/swap/order-and-execute, read
 * 2026-10-20):
 *   1. GET  /swap/v2/order?inputMint&outputMint&amount&taker[&slippageBps]
 *      -> { transaction (base64), requestId, outAmount, router, feeBps }
 *   2. Deserialize the versioned transaction, sign with the project key.
 *   3. POST /swap/v2/execute { signedTransaction, requestId }
 *      -> { status: "Success"|"Failed", signature, outputAmountResult, … }
 *
 * Jupiter assembles AND lands the transaction (managed slippage, priority
 * fees, confirmation). Fail-closed validation on our side:
 *  - The order's inAmount must equal the intent's amountInRaw.
 *  - The quoted outAmount must clear the intent's minAmountOutRaw.
 *  - The executed outputAmountResult must clear the intent bound too;
 *    a "Success" status without a valid executed output is reported as
 *    reverted, never as success.
 *  - feeBps above a hard cap (50) fails closed.
 *  - Quote failures, empty transactions, and API errors never attempt a
 *    trade (LiveQuoteError upstream; thrown Error on execute).
 *
 * Auth: keyless works at 0.5 RPS; set JUPITER_API_KEY in the service env
 * for production rate limits (passed through via opts.apiKey).
 */

export const JUPITER_SWAP_V2_BASE = "https://api.jup.ag/swap/v2" as const;

/** Hard cap on the Jupiter platform fee (bps) before failing closed. */
const MAX_PLATFORM_FEE_BPS = 50;

/** Solana swap fee estimate for the guard's fee bound (priority fees are
 *  managed by Jupiter; a conservative flat estimate in USD cents). */
const SOLANA_FEE_USD_CENTS_ESTIMATE = 1;

export interface JupiterOrderResponse {
  transaction: string | null; // base64 versioned transaction
  requestId: string;
  outAmount: string;
  inAmount: string;
  router: string; // "metis" | "jupiterz" | "dflow" | "okx"
  feeBps: number;
  feeMint: string;
  errorCode?: number;
  errorMessage?: string;
}

export interface JupiterExecuteResponse {
  status: "Success" | "Failed";
  signature: string;
  code: number;
  totalInputAmount: string;
  totalOutputAmount: string;
  inputAmountResult: string;
  outputAmountResult: string;
  error?: string;
}

export interface JupiterExecutorDeps {
  /** Base58-encoded secret key of the project wallet. */
  base58SecretKey: string;
  /** API base URL (override for tests). */
  baseUrl?: string;
  /** Optional Jupiter API key (x-api-key header). */
  apiKey?: string;
  /** Injectable fetch (mocked in tests). */
  fetchFn?: typeof fetch;
}

export class LiveJupiterTradeExecutor {
  private readonly keypair: Keypair;
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly fetchFn: typeof fetch;

  constructor(deps: JupiterExecutorDeps) {
    const secret = bs58.decode(deps.base58SecretKey);
    if (secret.length !== 64) {
      throw new Error(`solana secret key decoded to ${secret.length} bytes (expected 64); refusing to trade`);
    }
    this.keypair = Keypair.fromSecretKey(secret);
    this.baseUrl = deps.baseUrl ?? JUPITER_SWAP_V2_BASE;
    this.apiKey = deps.apiKey;
    this.fetchFn = deps.fetchFn ?? fetch;
  }

  /** Public taker address the order will be assembled for. */
  get takerAddress(): string {
    return this.keypair.publicKey.toBase58();
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) h["x-api-key"] = this.apiKey;
    return h;
  }

  /** Quote via GET /order without a taker (quote-only response). */
  async quote(params: LiveTradeParams): Promise<LiveQuote> {
    const order = await this.fetchOrder(params, false);
    if (order.feeBps > MAX_PLATFORM_FEE_BPS) {
      throw new LiveQuoteError(`jupiter platform fee ${order.feeBps}bps exceeds the ${MAX_PLATFORM_FEE_BPS}bps cap`);
    }
    const quotedOut = BigInt(order.outAmount);
    if (quotedOut <= 0n) {
      throw new LiveQuoteError(`jupiter quote returned non-positive output (${order.outAmount})`);
    }
    if (quotedOut < params.minAmountOutRaw) {
      throw new LiveQuoteError(
        `jupiter quote ${order.outAmount} is below the intent minimum ${params.minAmountOutRaw.toString()}`,
      );
    }
    return {
      quotedOutRaw: order.outAmount,
      feeUsdCents: SOLANA_FEE_USD_CENTS_ESTIMATE,
      priceImpactBps: 0,
      detail: `jupiter ${order.router} quote`,
    };
  }

  /** Full managed execution: order -> sign -> execute. */
  async execute(params: LiveTradeParams): Promise<LiveExecution> {
    const minOutRaw = params.minAmountOutRaw;
    if (minOutRaw <= 0n) {
      throw new Error("intent carries a zero minimum out; refusing to execute a live trade without an out floor");
    }
    const order = await this.fetchOrder(params, true);
    if (order.feeBps > MAX_PLATFORM_FEE_BPS) {
      throw new Error(`jupiter platform fee ${order.feeBps}bps exceeds the ${MAX_PLATFORM_FEE_BPS}bps cap`);
    }
    if (BigInt(order.inAmount) !== params.amountInRaw) {
      throw new Error(`jupiter order inAmount ${order.inAmount} does not match the intent amount ${params.amountInRaw.toString()}`);
    }
    const quotedOut = BigInt(order.outAmount);
    if (quotedOut < minOutRaw) {
      throw new Error(`jupiter quoted output ${order.outAmount} is below the intent minimum ${minOutRaw.toString()}`);
    }
    if (!order.transaction) {
      throw new Error(`jupiter returned no transaction (router=${order.router}, error=${order.errorMessage ?? "unknown"})`);
    }

    // Sign the assembled versioned transaction with the project key.
    const transaction = VersionedTransaction.deserialize(Buffer.from(order.transaction, "base64"));
    transaction.sign([this.keypair]);
    const signedTransaction = Buffer.from(transaction.serialize()).toString("base64");

    const response = await this.fetchFn(`${this.baseUrl}/execute`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ signedTransaction, requestId: order.requestId }),
    });
    if (!response.ok) {
      throw new Error(`jupiter /execute failed: HTTP ${response.status} ${await response.text()}`);
    }
    const result = (await response.json()) as JupiterExecuteResponse;
    if (result.status !== "Success") {
      return {
        txHash: result.signature,
        status: "reverted",
        executedOutRaw: "0",
        feeUsdCents: SOLANA_FEE_USD_CENTS_ESTIMATE,
        detail: `jupiter execute reported Failure (code ${result.code}: ${result.error ?? "unknown"})`,
      };
    }
    const executedOut = BigInt(result.outputAmountResult);
    if (executedOut <= 0n || executedOut < minOutRaw) {
      // Success claimed but the executed output violates the bound:
      // fail closed — report as reverted so the guard layer rejects.
      return {
        txHash: result.signature,
        status: "reverted",
        executedOutRaw: executedOut.toString(),
        feeUsdCents: SOLANA_FEE_USD_CENTS_ESTIMATE,
        detail: `jupiter executed output ${result.outputAmountResult} violates the intent bound ${minOutRaw.toString()}`,
      };
    }
    return {
      txHash: result.signature,
      status: "success",
      executedOutRaw: executedOut.toString(),
      feeUsdCents: SOLANA_FEE_USD_CENTS_ESTIMATE,
      detail: `live swap via jupiter ${order.router} (requestId ${order.requestId})`,
    };
  }

  /** GET /order; quote-only when withTaker is false. */
  private async fetchOrder(params: LiveTradeParams, withTaker: boolean): Promise<JupiterOrderResponse> {
    const query = new URLSearchParams({
      inputMint: params.tokenIn,
      outputMint: params.tokenOut,
      amount: params.amountInRaw.toString(),
    });
    if (withTaker) {
      query.set("taker", this.takerAddress);
      // Fixed slippage for deterministic bot behaviour (Jupiter docs,
      // "Trading bots"); capped by the caller's guard bounds.
      query.set("slippageBps", String(Math.min(params.slippageBps, 1000)));
    }
    const response = await this.fetchFn(`${this.baseUrl}/order?${query.toString()}`, {
      headers: this.headers(),
    });
    if (!response.ok) {
      const text = await response.text();
      if (!withTaker) throw new LiveQuoteError(`jupiter /order failed: HTTP ${response.status} ${text}`);
      throw new Error(`jupiter /order failed: HTTP ${response.status} ${text}`);
    }
    const order = (await response.json()) as JupiterOrderResponse;
    if (order.transaction === "" || order.errorCode !== undefined) {
      const message = `jupiter order error ${order.errorCode ?? "unknown"}: ${order.errorMessage ?? "no route"}`;
      if (!withTaker) throw new LiveQuoteError(message);
      throw new Error(message);
    }
    return order;
  }
}
