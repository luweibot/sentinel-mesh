import { describe, expect, it } from "vitest";
import {
  SettlementBroadcaster,
  encodeTransferWithAuthorization,
  splitSignature,
  type SettlementConfig,
  type SettlementSigner,
} from "../src/settlement.js";
import type { RpcCaller } from "../src/live-facilitator.js";

const RECEIVER = "0x250cf8852e5236dcaf5ee7f06d1e0f5800413866";
const PAYER = "0x19a41fcc7391cab4442497cd8eefeb9509011bfe";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const SIGNER_ADDRESS = "0x250cf8852e5236dcaf5ee7f06d1e0f5800413866";
const NOW = new Date("2026-11-05T05:00:00.000Z");
const SIG =
  "0x" + "11".repeat(32) + "22".repeat(32) + "1b";

function auth(overrides: Partial<Record<string, string>> = {}) {
  return {
    from: PAYER,
    to: RECEIVER,
    value: "10000",
    validAfter: new Date(NOW.getTime() - 60_000).toISOString(),
    validBefore: new Date(NOW.getTime() + 300_000).toISOString(),
    nonce: "0x" + "ab".repeat(32),
    signature: SIG,
    ...overrides,
  };
}

function config(overrides: Partial<SettlementConfig> = {}): SettlementConfig {
  return {
    enabled: true,
    receiverAddress: RECEIVER,
    usdcAddress: USDC,
    maxFeePerGasWei: 1_000_000_000n,
    hourlyGasCapWei: 1_000_000_000_000n,
    ...overrides,
  };
}

/** Chain stub: verifies the exact calls the broadcaster is allowed to make. */
function fakeChain(opts: { state?: bigint; status?: string; gasPrice?: bigint } = {}) {
  const calls: string[] = [];
  const sent: Array<Record<string, unknown>> = [];
  const rpc: RpcCaller = {
    async call<T>(method: string): Promise<T> {
      calls.push(method);
      if (method === "eth_call") return ((opts.state ?? 0n) === 0n ? "0x0" : "0x" + (opts.state ?? 0n).toString(16)) as T;
      if (method === "eth_estimateGas") return "0x186a0" as T; // 100000
      if (method === "eth_gasPrice") return ("0x" + (opts.gasPrice ?? 1_000_000n).toString(16)) as T;
      if (method === "eth_getTransactionCount") return "0x5" as T;
      if (method === "eth_sendRawTransaction") return "0xtx" as T;
      if (method === "eth_getTransactionReceipt")
        return {
          status: opts.status ?? "0x1",
          gasUsed: "0x186a0",
          effectiveGasPrice: "0x" + (opts.gasPrice ?? 1_000_000n).toString(16),
        } as T;
      throw new Error(`unexpected rpc ${method}`);
    },
  };
  const signer: SettlementSigner = {
    address: SIGNER_ADDRESS,
    async sendTransaction(tx) {
      sent.push(tx as unknown as Record<string, unknown>);
      return "0xtx";
    },
  };
  return { rpc, signer, calls, sent };
}

const clock = { now: () => NOW };

describe("settlement calldata", () => {
  it("encodes transferWithAuthorization with the EIP-3009 selector", () => {
    const data = encodeTransferWithAuthorization(auth());
    expect(data).toBeTruthy();
    expect(data!.startsWith("0xe3ee160e")).toBe(true);
    // from + to + value + validAfter + validBefore + nonce + v + r + s = 9 words
    expect(data!.length).toBe(10 + 9 * 64);
  });

  it("normalises v from 0/1 to 27/28 and rejects bad signatures", () => {
    expect(splitSignature("0x" + "11".repeat(32) + "22".repeat(32) + "00")?.v).toBe(27);
    expect(splitSignature("0x" + "11".repeat(32) + "22".repeat(32) + "1c")?.v).toBe(28);
    expect(splitSignature("0xdeadbeef")).toBeNull();
  });
});

describe("settlement broadcaster: fails closed", () => {
  it("does nothing when settlement is disabled", async () => {
    const chain = fakeChain();
    const b = new SettlementBroadcaster({ rpc: chain.rpc, signer: chain.signer, config: config({ enabled: false }), clock });
    const out = await b.settle(auth());
    expect(out).toMatchObject({ ok: false, code: "settlement-disabled" });
    expect(chain.sent).toHaveLength(0);
  });

  it("refuses with no signer configured", async () => {
    const chain = fakeChain();
    const b = new SettlementBroadcaster({ rpc: chain.rpc, config: config(), clock });
    const out = await b.settle(auth());
    expect(out).toMatchObject({ ok: false, code: "no-signer" });
    expect(chain.sent).toHaveLength(0);
  });

  it("refuses an authorization paying somebody else", async () => {
    const chain = fakeChain();
    const b = new SettlementBroadcaster({ rpc: chain.rpc, signer: chain.signer, config: config(), clock });
    const out = await b.settle(auth({ to: PAER_OTHER }));
    expect(out).toMatchObject({ ok: false, code: "wrong-recipient" });
    expect(chain.sent).toHaveLength(0);
  });

  it("refuses an expired authorization", async () => {
    const chain = fakeChain();
    const b = new SettlementBroadcaster({ rpc: chain.rpc, signer: chain.signer, config: config(), clock });
    const out = await b.settle(auth({ validBefore: new Date(NOW.getTime() - 1000).toISOString() }));
    expect(out).toMatchObject({ ok: false, code: "expired" });
    expect(chain.sent).toHaveLength(0);
  });

  it("refuses an authorization that is not valid yet", async () => {
    const chain = fakeChain();
    const b = new SettlementBroadcaster({ rpc: chain.rpc, signer: chain.signer, config: config(), clock });
    const out = await b.settle(auth({ validAfter: new Date(NOW.getTime() + 60_000).toISOString() }));
    expect(out).toMatchObject({ ok: false, code: "not-yet-valid" });
    expect(chain.sent).toHaveLength(0);
  });

  it("never pays twice: refuses a nonce already consumed on-chain", async () => {
    const chain = fakeChain({ state: 1n });
    const b = new SettlementBroadcaster({ rpc: chain.rpc, signer: chain.signer, config: config(), clock });
    const out = await b.settle(auth());
    expect(out).toMatchObject({ ok: false, code: "already-settled" });
    expect(chain.sent).toHaveLength(0);
  });

  it("refuses when the network fee is above the ceiling", async () => {
    const chain = fakeChain({ gasPrice: 5_000_000_000n });
    const b = new SettlementBroadcaster({ rpc: chain.rpc, signer: chain.signer, config: config(), clock });
    const out = await b.settle(auth());
    expect(out).toMatchObject({ ok: false, code: "fee-too-high" });
    expect(chain.sent).toHaveLength(0);
  });

  it("refuses when the hourly gas budget would be exceeded", async () => {
    const chain = fakeChain();
    // 100000 gas * 1 gwei = 1e14 wei, above a 1e12 cap
    const b = new SettlementBroadcaster({
      rpc: chain.rpc,
      signer: chain.signer,
      config: config({ hourlyGasCapWei: 1_000_000_000_000n / 1000n }),
      clock,
    });
    const out = await b.settle(auth());
    expect(out).toMatchObject({ ok: false, code: "hourly-cap-exceeded" });
    expect(chain.sent).toHaveLength(0);
  });

  it("rejects a malformed signature before touching the chain", async () => {
    const chain = fakeChain();
    const b = new SettlementBroadcaster({ rpc: chain.rpc, signer: chain.signer, config: config(), clock });
    const out = await b.settle(auth({ signature: "0x1234" }));
    expect(out).toMatchObject({ ok: false, code: "invalid-signature-bytes" });
    expect(chain.sent).toHaveLength(0);
  });
});

describe("settlement broadcaster: the one success path", () => {
  it("broadcasts exactly one call to USDC and reports the tx hash", async () => {
    const chain = fakeChain();
    const b = new SettlementBroadcaster({ rpc: chain.rpc, signer: chain.signer, config: config(), clock });
    const out = await b.settle(auth());
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.txHash).toBe("0xtx");
      expect(out.gasSpentWei).toBe(100000n * 1_000_000n);
    }
    expect(chain.sent).toHaveLength(1);
    const tx = chain.sent[0]!;
    expect(tx.to).toBe(USDC); // never any other contract
    expect(String(tx.data).startsWith("0xe3ee160e")).toBe(true);
    expect(b.spentLastHour()).toBe(100000n * 1_000_000n);
  });

  it("treats a reverted transaction as a failure, not a payment", async () => {
    const chain = fakeChain({ status: "0x0" });
    const b = new SettlementBroadcaster({ rpc: chain.rpc, signer: chain.signer, config: config(), clock });
    const out = await b.settle(auth());
    expect(out).toMatchObject({ ok: false, code: "reverted" });
  });
});

const PAER_OTHER = "0x1111111111111111111111111111111111111111";
