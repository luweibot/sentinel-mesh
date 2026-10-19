import { GasTopUpService, type GasTopUpResult } from "@sentinel-mesh/treasury";
import { createLiveAeroEthLeg } from "@sentinel-mesh/chain-adapters";
import type { AppConfig } from "@sentinel-mesh/config";
import type { Logger } from "@sentinel-mesh/logger";

/**
 * Treasury stack: converts received USDC revenue into just-enough ETH
 * (Base) and SOL (Solana) gas. Wired into the settlement path — every
 * settled x402 payment schedules a deficit-only top-up.
 *
 * Disabled unless TREASURY_ENABLED=true AND EVM_PRIVATE_KEY is present.
 * The SOL leg needs a USDC-per-SOL oracle that is not wired yet, so the
 * planner skips it (fail-closed, accumulating revenue) until that lands.
 */

export interface TreasuryStack {
  enabled: boolean;
  /** Delay after settlement before the top-up runs (RPC state lag). */
  settleDelayMs?: number;
  topUpGas(): Promise<GasTopUpResult>;
}

const DISABLED = (): TreasuryStack => ({
  enabled: false,
  settleDelayMs: 0,
  topUpGas: async () => {
    throw new Error("treasury disabled: topUpGas must not be called");
  },
});

export function buildTreasuryStack(config: AppConfig, logger: Logger): TreasuryStack {
  if (!config.treasuryEnabled) return DISABLED();

  const privateKey = process.env.EVM_PRIVATE_KEY;
  if (!privateKey || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    logger.error({}, "treasury_enabled_but_no_valid_evm_private_key_topup_disabled");
    return DISABLED();
  }

  const usdc = config.baseUsdcAddress as `0x${string}`;
  // viem clients live inside chain-adapters: this package never
  // instantiates viem types (avoids duplicate viem type identities).
  const { port: ethLeg } = createLiveAeroEthLeg({
    rpcUrl: config.baseRpcUrl,
    privateKey: privateKey as `0x${string}`,
    usdcAddress: usdc,
    recipient: config.paymentsReceiverAddress as `0x${string}`,
  });
  const service = new GasTopUpService({
    ethLeg,
    // SOL leg activates when a USDC-per-SOL oracle is wired (Jupiter
    // quote, endpoint to be verified); until then the planner skips it
    // (fail-closed, revenue accumulates until >= Mayan's ~5 USDC minimum
    // makes the bridge worthwhile).
    solPriceOracle: undefined,
    evmWalletAddress: config.paymentsReceiverAddress as `0x${string}`,
    solanaWalletAddress: config.solanaWalletAddress,
    config: {
      ethTargetWei: config.treasuryEthTargetWei,
      solTargetLamports: config.treasurySolTargetLamports,
      usdcReserveRaw: config.treasuryUsdcReserveRaw,
      slippageBps: config.treasurySlippageBps,
    },
  });
  return {
    enabled: true,
    // mainnet.base.org nodes lag state ~5-15s behind settlement receipts.
    settleDelayMs: 15_000,
    topUpGas: async () => {
      const result = await service.topUpGas();
      logger.info(
        { actions: result.plan.actions, notes: result.plan.notes, receipts: result.receipts.map((r) => r.txHash) },
        "treasury_gas_top_up",
      );
      return result;
    },
  };
}
