import { describe, expect, it } from "vitest";
import { LiveAeroBroadcaster, AERO_ROUTER_BASE, AERO_POOL_FACTORY_BASE, BASE_WETH } from "../src/live-evm-broadcaster.js";

const RECIPIENT = "0x0bee61d45d42d7342d57ea7581d17581203447a8" as `0x${string}`;
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" as `0x${string}`;

function mockClients(over: {
  quoteOut?: bigint;
  allowance?: bigint;
  writeStatus?: "success" | "reverted";
  calls?: { fn: string; args: unknown[] }[];
} = {}) {
  const calls = over.calls ?? [];
  const publicClient = {
    readContract: async ({ functionName, args }: { functionName: string; args: unknown[] }) => {
      calls.push({ fn: functionName, args });
      if (functionName === "getAmountsOut") return [0n, over.quoteOut ?? 72000000n];
      if (functionName === "allowance") return over.allowance ?? 0n;
      throw new Error(`unexpected read ${functionName}`);
    },
    waitForTransactionReceipt: async ({ hash }: { hash: `0x${string}` }) => ({ status: over.writeStatus ?? "success", blockNumber: 123n, gasUsed: 250000n, hash }),
  };
  const walletClient = {
    account: { address: "0x1111111111111111111111111111111111111111" },
    chain: { id: 8453 },
    writeContract: async ({ functionName, args }: { functionName: string; args: unknown[] }) => {
      calls.push({ fn: functionName, args });
      return `0xabc${calls.length}` as `0x${string}`;
    },
  };
  return { publicClient: publicClient as never, walletClient: walletClient as never, calls };
}

describe("LiveAeroBroadcaster", () => {
  it("pins the onchain-verified Aero addresses", () => {
    expect(AERO_ROUTER_BASE.toLowerCase()).toBe("0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43");
    expect(AERO_POOL_FACTORY_BASE.toLowerCase()).toBe("0x420dd381b31aef6683db6b902084cb0ffece40da");
    expect(BASE_WETH).toBe("0x4200000000000000000000000000000000000006");
  });

  it("ETH→token: broadcasts with slippage-adjusted minOut and waits for receipt", async () => {
    const { publicClient, walletClient, calls } = mockClients({ quoteOut: 72000000n });
    const b = new LiveAeroBroadcaster({ publicClient, walletClient, recipient: RECIPIENT });
    const r = await b.swapExactETHForTokens({ tokenOut: USDC, amountInWei: 30000000000000n, slippageBps: 500 });
    expect(r.status).toBe("success");
    const swap = calls.find((c) => c.fn === "swapExactETHForTokens")!;
    expect(swap.args[0]).toBe(68400000n); // 72000000 * 0.95
    expect(swap.args[2]).toBe(RECIPIENT); // output lands in the project wallet
  });

  it("token→ETH: approves exact amount only when allowance is short", async () => {
    const { publicClient, walletClient, calls } = mockClients({ allowance: 0n });
    const b = new LiveAeroBroadcaster({ publicClient, walletClient, recipient: RECIPIENT });
    await b.swapExactTokensForETH({ tokenIn: USDC, amountInRaw: 100000n, slippageBps: 500 });
    const approve = calls.find((c) => c.fn === "approve")!;
    expect(approve.args[1]).toBe(100000n); // exact-in, no infinite approval
  });

  it("token→ETH: skips approval when allowance already covers the amount", async () => {
    const { publicClient, walletClient, calls } = mockClients({ allowance: 10n ** 12n });
    const b = new LiveAeroBroadcaster({ publicClient, walletClient, recipient: RECIPIENT });
    await b.swapExactTokensForETH({ tokenIn: USDC, amountInRaw: 100000n, slippageBps: 500 });
    expect(calls.find((c) => c.fn === "approve")).toBeUndefined();
  });

  it("fails closed on a zero/negative quote (never broadcasts unquoted)", async () => {
    const { publicClient, walletClient, calls } = mockClients({ quoteOut: 0n });
    const b = new LiveAeroBroadcaster({ publicClient, walletClient, recipient: RECIPIENT });
    await expect(b.swapExactETHForTokens({ tokenOut: USDC, amountInWei: 1n, slippageBps: 500 })).rejects.toThrow();
    expect(calls.find((c) => c.fn === "swapExactETHForTokens")).toBeUndefined();
  });

  it("fails closed on unsafe slippage", async () => {
    const { publicClient, walletClient } = mockClients();
    const b = new LiveAeroBroadcaster({ publicClient, walletClient, recipient: RECIPIENT });
    await expect(b.swapExactETHForTokens({ tokenOut: USDC, amountInWei: 1n, slippageBps: 2000 })).rejects.toThrow();
  });

  it("reports reverted receipts as reverted, never as success", async () => {
    const { publicClient, walletClient } = mockClients({ writeStatus: "reverted" });
    const b = new LiveAeroBroadcaster({ publicClient, walletClient, recipient: RECIPIENT });
    const r = await b.swapExactETHForTokens({ tokenOut: USDC, amountInWei: 1000n, slippageBps: 500 });
    expect(r.status).toBe("reverted");
  });
});
