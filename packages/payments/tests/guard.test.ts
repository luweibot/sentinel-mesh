import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { createLogger } from "@sentinel-mesh/logger";
import { randomUUID } from "node:crypto";
import {
  MockFacilitator,
  PaymentRecordStore,
  SpendCapLedger,
  X402PaymentGuard,
  MOCK_ASSETS,
  MOCK_RECIPIENTS,
  mockPayment,
  mockRequirement,
  mockSettlement,
} from "../src/index.js";

const NOW = new Date("2026-04-01T12:00:30.000Z");

function makeGuard(caps: Record<string, number> = { "risk-agent": 10_00 }, facilitator: MockFacilitator = new MockFacilitator({ now: () => NOW })): { guard: X402PaymentGuard; records: PaymentRecordStore; facilitator: MockFacilitator } {
  const sink = new PassThrough();
  sink.resume();
  const logger = createLogger({ service: "payments-test", level: "silent", destination: sink });
  const records = new PaymentRecordStore();
  const guard = new X402PaymentGuard({
    assets: MOCK_ASSETS,
    recipients: MOCK_RECIPIENTS,
    caps: new SpendCapLedger(caps),
    records,
    facilitator,
    facilitatorIds: [facilitator.facilitatorId],
    clock: { now: () => NOW },
    logger,
  });
  return { guard, records, facilitator };
}

async function happyPayment(guard: X402PaymentGuard, overrides: { requirement?: Record<string, unknown>; nonce?: string } = {}) {
  const requirement = mockRequirement(overrides.requirement ?? {});
  const payment = mockPayment({ payTo: requirement.payTo as string, maxAmountRequired: requirement.maxAmountRequired as string }, overrides.nonce ?? randomUUID());
  return guard.process({
    agentId: "risk-agent",
    requirement,
    payment,
    paymentId: randomUUID(),
  });
}

describe("x402 happy path", () => {
  it("records a valid payment, settles it, and grants content access only", async () => {
    const { guard } = makeGuard();
    const verdict = await happyPayment(guard);
    expect(verdict.ok).toBe(true);
    expect(verdict.record?.status).toBe("recorded");
    // A payment must not grant trading authority — structurally impossible.
    expect(verdict.record?.grants).toEqual({ contentAccess: true, trading: false });

    const settlement = await guard.verifySettlement(verdict.record!.paymentId, { transactionHash: "mock-tx-abc12345" });
    expect(settlement.ok).toBe(true);
    expect(settlement.record?.status).toBe("settled");
    expect(settlement.record?.transactionHash).toBe("mock-tx-abc12345");
  });

  it("is idempotent on the same paymentId", async () => {
    const { guard } = makeGuard();
    const requirement = mockRequirement();
    const payment = mockPayment({ payTo: requirement.payTo as string, maxAmountRequired: requirement.maxAmountRequired as string }, randomUUID());
    const request = { agentId: "risk-agent", requirement, payment, paymentId: randomUUID() };
    const first = await guard.process(request);
    const second = await guard.process(request);
    expect(second.ok).toBe(true);
    expect(second.record?.paymentId).toBe(first.record?.paymentId);
    // No double-counting: exactly one record exists.
    expect(guard.list().filter((record) => record.status === "recorded").length).toBe(1);
  });
});

describe("requirement and payload verification", () => {
  it("rejects unsupported chains", async () => {
    const { guard } = makeGuard();
    const verdict = await happyPayment(guard, { requirement: { network: 999 } });
    expect(verdict.code).toBe("unsupported-chain");
  });

  it("rejects assets outside the allowlist", async () => {
    const { guard } = makeGuard();
    const verdict = await happyPayment(guard, { requirement: { asset: "0xdead00000000000000000000000000000000beef" } });
    expect(verdict.code).toBe("asset-not-allowed");
  });

  it("rejects recipients outside the allowlist", async () => {
    const { guard } = makeGuard();
    const verdict = await happyPayment(guard, { requirement: { payTo: "0xdead00000000000000000000000000000000beef" } });
    expect(verdict.code).toBe("recipient-not-allowed");
  });

  it("rejects amount mismatches between payload and requirement", async () => {
    const { guard } = makeGuard();
    const requirement = mockRequirement();
    const payment = mockPayment({ payTo: requirement.payTo as string, maxAmountRequired: requirement.maxAmountRequired as string }, randomUUID(), { value: "2000000" });
    const verdict = await guard.process({ agentId: "risk-agent", requirement, payment, paymentId: randomUUID() });
    expect(verdict.code).toBe("amount-mismatch");
  });

  it("rejects expired payment windows", async () => {
    const { guard } = makeGuard();
    const requirement = mockRequirement();
    const payment = mockPayment({ payTo: requirement.payTo as string, maxAmountRequired: requirement.maxAmountRequired as string }, randomUUID(), {
      validBefore: new Date(Date.parse("2026-04-01T12:00:00.000Z") - 1).toISOString(),
    });
    const verdict = await guard.process({ agentId: "risk-agent", requirement, payment, paymentId: randomUUID() });
    expect(verdict.code).toBe("requirement-expired");
  });

  it("rejects schema-invalid requirements and payloads", async () => {
    const { guard } = makeGuard();
    const badScheme = await guard.process({ agentId: "risk-agent", requirement: mockRequirement({ scheme: "exactOutEvm" }), payment: mockPayment({ payTo: "0x9990000000000000000000000000000000000001", maxAmountRequired: "1000000" }, randomUUID()), paymentId: randomUUID() });
    expect(badScheme.code).toBe("unsupported-x402-version");
  });

  it("rejects unknown x402 versions in payloads", async () => {
    const { guard } = makeGuard();
    const requirement = mockRequirement();
    const payment = mockPayment({ payTo: requirement.payTo as string, maxAmountRequired: requirement.maxAmountRequired as string }, randomUUID(), {});
    (payment as Record<string, unknown>).x402Version = "2";
    const verdict = await guard.process({ agentId: "risk-agent", requirement, payment, paymentId: randomUUID() });
    expect(verdict.code).toBe("unsupported-scheme");
  });
});

describe("replay resistance", () => {
  it("rejects a reused EIP-3009 nonce", async () => {
    const { guard } = makeGuard();
    const nonce = randomUUID();
    await happyPayment(guard, { nonce });
    const second = await happyPayment(guard, { nonce });
    expect(second.code).toBe("payment-replay");
  });

  it("the mock facilitator also refuses to settle the same nonce twice", async () => {
    const { facilitator } = makeGuard();
    const requirement = mockRequirement();
    const payment = mockPayment({ payTo: requirement.payTo as string, maxAmountRequired: requirement.maxAmountRequired as string }, randomUUID());
    const first = await facilitator.verifyAndSettle({ requirement, payment });
    const second = await facilitator.verifyAndSettle({ requirement, payment });
    expect(first.payload.success).toBe(true);
    expect(second.payload.success).toBe(false);
  });
});

describe("spend caps", () => {
  it("rejects payments that exceed the per-agent daily cap", async () => {
    const { guard } = makeGuard({ "risk-agent": 1_00 }); // $1/day; requirement is $1, second $1 payment must fail
    const first = await happyPayment(guard, { nonce: randomUUID() });
    expect(first.ok).toBe(true);
    // First payment reserved $1 of the $1 cap; a second $1 payment exceeds it.
    const second = await happyPayment(guard, { nonce: randomUUID() });
    expect(second.code).toBe("spend-cap-exceeded");
  });
});

describe("settlement evidence", () => {
  it("rejects settlement evidence from a non-allowlisted facilitator", async () => {
    // The facilitator instance is allowlisted, but it produces evidence
    // stamped with a DIFFERENT (non-allowlisted) facilitator id — the
    // guard must reject that evidence.
    const rogue = new MockFacilitator({ now: () => NOW });
    const originalConfirm = rogue.confirmSettlement.bind(rogue);
    rogue.confirmSettlement = async (input: { transactionHash: string }) => {
      const evidence = await originalConfirm(input);
      return { ...evidence, facilitatorId: "rogue-facilitator" };
    };
    const { guard } = makeGuard(undefined, rogue);
    const verdict = await happyPayment(guard);
    const settlement = await guard.verifySettlement(verdict.record!.paymentId, { transactionHash: "0xrogue" });
    expect(settlement.code).toBe("settlement-facilitator-not-allowed");
  });

  it("rejects settlement evidence on the wrong chain", async () => {
    const wrongChain = new MockFacilitator({ now: () => NOW });
    const original = wrongChain.confirmSettlement.bind(wrongChain);
    wrongChain.confirmSettlement = async (input: { transactionHash: string }) => {
      const evidence = await original(input);
      return { ...evidence, network: 1 };
    };
    const { guard } = makeGuard(undefined, wrongChain);
    const verdict = await happyPayment(guard);
    const settlement = await guard.verifySettlement(verdict.record!.paymentId, { transactionHash: "0xwrongchain" });
    expect(settlement.code).toBe("settlement-mismatch");
  });

  it("rejects failed facilitator confirmations", async () => {
    const failing = new MockFacilitator({ now: () => NOW });
    failing.confirmSettlement = async () => ({
      scheme: "exactInEvm",
      network: 8453,
      payload: { success: false, error: { code: "reverted", message: "simulated revert" } },
      facilitatorId: failing.facilitatorId,
      settledAt: NOW.toISOString(),
    });
    const { guard } = makeGuard(undefined, failing);
    const verdict = await happyPayment(guard);
    const settlement = await guard.verifySettlement(verdict.record!.paymentId, { transactionHash: "0xfailed" });
    expect(settlement.ok).toBe(false);
    expect(settlement.code).toBe("facilitator-error");
  });

  it("rejects settlement without a transaction hash", async () => {
    const { guard } = makeGuard();
    const verdict = await happyPayment(guard);
    const settlement = await guard.verifySettlement(verdict.record!.paymentId, {});
    expect(settlement.ok).toBe(false);
    expect(settlement.code).toBe("settlement-mismatch");
  });

  it("replays settlement idempotently", async () => {
    const { guard } = makeGuard();
    const verdict = await happyPayment(guard);
    const first = await guard.verifySettlement(verdict.record!.paymentId, { transactionHash: "mock-tx-once" });
    const second = await guard.verifySettlement(verdict.record!.paymentId, { transactionHash: "mock-tx-once" });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.message).toContain("idempotent");
  });
});

describe("reconciliation", () => {
  it("detects duplicate nonces and settles without evidence", async () => {
    const { guard, records } = makeGuard();
    await happyPayment(guard, { nonce: "11111111-1111-4111-8111-111111111111" });
    // Fabricate a duplicate-nonce record directly in the store (tamper simulation).
    const existing = records.list()[0]!;
    records.save({ ...existing, paymentId: randomUUID(), status: "settled", transactionHash: undefined });
    const report = guard.reconcile();
    expect(report.consistent).toBe(false);
    expect(report.duplicateNonces).toContain("11111111-1111-4111-8111-111111111111");
    expect(report.settledWithoutEvidence.length).toBe(1);
  });

  it("reports consistent for a clean ledger", async () => {
    const { guard } = makeGuard();
    const verdict = await happyPayment(guard);
    await guard.verifySettlement(verdict.record!.paymentId, { transactionHash: "mock-tx-clean0001" });
    expect(guard.reconcile().consistent).toBe(true);
  });
});

describe("payments cannot grant trading authority", () => {
  it("every grant shape hard-codes trading: false", async () => {
    const { guard } = makeGuard();
    const verdict = await happyPayment(guard);
    const settled = await guard.verifySettlement(verdict.record!.paymentId, { transactionHash: "mock-tx-grant0001" });
    expect(verdict.record?.grants.trading).toBe(false);
    expect(settled.record?.grants.trading).toBe(false);
    // And rejected records grant nothing at all.
    const rejected = await happyPayment(guard, { requirement: { network: 999 } });
    expect(rejected.record?.grants).toEqual({ contentAccess: false, trading: false });
  });
});
