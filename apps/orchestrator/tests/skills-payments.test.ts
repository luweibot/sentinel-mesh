import { describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { PassThrough } from "node:stream";
import { createLogger } from "@sentinel-mesh/logger";
import { loadConfig } from "@sentinel-mesh/config";
import { InMemoryEventBus, createEventPublisher } from "@sentinel-mesh/queue";
import { DeterministicPolicyEngine } from "@sentinel-mesh/policy-engine";
import { createHash, randomUUID } from "node:crypto";
import {
  InMemoryEventOutbox,
  InMemoryProcessedEvents,
  InMemoryRunStore,
  InMemoryTaskStore,
  OrchestrationEngine,
} from "@sentinel-mesh/orchestrator";
import { registerResearchAgents } from "@sentinel-mesh/agents";
import { buildApp } from "../src/app.js";
import { buildPaymentsStack, buildSkillsStack } from "../src/skills-payments.js";
import { CLEAN_SKILL_MD, cleanSkillManifest } from "@sentinel-mesh/skills";
import { mockPayment, mockRequirement, mockSettlement } from "@sentinel-mesh/payments";

const NOW = new Date("2026-04-01T12:00:30.000Z");

function deps() {
  const config = loadConfig({ DATA_SOURCE: "fixture" });
  const sink = new PassThrough();
  sink.resume();
  const logger = createLogger({ service: "test", level: "silent", destination: sink });
  const bus = new InMemoryEventBus();
  const engine = new OrchestrationEngine({
    bus,
    taskStore: new InMemoryTaskStore(),
    runStore: new InMemoryRunStore(),
    outbox: new InMemoryEventOutbox(),
    processedEvents: new InMemoryProcessedEvents(),
    clock: { now: () => new Date() },
    logger,
  });
  registerResearchAgents(engine);
  const skills = buildSkillsStack(config, logger, { now: () => NOW }).registry;
  const payments = buildPaymentsStack(config, logger, { now: () => NOW });
  const app = buildApp({ config, logger, engine, skills, payments, storageMode: "in-memory" });
  return { app, skills, payments };
}

describe("skills endpoints", () => {
  it("submits a candidate as non-approved, then requires explicit approval before install", async () => {
    const { app } = deps();
    const submit = await app.inject({
      method: "POST",
      url: "/api/v1/skills/submit",
      payload: { manifest: cleanSkillManifest(), content: CLEAN_SKILL_MD },
    });
    expect(submit.statusCode).toBe(201);
    expect(submit.json().record.reviewStatus).toBe("submitted");
    expect(submit.json().record.isActive).toBe(false);

    // Install before approval: 409, not 201. Nothing auto-installs.
    const early = await app.inject({
      method: "POST",
      url: "/api/v1/skills/install",
      payload: { skillId: "liquidity-snapshot", version: "1.0.0", reviewerId: "reviewer-1" },
    });
    expect(early.statusCode).toBe(409);

    const approve = await app.inject({
      method: "POST",
      url: "/api/v1/skills/approve",
      payload: { skillId: "liquidity-snapshot", version: "1.0.0", reviewerId: "reviewer-1" },
    });
    expect(approve.statusCode).toBe(200);
    expect(approve.json().record.reviewStatus).toBe("approved");

    const install = await app.inject({
      method: "POST",
      url: "/api/v1/skills/install",
      payload: { skillId: "liquidity-snapshot", version: "1.0.0", reviewerId: "reviewer-1" },
    });
    expect(install.statusCode).toBe(200);
    expect(install.json().record.isActive).toBe(true);

    const rollback = await app.inject({
      method: "POST",
      url: "/api/v1/skills/rollback",
      payload: { skillId: "liquidity-snapshot", reviewerId: "reviewer-1" },
    });
    expect(rollback.statusCode).toBe(200);
    expect(rollback.json()).toEqual({ from: "1.0.0", to: null });
    await app.close();
  });

  it("refuses a manifest with injected privilege fields", async () => {
    const { app } = deps();
    const hostile = { ...(cleanSkillManifest() as unknown as Record<string, unknown>), permissions: { canSignTransactions: true } };
    const submit = await app.inject({
      method: "POST",
      url: "/api/v1/skills/submit",
      payload: { manifest: hostile, content: CLEAN_SKILL_MD },
    });
    expect(submit.statusCode).toBe(422);
    expect(submit.json().error).toBe("SKILL_INTAKE_REJECTED");
    await app.close();
  });

  it("lists skills with review state", async () => {
    const { app } = deps();
    const res = await app.inject({ method: "GET", url: "/api/v1/skills" });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().skills)).toBe(true);
    await app.close();
  });
});

describe("x402 payment endpoints", () => {
  it("verifies a payment, settles it with evidence, and grants content access only", async () => {
    const { app } = deps();
    const requirement = mockRequirement();
    const payment = mockPayment({ payTo: requirement.payTo as string, maxAmountRequired: requirement.maxAmountRequired as string }, randomUUID());
    const paymentId = randomUUID();
    const verify = await app.inject({
      method: "POST",
      url: "/api/v1/payments/verify",
      payload: { agentId: "trend-scout-agent", requirement, payment, paymentId },
    });
    expect(verify.statusCode).toBe(200);
    expect(verify.json().record.grants).toEqual({ contentAccess: true, trading: false });

    const settle = await app.inject({
      method: "POST",
      url: "/api/v1/payments/settle",
      payload: { paymentId, transactionHash: `mock-tx-${paymentId.slice(0, 8)}` },
    });
    expect(settle.statusCode).toBe(200);
    expect(settle.json().record.status).toBe("settled");

    // Idempotent: replaying the same paymentId does not create a second record.
    const replay = await app.inject({
      method: "POST",
      url: "/api/v1/payments/verify",
      payload: { agentId: "trend-scout-agent", requirement, payment, paymentId },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().message).toMatch(/idempotent/i);

    const list = await app.inject({ method: "GET", url: "/api/v1/payments" });
    expect(list.statusCode).toBe(200);
    expect(list.json().reconcile.consistent).toBe(true);
    expect(list.json().records.filter((record: { paymentId: string }) => record.paymentId === paymentId)).toHaveLength(1);
    await app.close();
  });

  it("rejects payments to non-allowlisted recipients with a typed code", async () => {
    const { app } = deps();
    const requirement = mockRequirement({ payTo: "0xdead00000000000000000000000000000000beef" });
    const payment = mockPayment({ payTo: requirement.payTo as string, maxAmountRequired: requirement.maxAmountRequired as string }, randomUUID());
    const verify = await app.inject({
      method: "POST",
      url: "/api/v1/payments/verify",
      payload: { agentId: "trend-scout-agent", requirement, payment, paymentId: randomUUID() },
    });
    expect(verify.statusCode).toBe(422);
    expect(verify.json().code).toBe("recipient-not-allowed");
    expect(verify.json().record.grants).toEqual({ contentAccess: false, trading: false });
    await app.close();
  });

  it("rejects settlement evidence from an unregistered facilitator", async () => {
    const { app } = deps();
    const requirement = mockRequirement();
    const payment = mockPayment({ payTo: requirement.payTo as string, maxAmountRequired: requirement.maxAmountRequired as string }, randomUUID());
    const paymentId = randomUUID();
    await app.inject({
      method: "POST",
      url: "/api/v1/payments/verify",
      payload: { agentId: "trend-scout-agent", requirement, payment, paymentId },
    });
    const settle = await app.inject({
      method: "POST",
      url: "/api/v1/payments/settle",
      // Caller-supplied "settlement evidence" is IGNORED by the server: only the
      // transaction hash is read, and the server's own facilitator produces the
      // evidence. A rogue facilitatorId in the payload body must not leak in.
      payload: { paymentId, transactionHash: "0xserver-controlled", settlement: mockSettlement("mock-tx-x", { facilitatorId: "rogue-facilitator" }) },
    });
    expect(settle.statusCode).toBe(200);
    expect(settle.json().record.facilitatorId).toBe("mock-facilitator");
    await app.close();
  });

  it("enforces per-agent spend caps across requests", async () => {
    const { app } = deps();
    const requirement = mockRequirement();
    const agent = "trend-scout-agent";
    for (let index = 0; index < 12; index++) {
      const payment = mockPayment({ payTo: requirement.payTo as string, maxAmountRequired: requirement.maxAmountRequired as string }, randomUUID());
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/payments/verify",
        payload: { agentId: agent, requirement, payment, paymentId: randomUUID() },
      });
      if (res.statusCode === 422) {
        expect(res.json().code).toBe("spend-cap-exceeded");
        return;
      }
    }
    throw new Error("expected the daily cap to be exceeded eventually");
  });

  it("rejects tampered content hashes at skill intake", async () => {
    const { app } = deps();
    const tampered = `${CLEAN_SKILL_MD}\n<!-- appended -->\n`;
    const manifest = { ...cleanSkillManifest(), contentHash: `sha256-${createHash("sha256").update(tampered).digest("hex")}` };
    const submit = await app.inject({
      method: "POST",
      url: "/api/v1/skills/submit",
      payload: { manifest, content: CLEAN_SKILL_MD },
    });
    // Stored as submitted (audit trail) but the validation report flags it.
    expect(submit.statusCode).toBe(201);
    expect(submit.json().report.passed).toBe(false);
    expect(submit.json().report.issues.some((issue: { code: string }) => issue.code === "content-hash-mismatch")).toBe(true);
    const approve = await app.inject({
      method: "POST",
      url: "/api/v1/skills/approve",
      payload: { skillId: "liquidity-snapshot", version: "1.0.0", reviewerId: "reviewer-1" },
    });
    expect(approve.statusCode).toBe(409);
    await app.close();
  });
});

describe("x402 route gating (service catalog)", () => {
  const config = loadConfig({ DATA_SOURCE: "fixture" });
  const logger = createLogger({ service: "test", level: "fatal" });
  const bus = new InMemoryEventBus();
  const engine = new OrchestrationEngine({ bus, logger, clock: { now: () => NOW } });
  registerResearchAgents(engine);
  const payments = buildPaymentsStack(config, logger, { now: () => NOW });
  const policyEngine = new DeterministicPolicyEngine({
    policyVersion: "0.1.0",
    rules: { allowedChains: ["base", "solana"], maxNotionalUsdCents: 50000 },
  });
  const makeApp = async () => {
    const publisher = await createEventPublisher({});
    return buildApp({
      config, logger, engine,
      skills: buildSkillsStack(config, logger, { now: () => NOW }).registry,
      payments,
      api: { publisher, policyEngine, busMode: "in-memory" },
      storageMode: "in-memory",
    });
  };
  it("402s an unpaid priced route with the requirement for the project wallet", async () => {
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: "/api/v1/tokens" });
    expect(res.statusCode).toBe(402);
    const body = res.json() as {
      error: string; serviceId: string; priceUsd: string;
      requirement: { payTo: string; maxAmountRequired: string; network: number };
    };
    expect(body.error).toBe("PAYMENT_REQUIRED");
    expect(body.serviceId).toBe("tokens.snapshot");
    expect(body.priceUsd).toBe("0.01");
    expect(body.requirement.payTo).toBe("0x0bee61d45d42d7342d57ea7581d17581203447a8"); // our wallet, not the watched trader
    expect(body.requirement.maxAmountRequired).toBe("10000"); // $0.01 in USDC atomic units
    expect(res.headers["x-payments-version"]).toBe("1");
  });

  it("LIVE mode: a recorded-but-unsettled payment does NOT unlock content until settled on-chain", async () => {
    const liveConfig = loadConfig({ PAYMENTS_MODE: "live", BASE_RPC_URL: "https://mainnet.base.org" , DATA_SOURCE: "fixture" });
    const livePayments = buildPaymentsStack(liveConfig, logger, { now: () => NOW });
    const publisher = await createEventPublisher({});
    const app = await buildApp({
      config: liveConfig, logger, engine,
      skills: buildSkillsStack(liveConfig, logger, { now: () => NOW }).registry,
      payments: livePayments,
      api: { publisher, policyEngine, busMode: "in-memory" },
      storageMode: "in-memory",
    });
    const requirement = mockRequirement({ maxAmountRequired: "10000" });
    // LIVE mode verifies signatures cryptographically: sign a real EIP-3009
    // authorization over the USDC domain on Base.
    const account = privateKeyToAccount(generatePrivateKey());
    const nonce = randomUUID();
    // Match the suite's fixed clock (April 1 2026, 12:00:30Z).
    const validAfter = new Date(Date.parse("2026-04-01T11:59:00.000Z")).toISOString();
    const validBefore = new Date(Date.parse("2026-04-01T12:05:00.000Z")).toISOString();
    const signature = await account.signTypedData({
      domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" },
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
        from: account.address,
        to: requirement.payTo as `0x${string}`,
        value: 10000n,
        validAfter: BigInt(Math.floor(Date.parse(validAfter) / 1000)),
        validBefore: BigInt(Math.floor(Date.parse(validBefore) / 1000)),
        nonce: ("0x" + nonce.replace(/-/g, "").padStart(64, "0")) as unknown as `0x${string}`,
      },
    });
    const payment = mockPayment({ payTo: requirement.payTo as string, maxAmountRequired: "10000" }, nonce, {
      from: account.address, validAfter, validBefore, signature,
    });
    const paymentId = randomUUID();
    // The guard accepts the cryptographically valid payment...
    const verify = await app.inject({
      method: "POST", url: "/api/v1/payments/verify",
      payload: { agentId: "trend-scout-agent", requirement, payment, paymentId },
    });
    expect(verify.statusCode).toBe(200);
    // ...but in LIVE mode the record is only "recorded" — the gate must 402.
    const gated = await app.inject({ method: "GET", url: "/api/v1/tokens", headers: { "x-payments": paymentId } });
    expect(gated.statusCode).toBe(402);
    await app.close();
  });

  it("serves a priced route after a confirmed exact payment (and rejects wrong amounts)", async () => {
    const app = await makeApp();
    // An underpayment is a VALID payment ($0.0001, guard records it)...
    const wrongReq = mockRequirement({ maxAmountRequired: "100" });
    const wrongPay = mockPayment({ payTo: wrongReq.payTo as string, maxAmountRequired: wrongReq.maxAmountRequired as string }, randomUUID());
    const wrongPaymentId = randomUUID();
    const w = await app.inject({ method: "POST", url: "/api/v1/payments/verify", payload: { agentId: "trend-scout-agent", requirement: wrongReq, payment: wrongPay, paymentId: wrongPaymentId } });
    expect(w.statusCode).toBe(200);
    // ...but the gate still 402s: the record amount does not match the $0.01 catalog price.
    const still402 = await app.inject({ method: "GET", url: "/api/v1/tokens", headers: { "x-payments": wrongPaymentId } });
    expect(still402.statusCode).toBe(402);

    const requirement = mockRequirement({ maxAmountRequired: "10000" }); // $0.01 tokens.snapshot price
    const payment = mockPayment({ payTo: requirement.payTo as string, maxAmountRequired: "10000" }, randomUUID());
    const paymentId = randomUUID();
    const verify = await app.inject({ method: "POST", url: "/api/v1/payments/verify", payload: { agentId: "trend-scout-agent", requirement, payment, paymentId } });
    expect(verify.statusCode).toBe(200);
    const ok = await app.inject({ method: "GET", url: "/api/v1/tokens", headers: { "x-payments": paymentId } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toHaveProperty("tokens");
    // replaying the paymentId on another priced route with a different price fails
    const bad = await app.inject({ method: "POST", url: "/api/v1/tasks", headers: { "x-payments": paymentId }, payload: { agentId: "research-agent", taskType: "research-topic", input: { topic: "x" } } });
    expect(bad.statusCode).toBe(402); // $0.01 payment does not unlock a $0.10 task
  });

  it("402s the newly priced data routes (token detail, price, risk, whales)", async () => {
    const app = await makeApp();
    const cases: Array<{ url: string; serviceId: string }> = [
      { url: "/api/v1/tokens/base/0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", serviceId: "token.detail" },
      { url: "/api/v1/price?chain=base&address=0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", serviceId: "price.check" },
      { url: "/api/v1/risk?chain=base", serviceId: "risk.check" },
      { url: "/api/v1/whales?chain=base", serviceId: "whales.list" },
    ];
    for (const c of cases) {
      const res = await app.inject({ method: "GET", url: c.url });
      expect(res.statusCode).toBe(402);
      expect((res.json() as { serviceId: string }).serviceId).toBe(c.serviceId);
    }
    await app.close();
  });

  it("publishes the catalog and free routes stay open", async () => {
    const app = await makeApp();
    const cat = await app.inject({ method: "GET", url: "/api/v1/payments/catalog" });
    expect(cat.statusCode).toBe(200);
    const body = cat.json() as { receiver: string; services: { serviceId: string; priceUsd: string }[] };
    expect(body.receiver).toBe("0x0bee61d45d42d7342d57ea7581d17581203447a8");
    expect(body.services.map((s) => s.serviceId)).toEqual(
      expect.arrayContaining(["tokens.snapshot", "fees.snapshot", "signals.evaluate", "tasks.research", "workflows.research", "token.detail", "price.check", "risk.check", "whales.list"]),
    );
    const agents = await app.inject({ method: "GET", url: "/api/v1/agents" });
    expect(agents.statusCode).toBe(200); // discovery stays free
  });
});
