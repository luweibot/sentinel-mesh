/** Ports the treasury service needs to reach the chains. Injected for tests. */

export interface EthLegPort {
  /** Swap USDC → ETH on Base via the Aero router (LiveAeroBroadcaster). */
  swapUsdcToEth(params: { amountInRaw: bigint; slippageBps: number }): Promise<{
    txHash: `0x${string}`;
    status: "success" | "reverted";
    gasUsed: bigint;
    minOutRaw: bigint;
  }>;
  getEthBalanceWei(address: `0x${string}`): Promise<bigint>;
  getUsdcBalanceRaw(address: `0x${string}`): Promise<bigint>;
  /** USDC raw per 1 ETH from a live Aero quote. */
  getUsdcPerEthRaw(): Promise<bigint>;
}

export interface SolGasBridgePort {
  /**
   * Bridge USDC on Base → USDC on Solana, delivering `gasDropSol` native SOL
   * for gas at the destination. Returns the source tx hash + final status.
   */
  bridgeUsdcToSolana(params: {
    amountUsdcRaw: bigint;
    gasDropSol: number;
  }): Promise<{ txHash: string; status: "completed" | "refunded" | "failed"; note?: string }>;
  getSolBalanceLamports(address: string): Promise<bigint>;
}

export interface SolPriceOraclePort {
  /** USDC raw per 1 SOL. */
  getUsdcPerSolRaw(): Promise<bigint | null>;
}
