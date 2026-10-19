import { describe, expect, it } from "vitest";
import { GasTopUpService } from "../src/service.js";
import type { EthLegPort, SolGasBridgePort } from "../src/ports.js";

function ethLeg(o: { eth?: bigint; usdc?: bigint; perEth?: bigint } = {}): EthLegPort & { swapped: bigint[] } {
  const swapped: bigint[] = [];
  return {
    swapped,
    async swapUsdcToEth({ amountInRaw }: { amountInRaw: bigint }) {
      swapped.push(amountInRaw);
      return { txHash: "0xswap1" as `0x${string}`, status: "success" as const, gasUsed: 180000n, minOutRaw: 1n };
    },
    getEthBalanceWei: async () => o.eth ?? 0n,
    getUsdcBalanceRaw: async () => o.usdc ?? 50_000_000n,
    getUsdcPerEthRaw: async () => o.perEth ?? 2_400_000_000n,
  };
}

const solBridge: SolGasBridgePort = {
  async bridgeUsdcToSolana() { return { txHash: "0xbridge1", status: "completed" as const }; },
  getSolBalanceLamports: async () => 0n,
};

const cfg = { ethTargetWei: 2_000_000_000_000_000n, solTargetLamports: 100_000_000n, usdcReserveRaw: 0n, slippageBps: 500 };

describe("GasTopUpService.topUpGas", () => {
  it("executes the ETH swap with the planned (deficit-only) amount", async () => {
    const leg = ethLeg({ eth: 0n, usdc: 100_000_000n });
    const svc = new GasTopUpService({ ethLeg: leg, evmWalletAddress: "0x0bee61d45d42d7342d57ea7581d17581203447a8", solanaWalletAddress: "H2jn", config: cfg });
    const res = await svc.topUpGas();
    expect(leg.swapped).toEqual([4_896_000n]); // 0.002 ETH deficit @2400 +2% buffer
    expect(res.receipts[0]).toMatchObject({ kind: "swapUsdcToEthOnBase", status: "success" });
  });

  it("no-op when both chains are at target", async () => {
    const leg = ethLeg({ eth: cfg.ethTargetWei, usdc: 100_000_000n });
    const svc = new GasTopUpService({ ethLeg: leg, evmWalletAddress: "0x0bee61d45d42d7342d57ea7581d17581203447a8", solanaWalletAddress: "H2jn", config: cfg, solBridge });
    const res = await svc.topUpGas();
    expect(res.plan.actions).toHaveLength(0);
    expect(leg.swapped).toHaveLength(0);
  });

  it("bridges the SOL leg when ETH is already at target", async () => {
    const leg = ethLeg({ eth: cfg.ethTargetWei, usdc: 50_000_000n });
    const bridged: Array<{ amount: bigint; gas: number }> = [];
    const bridge: SolGasBridgePort = {
      async bridgeUsdcToSolana({ amountUsdcRaw, gasDropSol }) { bridged.push({ amount: amountUsdcRaw, gas: gasDropSol }); return { txHash: "0xb", status: "completed" }; },
      getSolBalanceLamports: async () => 0n,
    };
    const svc = new GasTopUpService({
      ethLeg: leg, solBridge: bridge,
      solPriceOracle: { getUsdcPerSolRaw: async () => 150_000_000n },
      evmWalletAddress: "0x0bee61d45d42d7342d57ea7581d17581203447a8",
      solanaWalletAddress: "H2jn",
      config: cfg,
    });
    const res = await svc.topUpGas();
    expect(bridged).toEqual([{ amount: 15_000_000n, gas: 0.1 }]);
    expect(res.receipts[0]).toMatchObject({ kind: "bridgeUsdcToSolanaForGas", status: "completed" });
  });

  it("SOL leg planned but bridge missing: notes skip, ETH leg still runs", async () => {
    const leg = ethLeg({ eth: 0n, usdc: 100_000_000n });
    const svc = new GasTopUpService({
      ethLeg: leg, solPriceOracle: { getUsdcPerSolRaw: async () => 150_000_000n },
      evmWalletAddress: "0x0bee61d45d42d7342d57ea7581d17581203447a8", solanaWalletAddress: "H2jn", config: cfg,
    });
    const res = await svc.topUpGas();
    expect(res.plan.actions.some((a) => a.kind === "bridgeUsdcToSolanaForGas")).toBe(true);
    expect(res.receipts.every((r) => r.kind === "swapUsdcToEthOnBase")).toBe(true);
    expect(res.plan.notes.join(" ")).toContain("no bridge configured");
  });
});
