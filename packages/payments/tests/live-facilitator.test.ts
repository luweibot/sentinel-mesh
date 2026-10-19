import { describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount, signTypedData } from "viem/accounts";
import { LiveFacilitator, type RpcCaller } from "../src/live-facilitator.js";

/**
 * Real cryptographic verification: keys generated locally, signature
 * produced by viem's account over the exact EIP-3009 typed data, RPC
 * responses stubbed at the JSON-RPC boundary.
 */

const NOW = new Date("2026-04-01T12:00:30.000Z");

const payer = privateKeyToAccount(generatePrivateKey());
const receiver = "0xa94c05c9949cafd958c858036c4830cd8bc1618a";

function eip3009Payload(nonce: string, overrides: Record<string, unknown> = {}) {
  return {
    from: payer.address,
    to: receiver,
    value: "10000",
    nonce,
    validAfter: new Date(Date.parse("2026-04-01T12:00:00.000Z")).toISOString(),
    validBefore: new Date(Date.parse("2026-04-01T12:05:00.000Z")).toISOString(),
    ...overrides,
  };
}

async function signedPayload(nonce: string, overrides: Record<string, unknown> = {}) {
  const payload = eip3009Payload(nonce, overrides);
  const signature = await payer.signTypedData({
    domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: "0x833589fcd6edb6e08f4c2c6ff80ffe7fd34502b0" },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: {
      from: payload.from,
      to: payload.to as `0x${string}`,
      value: BigInt(payload.value),
      validAfter: BigInt(Math.floor(Date.parse(payload.validAfter) / 1000)),
      validBefore: BigInt(Math.floor(Date.parse(payload.validBefore) / 1000)),
      nonce: (("0x" + nonce.replace(/-/g, "").padStart(64, "0")) as `0x${string}`),
    },
  });
  return { ...payload, signature };
}

/** RPC stub: sequence-aware fake for eth_getTransactionReceipt / eth_call. */
function stubRpc(behavior: {
  receipt?: { status: string } | null;
  authorizationState?: boolean;
  throwOnCall?: boolean;
  seenCalls: Array<{ method: string; params: unknown[] }>;
}): RpcCaller {
  return {
    async call<T = unknown>(method: string, params: unknown[]): Promise<T> {
      behavior.seenCalls.push({ method, params });
      if (method === "eth_getTransactionReceipt") {
        return behavior.receipt as T;
      }
      if (method === "eth_call") {
        if (behavior.throwOnCall) throw new Error("rpc down");
        return (behavior.authorizationState ? "0x" + "0".repeat(63) + "1" : "0x0") as T;
      }
      throw new Error(`unexpected method ${method}`);
    },
  };
}

describe("LiveFacilitator.verifySignature", () => {
  it("accepts a signature by the claimed payer", async () => {
    const rpc = stubRpc({ seenCalls: [] });
    const facilitator = new LiveFacilitator(rpc, { now: () => NOW });
    const payment = await signedPayload("11111111-1111-4111-8111-111111111111");
    expect(await facilitator.verifySignature(payment)).toBe(true);
  });

  it("rejects a signature from a different key", async () => {
    const rpc = stubRpc({ seenCalls: [] });
    const facilitator = new LiveFacilitator(rpc, { now: () => NOW });
    const payment = await signedPayload("22222222-2222-4222-8222-222222222222");
    // Claim it's from someone else.
    expect(await facilitator.verifySignature({ ...payment, from: receiver })).toBe(false);
  });

  it("rejects tampered amounts (signature binding)", async () => {
    const rpc = stubRpc({ seenCalls: [] });
    const facilitator = new LiveFacilitator(rpc, { now: () => NOW });
    const payment = await signedPayload("33333333-3333-4333-8333-333333333333");
    expect(await facilitator.verifySignature({ ...payment, value: "999999" })).toBe(false);
  });

  it("rejects malformed signatures instead of throwing", async () => {
    const rpc = stubRpc({ seenCalls: [] });
    const facilitator = new LiveFacilitator(rpc, { now: () => NOW });
    const payment = await signedPayload("44444444-4444-4444-8444-444444444444");
    expect(await facilitator.verifySignature({ ...payment, signature: "0xdeadbeef" })).toBe(false);
  });

  it("accepts real x402 bytes32 hex nonces", async () => {
    const rpc = stubRpc({ seenCalls: [] });
    const facilitator = new LiveFacilitator(rpc, { now: () => NOW });
    const nonce = "0x" + "ab".repeat(32);
    const payload = eip3009Payload(nonce);
    const signature = await payer.signTypedData({
      domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: "0x833589fcd6edb6e08f4c2c6ff80ffe7fd34502b0" },
      types: {
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      },
      primaryType: "TransferWithAuthorization",
      message: {
        from: payload.from,
        to: payload.to as `0x${string}`,
        value: BigInt(payload.value),
        validAfter: BigInt(Math.floor(Date.parse(payload.validAfter) / 1000)),
        validBefore: BigInt(Math.floor(Date.parse(payload.validBefore) / 1000)),
        nonce: nonce as unknown as `0x${string}`,
      },
    });
    expect(await facilitator.verifySignature({ ...payload, signature })).toBe(true);
  });
});

describe("LiveFacilitator.confirmSettlement", () => {
  const TX = "0xabc0000000000000000000000000000000000000000000000000000000000f00";

  it("confirms a mined receipt with the authorization consumed on-chain", async () => {
    const seen: Array<{ method: string; params: unknown[] }> = [];
    const rpc = stubRpc({ receipt: { status: "0x1" }, authorizationState: true, seenCalls: seen });
    const facilitator = new LiveFacilitator(rpc, { now: () => NOW });
    const evidence = await facilitator.confirmSettlement({ payer: payer.address, nonce: "55555555-5555-4555-8555-555555555555", transactionHash: TX });
    expect(evidence.payload.success).toBe(true);
    expect(evidence.payload.transactionHash).toBe(TX);
    expect(evidence.facilitatorId).toBe("base-usdc-facilitator-v1");
    // The eth_call must target USDC's authorizationStates with the payer + nonce.
    const call = seen.find((c) => c.method === "eth_call");
    expect(call?.params[0]).toMatchObject({ to: "0x833589fcd6edb6e08f4c2c6ff80ffe7fd34502b0", data: /^0x3f264ed9/ });
  });

  it("rejects when the transaction is unmined or reverted", async () => {
    for (const receipt of [null, { status: "0x0" }]) {
      const rpc = stubRpc({ receipt, authorizationState: true, seenCalls: [] });
      const facilitator = new LiveFacilitator(rpc, { now: () => NOW });
      const evidence = await facilitator.confirmSettlement({ payer: payer.address, nonce: "66666666-6666-4666-8666-666666666666", transactionHash: TX });
      expect(evidence.payload.success).toBe(false);
      expect(evidence.payload.error?.code).toBe("receipt-not-found-or-failed");
    }
  });

  it("rejects when the authorization nonce is NOT yet consumed (no funds moved)", async () => {
    const rpc = stubRpc({ receipt: { status: "0x1" }, authorizationState: false, seenCalls: [] });
    const facilitator = new LiveFacilitator(rpc, { now: () => NOW });
    const evidence = await facilitator.confirmSettlement({ payer: payer.address, nonce: "77777777-7777-4777-8777-777777777777", transactionHash: TX });
    expect(evidence.payload.success).toBe(false);
    expect(evidence.payload.error?.code).toBe("authorization-not-consumed");
  });

  it("reports rpc failures as settlement failure, never as success", async () => {
    const rpc = stubRpc({ receipt: { status: "0x1" }, throwOnCall: true, seenCalls: [] });
    const facilitator = new LiveFacilitator(rpc, { now: () => NOW });
    const evidence = await facilitator.confirmSettlement({ payer: payer.address, nonce: "88888888-8888-4888-8888-888888888888", transactionHash: TX });
    expect(evidence.payload.success).toBe(false);
    expect(evidence.payload.error?.code).toBe("rpc-error");
  });
});
