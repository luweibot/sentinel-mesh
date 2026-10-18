import { describe, expect, it } from "vitest";
import {
  EVM_ROUTER_ALLOWLIST,
  SOLANA_PROGRAM_ALLOWLIST,
  MockEvmTradeAdapter,
  MockSolanaTradeAdapter,
  buildEvmPaperDraft,
  buildSolanaPaperDraft,
  chainRegistryIdToCluster,
  evmDataHash,
  solanaPayloadHash,
  EvmTransactionDraft,
  SolanaTransactionDraft,
} from "../src/trade-transaction.js";

describe("EVM transaction validation", () => {
  const adapter = new MockEvmTradeAdapter();

  it("accepts a well-formed paper draft", () => {
    const draft = buildEvmPaperDraft({ chain: "base", amountInRaw: "1000000", tokenIn: "0xabc0000000000000000000000000000000000001", tokenOut: "0xdef0000000000000000000000000000000000002", minAmountOutRaw: "1" });
    const result = adapter.validateTransaction(draft);
    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
  });

  it("rejects a transaction bound to the wrong chain", () => {
    const draft: EvmTransactionDraft = buildEvmPaperDraft({ chain: "base", amountInRaw: "1", tokenIn: "0xabc0000000000000000000000000000000000001", tokenOut: "0xdef0000000000000000000000000000000000002", minAmountOutRaw: "0" });
    const wrongChain = { ...draft, chainId: 1, expectedChainId: 8453 };
    const result = adapter.validateTransaction(wrongChain);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.code === "chain-mismatch")).toBe(true);
    expect(result.problems.some((p) => p.code === "router-not-allowed")).toBe(true);
  });

  it("rejects altered calldata (hash mismatch)", () => {
    const draft = buildEvmPaperDraft({ chain: "base", amountInRaw: "1", tokenIn: "0xabc0000000000000000000000000000000000001", tokenOut: "0xdef0000000000000000000000000000000000002", minAmountOutRaw: "0" });
    const altered: EvmTransactionDraft = { ...draft, data: `${draft.data}ff` };
    const result = adapter.validateTransaction(altered);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.code === "calldata-altered")).toBe(true);
    expect(evmDataHash(altered.data)).not.toBe(draft.expectedDataHash);
  });

  it("rejects non-allowlisted routers, oversized calldata, and gas over the cap", () => {
    const base = buildEvmPaperDraft({ chain: "base", amountInRaw: "1", tokenIn: "0xabc0000000000000000000000000000000000001", tokenOut: "0xdef0000000000000000000000000000000000002", minAmountOutRaw: "0" });
    expect(adapter.validateTransaction({ ...base, to: `0x${"ab".repeat(20)}` }).problems.some((p) => p.code === "router-not-allowed")).toBe(true);
    const hugeData = `0x${"ab".repeat(2049)}`;
    expect(adapter.validateTransaction({ ...base, data: hugeData, expectedDataHash: evmDataHash(hugeData) }).problems.some((p) => p.code === "calldata-too-large")).toBe(true);
    expect(adapter.validateTransaction({ ...base, gasLimit: 2_000_001, data: base.data, expectedDataHash: evmDataHash(base.data) }).problems.some((p) => p.code === "gas-limit-too-high")).toBe(true);
  });

  it("keeps a single deterministic router allowlist entry per chain", () => {
    expect(EVM_ROUTER_ALLOWLIST.base).not.toBe(EVM_ROUTER_ALLOWLIST.ethereum);
    expect(EVM_ROUTER_ALLOWLIST.base).toMatch(/^0x[0-9a-f]{40}$/);
  });
});

describe("Solana transaction validation", () => {
  const adapter = new MockSolanaTradeAdapter();

  it("accepts a well-formed paper draft", () => {
    const draft = buildSolanaPaperDraft({ cluster: "mainnet-beta", amountInRaw: "1000000", tokenIn: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", tokenOut: "So11111111111111111111111111111111111111112", minAmountOutRaw: "1" });
    const result = adapter.validateTransaction(draft);
    expect(result.ok).toBe(true);
  });

  it("rejects a transaction bound to the wrong cluster", () => {
    const draft = buildSolanaPaperDraft({ cluster: "mainnet-beta", amountInRaw: "1", tokenIn: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", tokenOut: "So11111111111111111111111111111111111111112", minAmountOutRaw: "0" });
    const wrongCluster: SolanaTransactionDraft = { ...draft, cluster: "devnet", expectedCluster: "mainnet-beta" };
    const result = adapter.validateTransaction(wrongCluster);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.code === "chain-mismatch")).toBe(true);
  });

  it("rejects altered instruction payloads (hash mismatch)", () => {
    const draft = buildSolanaPaperDraft({ cluster: "mainnet-beta", amountInRaw: "1", tokenIn: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", tokenOut: "So11111111111111111111111111111111111111112", minAmountOutRaw: "0" });
    const altered: SolanaTransactionDraft = {
      ...draft,
      instructions: [{ ...draft.instructions[0]!, dataBytes: draft.instructions[0]!.dataBytes + 1 }],
    };
    const result = adapter.validateTransaction(altered);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.code === "instructions-altered")).toBe(true);
  });

  it("rejects non-allowlisted programs, oversized payloads, and CU over the cap", () => {
    const base = buildSolanaPaperDraft({ cluster: "mainnet-beta", amountInRaw: "1", tokenIn: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", tokenOut: "So11111111111111111111111111111111111111112", minAmountOutRaw: "0" });
    const hostileProgram = "SomeNonAllowlistedProgram1111111111111111111111";
    const payload = [`${hostileProgram}:8:${base.instructions[0]!.dataBytes}`];
    expect(adapter.validateTransaction({ ...base, instructions: [{ programId: hostileProgram, accountKeys: 8, dataBytes: base.instructions[0]!.dataBytes }], expectedPayloadHash: solanaPayloadHash(payload) }).problems.some((p) => p.code === "program-not-allowed")).toBe(true);
    expect(adapter.validateTransaction({ ...base, computeUnitLimit: 1_400_001 }).problems.some((p) => p.code === "compute-budget-too-high")).toBe(true);
    expect(adapter.validateTransaction({ ...base, instructions: [{ ...base.instructions[0]!, accountKeys: 33 }] }).problems.some((p) => p.code === "too-many-accounts")).toBe(true);
    expect(adapter.validateTransaction({ ...base, instructions: [{ ...base.instructions[0]!, dataBytes: 1025 }] }).problems.some((p) => p.code === "instruction-data-too-large")).toBe(true);
    const many = Array.from({ length: 9 }, () => ({ ...base.instructions[0]! }));
    expect(adapter.validateTransaction({ ...base, instructions: many }).problems.some((p) => p.code === "too-many-instructions")).toBe(true);
  });

  it("maps registry chain ids to clusters", () => {
    expect(chainRegistryIdToCluster("solana-mainnet")).toBe("mainnet-beta");
    expect(chainRegistryIdToCluster("solana-devnet")).toBe("devnet");
    expect(SOLANA_PROGRAM_ALLOWLIST.length).toBeGreaterThan(0);
  });
});
