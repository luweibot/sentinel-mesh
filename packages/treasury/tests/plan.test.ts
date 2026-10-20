import { describe, expect, it } from "vitest";
import { computeGasTopUpPlan, type GasTopUpConfig } from "../src/plan.js";

const base: GasTopUpConfig = {
  ethTargetWei: 2_000_000_000_000_000n, // 0.002 ETH
  solTargetLamports: 100_000_000n,      // 0.1 SOL
  usdcReserveRaw: 0n,
  ethTopUpMinUsdcRaw: 10_000n,
  mayanMinUsdcRaw: 5_000_000n,
  ethBufferBps: 200,
  usdcPerEthRaw: 2_400_000_000n, // 2400 USDC per ETH (6 dec)
  usdcPerSolRaw: 150_000_000n,  // 150 USDC per SOL
};

describe("computeGasTopUpPlan", () => {
  it("empty balances: plans both legs, ETH first (priority), SOL bumped to bridge minimum", () => {
    const p = computeGasTopUpPlan(base, { ethBalanceWei: 0n, solBalanceLamports: 0n, usdcBalanceRaw: 50_000_000n });
    expect(p.actions).toHaveLength(2);
    expect(p.actions[0]!.kind).toBe("swapUsdcToEthOnBase");
    // ETH deficit 0.002 ETH → 4.8 USDC + 2% buffer = 4896000+ buffer ⇒ ~4900000
    expect((p.actions[0] as { usdcRaw: bigint }).usdcRaw).toBe(4_896_000n);
    // SOL deficit 0.1 SOL → 15 USDC; remainder 50004000 → but SOL needs 15 USDC, remainder ~45.104 USDC ≥ 15
    expect(p.actions[1]!.kind).toBe("bridgeUsdcToSolanaForGas");
    expect((p.actions[1] as { usdcRaw: bigint; gasDropSol: number }).usdcRaw).toBe(15_000_000n);
    expect((p.actions[1] as { gasDropSol: number }).gasDropSol).toBe(0.1);
  });

  it("both gas balances at target: no actions", () => {
    const p = computeGasTopUpPlan(base, {
      ethBalanceWei: 2_000_000_000_000_000n,
      solBalanceLamports: 100_000_000n,
      usdcBalanceRaw: 999_999_000n,
    });
    expect(p.actions).toHaveLength(0);
    expect(p.notes.join(" ")).toContain("at target");
  });

  it("respects the USDC reserve — never swaps reserved revenue", () => {
    const p = computeGasTopUpPlan({ ...base, usdcReserveRaw: 9_000_000n }, {
      ethBalanceWei: 0n, solBalanceLamports: 0n, usdcBalanceRaw: 10_000_000n,
    });
    // available = 1 USDC; ETH needs ~4.9 → swap 1 USDC; SOL leg below minimum → accumulate note
    const eth = p.actions.find((a) => a.kind === "swapUsdcToEthOnBase") as { usdcRaw: bigint };
    expect(eth.usdcRaw).toBe(1_000_000n);
    expect(p.actions.find((a) => a.kind === "bridgeUsdcToSolanaForGas")).toBeUndefined();
    expect(p.notes.join(" ")).toContain("below bridge minimum");
  });

  it("tiny ETH deficit below the minimum: skips the ETH leg", () => {
    const p = computeGasTopUpPlan(base, {
      ethBalanceWei: 1_999_999_900_000_000n, // deficit ~100 gwei ≈ dust
      solBalanceLamports: 100_000_000n,
      usdcBalanceRaw: 100_000_000n,
    });
    expect(p.actions).toHaveLength(0);
    expect(p.notes.join(" ")).toContain("below swap minimum");
  });

  it("no SOL price oracle: SOL leg skipped with a note, ETH leg unaffected", () => {
    const p = computeGasTopUpPlan({ ...base, usdcPerSolRaw: null }, {
      ethBalanceWei: 0n, solBalanceLamports: 0n, usdcBalanceRaw: 50_000_000n,
    });
    expect(p.actions).toHaveLength(1);
    expect(p.actions[0]!.kind).toBe("swapUsdcToEthOnBase");
    expect(p.notes.join(" ")).toContain("usdcPerSol");
  });

  it("SOL leg bumps to the Mayan minimum when the deficit is small", () => {
    const p = computeGasTopUpPlan(base, {
      ethBalanceWei: base.ethTargetWei, solBalanceLamports: 99_000_000n, // 0.001 SOL deficit ≈ 0.15 USDC
      usdcBalanceRaw: 50_000_000n,
    });
    const sol = p.actions.find((a) => a.kind === "bridgeUsdcToSolanaForGas") as { usdcRaw: bigint; gasDropSol: number };
    expect(sol.usdcRaw).toBe(5_000_000n); // bumped to minimum
    expect(sol.gasDropSol).toBeCloseTo(0.001, 6);
  });

  it("fails closed on bad config", () => {
    expect(() => computeGasTopUpPlan({ ...base, ethTargetWei: 0n }, { ethBalanceWei: 0n, solBalanceLamports: 0n, usdcBalanceRaw: 0n })).toThrow();
    expect(() => computeGasTopUpPlan({ ...base, usdcReserveRaw: -1n }, { ethBalanceWei: 0n, solBalanceLamports: 0n, usdcBalanceRaw: 0n })).toThrow();
  });
});
