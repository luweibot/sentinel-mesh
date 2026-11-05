import { describe, it, expect } from "vitest";
import { createPrivyCliSigner, findTxHash } from "../src/settlement.js";

const WALLET = "0x3F3C5af93542B42E5f457CB3711Bc551f2898dEF";
const HASH = `0x${"ab".repeat(32)}`;
const TX = {
  to: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  data: "0xe3ee160e" + "00".repeat(64),
  gas: 180_000n,
  maxFeePerGas: 1_000_000_000n,
  maxPriorityFeePerGas: 100_000_000n,
  nonce: 7,
};

describe("findTxHash", () => {
  it("reads a nested transaction hash from CLI JSON", () => {
    expect(findTxHash(JSON.stringify({ data: { transaction_hash: HASH } }))).toBe(HASH);
    expect(findTxHash(JSON.stringify({ result: { hash: HASH.slice(2) } }))).toBe(HASH);
  });

  it("falls back to a bare 32-byte hash in noisy output", () => {
    expect(findTxHash(`Progress: resolved 35\nsent ${HASH}\n`)).toBe(HASH);
  });

  it("returns null when there is no hash", () => {
    expect(findTxHash('{"error":"insufficient funds"}')).toBeNull();
    expect(findTxHash("")).toBeNull();
  });
});

describe("createPrivyCliSigner", () => {
  it("sends exactly one Base EIP-1559 call through the CLI and returns its hash", async () => {
    const seen: string[][] = [];
    const signer = await createPrivyCliSigner({
      address: WALLET,
      exec: async (args) => {
        seen.push(args);
        return { stdout: JSON.stringify({ data: { transaction_hash: HASH } }) };
      },
    });

    expect(signer.address).toBe(WALLET);
    await expect(signer.sendTransaction(TX)).resolves.toBe(HASH);

    expect(seen).toHaveLength(1);
    const body = JSON.parse(seen[0].at(-1)!);
    expect(body.method).toBe("eth_sendTransaction");
    expect(body.caip2).toBe("eip155:8453");
    expect(body.params.transaction.to).toBe(TX.to);
    expect(body.params.transaction.data).toBe(TX.data);
    // Quantities travel as hex, not decimal or bigint.
    expect(body.params.transaction.gas_limit).toBe("0x2bf20");
    expect(body.params.transaction.nonce).toBe("0x7");
    expect(body.params.transaction.max_fee_per_gas).toBe("0x3b9aca00");
  });

  it("refuses to claim success when the CLI returns no hash", async () => {
    const signer = await createPrivyCliSigner({
      address: WALLET,
      exec: async () => ({ stdout: '{"error":"user rejected"}' }),
    });
    await expect(signer.sendTransaction(TX)).rejects.toThrow(/no transaction hash/);
  });

  it("rejects a malformed wallet address", async () => {
    await expect(
      createPrivyCliSigner({ address: "0xnot-an-address", exec: async () => ({ stdout: "" }) }),
    ).rejects.toThrow(/not an EVM address/);
  });
});
