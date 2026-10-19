import { describe, expect, it } from "vitest";
import { MayanSolGasBridge } from "../src/mayan-sol-bridge.js";

const quote = { type: "SWIFT", minAmountOut: "4800000", maxUserGasDrop: 0.2 };
const DEST = "H2jn8HAwt14tJEmQ4g9uFMGWsznWuKoooACDA6STFWVF";

function makeSdk() {
  const calls: { fn: string; args: unknown[] }[] = [];
  return {
    calls,
    addresses: { MAYAN_FORWARDER_CONTRACT: "0xforwarder" },
    async fetchQuote(params: Record<string, unknown>) {
      calls.push({ fn: "fetchQuote", args: [params] });
      return [quote];
    },
    async swapFromEvm(q: unknown, swapper: string, dest: string, _r: unknown, signer: unknown) {
      calls.push({ fn: "swapFromEvm", args: [q, swapper, dest, signer] });
      return { hash: "0xmayan-tx-1" };
    },
  };
}

function makeEvm(allowance = 0n) {
  const calls: { fn: string; args: unknown[] }[] = [];
  return {
    calls,
    signer: { __isSigner: true },
    getAddress: async () => "0xswapper",
    usdcAllowance: async () => allowance,
    usdcApprove: async (spender: string, amt: bigint) => { calls.push({ fn: "approve", args: [spender, amt] }); },
  };
}

function fetchStub(statuses: string[]) {
  let i = 0;
  return (async () => ({
    json: async () => ({ clientStatus: statuses[Math.min(i++, statuses.length - 1)] }),
  })) as unknown as typeof fetch;
}

function makeBridge(sdk: ReturnType<typeof makeSdk>, evm: ReturnType<typeof makeEvm>, statuses = ["COMPLETED"]) {
  return new MayanSolGasBridge({
    rpcUrl: "https://mainnet.base.org",
    evmPrivateKey: "0x" + "1".repeat(64) as `0x${string}`,
    usdcBaseAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    destinationSolanaAddress: DEST,
    sdk, evm, fetchImpl: fetchStub(statuses), pollIntervalMs: 0,
  });
}

describe("MayanSolGasBridge", () => {
  it("quotes SWIFT, approves exact-in, swaps, polls to COMPLETED", async () => {
    const sdk = makeSdk(); const evm = makeEvm(0n);
    const result = await makeBridge(sdk, evm, ["INPROGRESS", "COMPLETED"]).bridgeUsdcToSolana({ amountUsdcRaw: 5_000_000n, gasDropSol: 0.05 });
    expect(result).toMatchObject({ status: "completed", txHash: "0xmayan-tx-1" });
    const fq = sdk.calls.find((c) => c.fn === "fetchQuote")!.args[0] as Record<string, unknown>;
    expect(fq).toMatchObject({ fromChain: "base", toChain: "solana", gasDrop: 0.05, amountIn64: "5000000" });
    expect(evm.calls).toEqual([{ fn: "approve", args: ["0xforwarder", 5_000_000n] }]);
    const swap = sdk.calls.find((c) => c.fn === "swapFromEvm")!;
    expect(swap.args[1]).toBe("0xswapper");
    expect(swap.args[2]).toBe(DEST);
    expect((swap.args[3] as { __isSigner: boolean }).__isSigner).toBe(true);
  });

  it("skips approval when allowance already covers the amount", async () => {
    const sdk = makeSdk(); const evm = makeEvm(10_000_000n);
    await makeBridge(sdk, evm).bridgeUsdcToSolana({ amountUsdcRaw: 5_000_000n, gasDropSol: 0.05 });
    expect(evm.calls).toHaveLength(0);
  });

  it("reports refunded bridges as refunded", async () => {
    const result = await makeBridge(makeSdk(), makeEvm(), ["REFUNDED"]).bridgeUsdcToSolana({ amountUsdcRaw: 5_000_000n, gasDropSol: 0.05 });
    expect(result.status).toBe("refunded");
  });

  it("no quotes (below Mayan minimum): fails with a note, nothing swapped", async () => {
    const sdk = makeSdk(); sdk.fetchQuote = async () => [];
    const result = await makeBridge(sdk, makeEvm()).bridgeUsdcToSolana({ amountUsdcRaw: 1_000n, gasDropSol: 0.05 });
    expect(result.status).toBe("failed");
    expect(result.note).toContain("minimum");
    expect(sdk.calls.find((c) => c.fn === "swapFromEvm")).toBeUndefined();
  });

  it("reads SOL balance via the public RPC", async () => {
    const b = new MayanSolGasBridge({
      rpcUrl: "https://mainnet.base.org",
      evmPrivateKey: "0x" + "1".repeat(64) as `0x${string}`,
      usdcBaseAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      destinationSolanaAddress: DEST,
      sdk: makeSdk(),
      fetchImpl: (async () => ({ json: async () => ({ result: { value: 123456789 } }) })) as unknown as typeof fetch,
      pollIntervalMs: 0,
    });
    expect(await b.getSolBalanceLamports("H2jn")).toBe(123456789n);
  });
});
