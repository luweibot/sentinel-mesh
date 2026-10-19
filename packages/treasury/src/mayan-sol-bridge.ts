/**
 * SOL gas leg: bridge USDC (Base) → USDC (Solana) via the Mayan protocol,
 * with a native SOL gas drop at the destination.
 *
 * API surface verified against @mayanfinance/swap-sdk README (2026-10-19):
 *   fetchQuote({ amountIn64, fromToken, toToken, fromChain, toChain,
 *                slippageBps, gasDrop }) → Quote[]
 *   swapFromEvm(quote, swapperAddress, destinationWalletAddress,
 *               referrerAddresses, signer, permit, overrides, payload)
 *   ERC20 inputs need allowance for addresses.MAYAN_FORWARDER_CONTRACT
 *   Track: GET https://explorer-api.mayan.finance/v3/swap/trx/{txHash}
 *          → clientStatus INPROGRESS | COMPLETED | REFUNDED
 *   Documented minimum: ~5 USDC of output; gasDrop ceiling read from
 *   quote.maxUserGasDrop (solana max ~0.2 SOL).
 *
 * USDC on Solana: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGkZwyTDt1v
 * (from the SDK's own Base→Solana example; native USDC SPL).
 *
 * EVM signing: ethers v6 Wallet(privateKey, provider) — the SDK's
 * swapFromEvm needs an ethers signer with a provider attached and an
 * address matching swapperAddress. Loaded lazily so ETH-only runs and
 * tests never pay for the import; injected via `evm` for tests.
 */

import type { SolGasBridgePort } from "./ports.js";

const USDC_SOLANA = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGkZwyTDt1v";
const EXPLORER_STATUS_URL = "https://explorer-api.mayan.finance/v3/swap/trx";
const SOLANA_RPC = "https://api.mainnet-beta.solana.com";

/** Minimal structural type for the SDK quote. */
interface MayanQuote {
  type: string;
  minAmountOut?: string;
  maxUserGasDrop?: number;
}

export interface MayanSdkLike {
  fetchQuote(params: Record<string, unknown>): Promise<MayanQuote[]>;
  swapFromEvm(
    quote: MayanQuote,
    swapperAddress: string,
    destinationWalletAddress: string,
    referrerAddresses: unknown,
    signer: unknown,
    permit: unknown,
    overrides: unknown,
    payload: unknown,
    options?: unknown,
  ): Promise<unknown>;
}

/** EVM signing/approval seam — real ethers in prod, mock in tests. */
export interface EvmSignerBundle {
  signer: unknown;
  getAddress(): Promise<string>;
  usdcAllowance(spender: string): Promise<bigint>;
  usdcApprove(spender: string, amountRaw: bigint): Promise<void>;
}

export interface MayanSolGasBridgeDeps {
  rpcUrl: string;
  evmPrivateKey: `0x${string}`;
  usdcBaseAddress: `0x${string}`;
  destinationSolanaAddress: string;
  baseRpcUrl?: string;
  slippageBps?: number;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Test seams. */
  sdk?: MayanSdkLike & { addresses?: { MAYAN_FORWARDER_CONTRACT: string } };
  evm?: EvmSignerBundle;
}

const EMPTY_FORWARDER = "0x0000000000000000000000000000000000000000";

export class MayanSolGasBridge implements SolGasBridgePort {
  private readonly fetchImpl: typeof fetch;
  private readonly pollIntervalMs: number;
  private readonly pollTimeoutMs: number;

  constructor(private readonly deps: MayanSolGasBridgeDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.pollIntervalMs = deps.pollIntervalMs ?? 15_000;
    this.pollTimeoutMs = deps.pollTimeoutMs ?? 10 * 60_000;
  }

  async getSolBalanceLamports(address: string): Promise<bigint> {
    const res = await this.fetchImpl(SOLANA_RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: [address] }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json()) as { result?: { value?: number | string } };
    if (!body.result || body.result.value === undefined) throw new Error("solana getBalance failed");
    return BigInt(body.result.value);
  }

  private async loadSdk(): Promise<MayanSdkLike & { addresses: { MAYAN_FORWARDER_CONTRACT: string } }> {
    if (this.deps.sdk) return this.deps.sdk as MayanSdkLike & { addresses: { MAYAN_FORWARDER_CONTRACT: string } };
    const mod = (await import("@mayanfinance/swap-sdk")) as unknown as
      MayanSdkLike & { addresses: { MAYAN_FORWARDER_CONTRACT: string } };
    return mod;
  }

  private async loadEvm(): Promise<EvmSignerBundle> {
    if (this.deps.evm) return this.deps.evm;
    const { ethers } = (await import("ethers")) as unknown as {
      ethers: {
        JsonRpcProvider: new (url: string) => unknown;
        Wallet: new (pk: string, provider: unknown) => { getAddress(): Promise<string> } & Record<string, unknown>;
        Contract: new (address: string, abi: string[], signer: unknown) => Record<string, (...a: unknown[]) => Promise<unknown>>;
      };
    };
    const provider = new ethers.JsonRpcProvider(this.deps.baseRpcUrl ?? "https://mainnet.base.org");
    const signer = new ethers.Wallet(this.deps.evmPrivateKey, provider);
    const usdc = new ethers.Contract(this.deps.usdcBaseAddress, [
      "function allowance(address,address) view returns (uint256)",
      "function approve(address,uint256) returns (bool)",
    ], signer);
    const allowance = usdc.allowance as (a: string, b: string) => Promise<bigint>;
    const approve = usdc.approve as (a: string, b: bigint) => Promise<unknown>;
    const getAddress = signer.getAddress.bind(signer);
    return {
      signer,
      getAddress,
      usdcAllowance: async (spender: string) => allowance(await getAddress(), spender),
      usdcApprove: async (spender: string, amountRaw: bigint) => { await approve(spender, amountRaw); },
    };
  }

  async bridgeUsdcToSolana(params: {
    amountUsdcRaw: bigint;
    gasDropSol: number;
  }): Promise<{ txHash: string; status: "completed" | "refunded" | "failed"; note?: string }> {
    const sdk = await this.loadSdk();
    const evm = await this.loadEvm();

    const quotes = await sdk.fetchQuote({
      amountIn64: params.amountUsdcRaw.toString(),
      fromToken: this.deps.usdcBaseAddress,
      toToken: USDC_SOLANA,
      fromChain: "base",
      toChain: "solana",
      slippageBps: String(this.deps.slippageBps ?? 300),
      gasDrop: params.gasDropSol,
    });
    if (!quotes || quotes.length === 0) {
      return { txHash: "", status: "failed", note: "no mayan route for this amount (below the ~5 USDC minimum?)" };
    }
    // SWIFT is the primary intent-based route per the SDK docs.
    const quote = quotes.find((q) => q.type === "SWIFT") ?? quotes[0]!;

    // exact-in allowance for the Mayan Forwarder (no infinite approvals)
    const forwarder = sdk.addresses?.MAYAN_FORWARDER_CONTRACT ?? EMPTY_FORWARDER;
    if (forwarder === EMPTY_FORWARDER) {
      return { txHash: "", status: "failed", note: "mayan SDK did not expose the forwarder address — refusing" };
    }
    if ((await evm.usdcAllowance(forwarder)) < params.amountUsdcRaw) {
      await evm.usdcApprove(forwarder, params.amountUsdcRaw);
    }

    const swapperAddress = await evm.getAddress();
    const tx = await sdk.swapFromEvm(
      quote,
      swapperAddress,
      this.deps.destinationSolanaAddress,
      null,
      evm.signer,
      null,
      null,
      null,
    );
    const txHash = typeof tx === "string" ? tx : (tx as { hash?: string })?.hash;
    if (!txHash) return { txHash: "", status: "failed", note: "swapFromEvm returned no hash" };

    return this.pollStatus(txHash);
  }

  private async pollStatus(txHash: string): Promise<{ txHash: string; status: "completed" | "refunded" | "failed"; note?: string }> {
    const deadline = Date.now() + this.pollTimeoutMs;
    for (;;) {
      const res = await this.fetchImpl(`${EXPLORER_STATUS_URL}/${txHash}`, { signal: AbortSignal.timeout(10_000) });
      const body = (await res.json()) as { clientStatus?: string };
      const status = body.clientStatus;
      if (status === "COMPLETED") return { txHash, status: "completed" };
      if (status === "REFUNDED") return { txHash, status: "refunded", note: "mayan refunded the bridge" };
      if (Date.now() > deadline) return { txHash, status: "failed", note: `timeout, last status ${status ?? "unknown"}` };
      await new Promise((r) => setTimeout(r, this.pollIntervalMs));
    }
  }
}
