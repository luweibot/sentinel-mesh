import { describe, expect, it } from "vitest";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { PassThrough } from "node:stream";
import { loadConfig } from "@sentinel-mesh/config";
import { createLogger } from "@sentinel-mesh/logger";
import { InMemoryEventBus, createEventPublisher } from "@sentinel-mesh/queue";
import { DeterministicPolicyEngine } from "@sentinel-mesh/policy-engine";
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

const NOW = new Date("2026-04-01T12:00:30.000Z");
const PAYER = "0x1111111111111111111111111111111111111111";
const NONCE = "0x" + "ab".repeat(32);


/** Same stack as makeApp, but with an explicit config and optional settlement. */
async function makeAppWith(config: ReturnType<typeof loadConfig>, settlement?: unknown) {
  const sink = new PassThrough();
  sink.resume();
  const logger = createLogger({ service: "test", level: "silent", destination: sink });
  const engine = new OrchestrationEngine({
    bus: new InMemoryEventBus(),
    taskStore: new InMemoryTaskStore(),
    runStore: new InMemoryRunStore(),
    outbox: new InMemoryEventOutbox(),
    processedEvents: new InMemoryProcessedEvents(),
    clock: { now: () => NOW },
    logger,
  });
  registerResearchAgents(engine);
  const skills = buildSkillsStack(config, logger, { now: () => NOW }).registry;
  const payments = buildPaymentsStack(config, logger, { now: () => NOW });
  const publisher = await createEventPublisher({});
  const policyEngine = new DeterministicPolicyEngine({
    policyVersion: "0.1.0",
    rules: { allowedChains: ["base", "solana"], maxNotionalUsdCents: 50000 },
  });
  return buildApp({
    config,
    logger,
    engine,
    skills,
    payments,
    api: { publisher, policyEngine, busMode: "in-memory" },
    storageMode: "in-memory",
    settlement,
  });
}

async function makeApp() {
  const config = loadConfig({ DATA_SOURCE: "fixture" });
  const sink = new PassThrough();
  sink.resume();
  const logger = createLogger({ service: "test", level: "silent", destination: sink });
  const engine = new OrchestrationEngine({
    bus: new InMemoryEventBus(),
    taskStore: new InMemoryTaskStore(),
    runStore: new InMemoryRunStore(),
    outbox: new InMemoryEventOutbox(),
    processedEvents: new InMemoryProcessedEvents(),
    clock: { now: () => NOW },
    logger,
  });
  registerResearchAgents(engine);
  const skills = buildSkillsStack(config, logger, { now: () => NOW }).registry;
  const payments = buildPaymentsStack(config, logger, { now: () => NOW });
  const publisher = await createEventPublisher({});
  const policyEngine = new DeterministicPolicyEngine({
    policyVersion: "0.1.0",
    rules: { allowedChains: ["base", "solana"], maxNotionalUsdCents: 50000 },
  });
  const app = buildApp({
    config,
    logger,
    engine,
    skills,
    payments,
    api: { publisher, policyEngine, busMode: "in-memory" },
    storageMode: "in-memory",
  });
  return { app, payments };
}

/** Exactly what a standard x402 client puts in the singular X-PAYMENT header. */
function canonicalHeader(overrides: Record<string, unknown> = {}, authOverrides: Record<string, unknown> = {}) {
  const envelope = {
    x402Version: 1,
    scheme: "exact",
    network: "base",
    payload: {
      signature: "0xpaper-mode-opaque-signature",
      authorization: {
        from: PAYER,
        to: "0x250cf8852e5236dcaf5ee7f06d1e0f5800413866",
        value: "10000",
        // Paper mode validates the window against the fixed test clock.
        validAfter: Math.floor(Date.parse("2026-04-01T11:59:00.000Z") / 1000),
        validBefore: Math.floor(Date.parse("2026-04-01T12:05:00.000Z") / 1000),
        nonce: NONCE,
        ...authOverrides,
      },
      ...overrides,
    },
  };
  return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64");
}

describe("canonical x402 client support", () => {
  it("advertises the canonical shape on the unpaid 402", async () => {
    const { app } = await makeApp();
    const res = await app.inject({ method: "GET", url: "/api/v1/tokens" });
    expect(res.statusCode).toBe(402);
    const body = res.json() as {
      x402Version: number;
      accepts: Array<{ scheme: string; network: string; maxAmountRequired: string; payTo: string }>;
      requirement: { scheme: string };
    };
    // Canonical clients read these two fields.
    expect(body.x402Version).toBe(1);
    expect(body.accepts).toHaveLength(1);
    expect(body.accepts[0].scheme).toBe("exact");
    expect(body.accepts[0].network).toBe("eip155:8453");
    expect(body.accepts[0].maxAmountRequired).toBe("10000");
    expect(body.accepts[0].payTo).toBe("0x250cf8852e5236dcaf5ee7f06d1e0f5800413866");
    // Our own requirement shape is still there for existing clients.
    expect(body.requirement.scheme).toBe("exactInEvm");
  });

  it("unlocks content when a canonical X-PAYMENT authorization is presented (paper mode)", async () => {
    const { app } = await makeApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/tokens",
      headers: { "x-payment": canonicalHeader() },
    });
    expect(res.statusCode).toBe(200);
    const receipt = JSON.parse(Buffer.from(String(res.headers["x-payment-response"]), "base64").toString("utf8"));
    expect(receipt.success).toBe(true);
    expect(receipt.paymentId).toBe(`x402:${PAYER}:${NONCE}`);
  });

  it("is idempotent: replaying the same header does not create a second payment", async () => {
    const { app } = await makeApp();
    const header = canonicalHeader();
    const first = await app.inject({ method: "GET", url: "/api/v1/tokens", headers: { "x-payment": header } });
    const second = await app.inject({ method: "GET", url: "/api/v1/tokens", headers: { "x-payment": header } });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    const records = await app.inject({ method: "GET", url: "/api/v1/payments" });
    const ids = (records.json() as { records: Array<{ paymentId: string }> }).records
      .map((r) => r.paymentId)
      .filter((id) => id === `x402:${PAYER}:${NONCE}`);
    expect(ids).toHaveLength(1);
  });

  it("rejects an underpayment with a canonical 402 and a reason", async () => {
    const { app } = await makeApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/tokens",
      headers: { "x-payment": canonicalHeader({}, { value: "1" }) },
    });
    expect(res.statusCode).toBe(402);
    const body = res.json() as { rejection?: string; accepts: unknown[] };
    // The guard names the exact-in mismatch precisely; accept either wording.
    expect(body.rejection).toMatch(/value|amount/i);
    expect(body.accepts).toHaveLength(1);
  });

  it("rejects a payment addressed to the wrong recipient", async () => {
    const { app } = await makeApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/tokens",
      headers: { "x-payment": canonicalHeader({}, { to: "0x9999999999999999999999999999999999999999" }) },
    });
    expect(res.statusCode).toBe(402);
    expect((res.json() as { rejection?: string }).rejection).toBeDefined();
  });

  it("rejects a malformed header without crashing", async () => {
    const { app } = await makeApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/tokens",
      headers: { "x-payment": "%%%not-base64%%%" },
    });
    expect(res.statusCode).toBe(402);
    expect((res.json() as { rejection?: string }).rejection).toMatch(/base64|JSON/i);
  });

  it("still honours our own X-PAYMENTS paymentId flow", async () => {
    const { app } = await makeApp();
    const verify = await app.inject({
      method: "POST",
      url: "/api/v1/payments/verify",
      payload: {
        agentId: "legacy-agent",
        paymentId: "8f2a6f7c-0e39-4d6a-9b3a-1f7a9f2a4c11",
        requirement: {
          scheme: "exactInEvm",
          network: 8453,
          asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
          maxAmountRequired: "10000",
          payTo: "0x250cf8852e5236dcaf5ee7f06d1e0f5800413866",
          maxTimeoutSeconds: 300,
          mimeType: "application/json",
        },
        payment: {
          x402Version: "1",
          scheme: "exactInEvm",
          payload: {
            from: PAYER,
            to: "0x250cf8852e5236dcaf5ee7f06d1e0f5800413866",
            value: "10000",
            nonce: "0x" + "ef".repeat(32),
            validAfter: "2026-04-01T11:59:00.000Z",
            validBefore: "2026-04-01T12:05:00.000Z",
            signature: "0xopaque",
          },
        },
      },
    });
    expect(verify.statusCode).toBe(200);
    const paid = await app.inject({
      method: "GET",
      url: "/api/v1/tokens",
      headers: { "x-payments": "8f2a6f7c-0e39-4d6a-9b3a-1f7a9f2a4c11" },
    });
    expect(paid.statusCode).toBe(200);
  });
});


describe("inline settlement wiring", () => {
  /**
   * A real EIP-3009 signature: in LIVE mode the guard verifies it
   * cryptographically, so the settlement path is only reachable with a
   * genuine one. No funds are involved and nothing is broadcast.
   */
  async function canonicalHeaderFor(valueAtomic = 10000) {
    const account = privateKeyToAccount(generatePrivateKey());
    const authorization = {
      from: account.address,
      to: "0x250cf8852e5236dcaf5ee7f06d1e0f5800413866" as const,
      value: BigInt(valueAtomic),
      // the app clock is pinned to NOW, so the window must straddle NOW
      validAfter: BigInt(Math.floor(NOW.getTime() / 1000) - 60),
      validBefore: BigInt(Math.floor(NOW.getTime() / 1000) + 300),
      nonce: ("0x" + "cd".repeat(32)) as `0x${string}`,
    };
    const signature = await account.signTypedData({
      domain: {
        name: "USD Coin",
        version: "2",
        chainId: 8453,
        verifyingContract: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      },
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
      message: authorization,
    });
    const envelope = {
      x402Version: 1,
      scheme: "exact",
      network: "eip155:8453",
      payload: {
        signature,
        authorization: {
          from: authorization.from,
          to: authorization.to,
          value: authorization.value.toString(),
          validAfter: authorization.validAfter.toString(),
          validBefore: authorization.validBefore.toString(),
          nonce: authorization.nonce,
        },
      },
    };
    return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64");
  }

  it("LIVE + settlement switched off: still 402, and says so", async () => {
    const live = loadConfig({
      PAYMENTS_MODE: "live",
      BASE_RPC_URL: "https://mainnet.base.org",
      DATA_SOURCE: "fixture",
      SETTLEMENT_ENABLED: "false",
    });
    const app = await makeAppWith(live);
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/tokens",
      headers: { "x-payment": await canonicalHeaderFor() },
    });
    expect(res.statusCode).toBe(402);
    const body = res.json() as { accepts: unknown[] };
    expect(body.accepts).toHaveLength(1);
  });

  it("LIVE + a broadcaster that declines: 402 carries the reason, never content", async () => {
    const live = loadConfig({
      PAYMENTS_MODE: "live",
      BASE_RPC_URL: "https://mainnet.base.org",
      DATA_SOURCE: "fixture",
      SETTLEMENT_ENABLED: "true",
    });
    const declining = {
      async settle() {
        return { ok: false as const, code: "fee-too-high", message: "network fee 9 wei exceeds ceiling 1 wei" };
      },
    };
    const app = await makeAppWith(live, declining);
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/tokens",
      headers: { "x-payment": await canonicalHeaderFor() },
    });
    expect(res.statusCode).toBe(402);
    const receipt = JSON.parse(
      Buffer.from(String(res.headers["x-payment-response"]), "base64").toString("utf8"),
    ) as { success: boolean; reason: string };
    expect(receipt.success).toBe(false);
    expect(receipt.reason).toMatch(/fee-too-high|exceeds ceiling/);
  });
});
