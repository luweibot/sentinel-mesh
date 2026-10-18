import { describe, expect, it } from "vitest";
import {
  AdapterValidationError,
  MockEvmAdapter,
  MockSigner,
  MockSolanaAdapter,
  MockTradeSimulator,
} from "../src/index.js";

const EVM_WALLET = "0xa94c05c9949cafd958c858036c4830cd8bc1618a";
const SOL_WALLET = "2fg5QD1eD7rzNNCsvnhmXFm5hqNgwTTG8p7kQ6f3rx6f";

describe("mock EVM adapter", () => {
  it("returns deterministic metadata and activity for the same address", async () => {
    const adapter = new MockEvmAdapter();
    const first = await adapter.getWalletActivity(EVM_WALLET);
    const second = await adapter.getWalletActivity(EVM_WALLET);
    expect(first).toEqual(second);
    expect(first.chain).toBe("base");
    expect(first.movements.length).toBe(2);
    expect(first.movements[0]!.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(await adapter.getBlockHeight()).toBe(21_000_000);
  });

  it("produces different fixtures for different addresses", async () => {
    const adapter = new MockEvmAdapter();
    const a = await adapter.getTokenMetadata(EVM_WALLET);
    const b = await adapter.getTokenMetadata("0x0000000000000000000000000000000000000001");
    expect(a.symbol).not.toBe(b.symbol);
  });

  it("rejects invalid addresses", async () => {
    const adapter = new MockEvmAdapter();
    await expect(adapter.getWalletActivity("not-an-address")).rejects.toBeInstanceOf(AdapterValidationError);
  });
});

describe("mock Solana adapter", () => {
  it("returns deterministic base58-style activity", async () => {
    const adapter = new MockSolanaAdapter();
    const first = await adapter.getWalletActivity(SOL_WALLET);
    const second = await adapter.getWalletActivity(SOL_WALLET);
    expect(first).toEqual(second);
    expect(first.movements[0]!.txHash).toMatch(/^[1-9A-HJ-NP-Za-km-z]{88}$/);
    expect(first.movements[0]!.token.decimals).toBe(9);
  });

  it("rejects non-base58 addresses", async () => {
    const adapter = new MockSolanaAdapter();
    await expect(adapter.getWalletActivity("0xdeadbeef")).rejects.toBeInstanceOf(AdapterValidationError);
  });
});

describe("mock signer", () => {
  it("produces deterministic, clearly-labelled mock signatures", async () => {
    const signer = new MockSigner(EVM_WALLET);
    const first = await signer.signMessage("hello");
    const second = await signer.signMessage("hello");
    expect(first.signature).toBe(second.signature);
    expect(first.signature).toMatch(/^mock-sig-[0-9a-f]{64}$/);
    expect(first.mode).toBe("mock");
    expect(first.signerAddress).toBe(EVM_WALLET);
  });

  it("produces different signatures for different messages", async () => {
    const signer = new MockSigner();
    const a = await signer.signMessage("one");
    const b = await signer.signMessage("two");
    expect(a.signature).not.toBe(b.signature);
  });

  it("rejects a non-EVM signer address at construction", () => {
    expect(() => new MockSigner("nope")).toThrow();
  });
});

describe("mock trade simulator", () => {
  const request = {
    chain: "base" as const,
    tokenIn: "0x1111111111111111111111111111111111111111",
    tokenOut: "0x2222222222222222222222222222222222222222",
    amountInRaw: "1000000",
    slippageBps: 50,
  };

  it("produces deterministic simulated artifacts that are never broadcast", async () => {
    const simulator = new MockTradeSimulator(new MockSigner());
    const first = await simulator.simulate(request);
    const second = await simulator.simulate(request);
    expect(first.simulatedTxHash).toBe(second.simulatedTxHash);
    expect(first.simulatedTxHash).toMatch(/^sim-/);
    expect(first.note).toContain("Simulated only");
  });

  it("rejects same-token trades", async () => {
    const simulator = new MockTradeSimulator(new MockSigner());
    await expect(
      simulator.simulate({ ...request, tokenOut: request.tokenIn }),
    ).rejects.toThrow();
  });

  it("rejects malformed amounts", async () => {
    const simulator = new MockTradeSimulator(new MockSigner());
    await expect(simulator.simulate({ ...request, amountInRaw: "1.5" })).rejects.toThrow();
    await expect(simulator.simulate({ ...request, amountInRaw: "-10" })).rejects.toThrow();
  });
});
