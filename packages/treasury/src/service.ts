import { computeGasTopUpPlan, type GasTopUpAction, type GasTopUpConfig, type GasTopUpPlan } from "./plan.js";
import type { EthLegPort, SolGasBridgePort, SolPriceOraclePort } from "./ports.js";

export interface GasTopUpServiceDeps {
  ethLeg: EthLegPort;
  solBridge?: SolGasBridgePort;
  solPriceOracle?: SolPriceOraclePort;
  /** Project wallet (EVM) — also the x402 payments receiver. */
  evmWalletAddress: `0x${string}`;
  solanaWalletAddress: string;
  config: {
    ethTargetWei: bigint;
    solTargetLamports: bigint;
    usdcReserveRaw: bigint;
    slippageBps: number;
  };
}

export interface GasTopUpResult {
  plan: GasTopUpPlan;
  receipts: Array<
    | { kind: "swapUsdcToEthOnBase"; txHash: string; status: string; gasUsed: string; minOutRaw: string }
    | { kind: "bridgeUsdcToSolanaForGas"; txHash: string; status: string; note?: string }
  >;
  ranAt: string;
}

/**
 * Idempotent, deficit-only gas top-up. Call after USDC revenue settles
 * (x402 payments) — it converts ONLY what the ETH/SOL gas deficits need,
 * leaving the rest of the USDC in the treasury.
 */
export class GasTopUpService {
  constructor(private readonly deps: GasTopUpServiceDeps) {}

  async topUpGas(): Promise<GasTopUpResult> {
    const [ethBalanceWei, usdcBalanceRaw] = await Promise.all([
      this.deps.ethLeg.getEthBalanceWei(this.deps.evmWalletAddress),
      this.deps.ethLeg.getUsdcBalanceRaw(this.deps.evmWalletAddress),
    ]);
    const solBalanceLamports = this.deps.solBridge
      ? await this.deps.solBridge.getSolBalanceLamports(this.deps.solanaWalletAddress)
      : 0n;
    const [usdcPerEthRaw, usdcPerSolRaw] = await Promise.all([
      this.deps.ethLeg.getUsdcPerEthRaw(),
      this.deps.solPriceOracle ? this.deps.solPriceOracle.getUsdcPerSolRaw() : Promise.resolve(null),
    ]);

    const plan = computeGasTopUpPlan(
      {
        ethTargetWei: this.deps.config.ethTargetWei,
        solTargetLamports: this.deps.config.solTargetLamports,
        usdcReserveRaw: this.deps.config.usdcReserveRaw,
        ethTopUpMinUsdcRaw: 10_000n, // $0.01 — below this the swap gas is not worth it
        mayanMinUsdcRaw: 5_000_000n, // Mayan's documented ~5 USDC minimum
        ethBufferBps: 200, // 2% buffer so the swap tx's own gas is covered
        usdcPerEthRaw,
        usdcPerSolRaw,
      },
      { ethBalanceWei, solBalanceLamports, usdcBalanceRaw },
    );

    const receipts: GasTopUpResult["receipts"] = [];
    for (const action of plan.actions) {
      if (action.kind === "swapUsdcToEthOnBase") {
        const r = await this.deps.ethLeg.swapUsdcToEth({
          amountInRaw: action.usdcRaw,
          slippageBps: this.deps.config.slippageBps,
        });
        receipts.push({
          kind: "swapUsdcToEthOnBase",
          txHash: r.txHash,
          status: r.status,
          gasUsed: r.gasUsed.toString(),
          minOutRaw: r.minOutRaw.toString(),
        });
      } else if (action.kind === "bridgeUsdcToSolanaForGas") {
        if (!this.deps.solBridge) {
          plan.notes.push("SOL leg planned but no bridge configured — skipped");
          continue;
        }
        const r = await this.deps.solBridge.bridgeUsdcToSolana({
          amountUsdcRaw: action.usdcRaw,
          gasDropSol: action.gasDropSol,
        });
        receipts.push({
          kind: "bridgeUsdcToSolanaForGas",
          txHash: r.txHash,
          status: r.status,
          note: r.note,
        });
      }
    }

    return { plan, receipts, ranAt: new Date().toISOString() };
  }
}

export type { GasTopUpAction, GasTopUpPlan, GasTopUpConfig };
