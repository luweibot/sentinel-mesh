import { describe, expect, it } from "vitest";
import {
  canonicalAccepts,
  decodePaymentHeader,
  encodePaymentResponse,
  parseCanonicalX402Payment,
} from "../src/canonical.js";

const PAYER = "0x1111111111111111111111111111111111111111";
const RECEIVER = "0x2222222222222222222222222222222222222222";
const NONCE = "0x" + "ab".repeat(32);

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

/** The envelope a standard x402 client actually sends. */
function canonicalEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    x402Version: 1,
    scheme: "exact",
    network: "base",
    payload: {
      signature: "0xdeadbeef",
      authorization: {
        from: PAYER,
        to: RECEIVER,
        value: "10000",
        validAfter: 1_700_000_000,
        validBefore: 1_700_003_600,
        nonce: NONCE,
      },
    },
    ...overrides,
  };
}

describe("canonical x402 header decoding", () => {
  it("decodes standard base64", () => {
    const decoded = decodePaymentHeader(b64({ hello: "world" })) as { hello: string };
    expect(decoded.hello).toBe("world");
  });

  it("decodes base64url without padding", () => {
    const urlSafe = Buffer.from(JSON.stringify({ a: 1 }), "utf8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(decodePaymentHeader(urlSafe)).toEqual({ a: 1 });
  });

  it("rejects non-base64 and non-JSON values", () => {
    expect(() => decodePaymentHeader("!!!not-base64!!!")).toThrow(/base64|JSON/);
    expect(() => decodePaymentHeader(Buffer.from("not json").toString("base64"))).toThrow(/JSON/);
  });
});

describe("parseCanonicalX402Payment", () => {
  it("maps the canonical envelope onto the internal payload", () => {
    const result = parseCanonicalX402Payment(b64(canonicalEnvelope()));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The payer is the agent identity the spend caps key on.
    expect(result.value.agentId).toBe(PAYER);
    // Unix seconds arrive as ISO datetimes for the guard.
    expect(result.value.payment.payload.validAfter).toBe("2023-11-14T22:13:20.000Z");
    expect(result.value.payment.payload.validBefore).toBe("2023-11-14T23:13:20.000Z");
    // We normalise the scheme name so the guard's enum accepts it.
    expect(result.value.payment.scheme).toBe("exactInEvm");
    expect(result.value.payment.payload.value).toBe("10000");
  });

  it("derives a deterministic paymentId so retries cannot double-count", () => {
    const first = parseCanonicalX402Payment(b64(canonicalEnvelope()));
    const second = parseCanonicalX402Payment(b64(canonicalEnvelope()));
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value.paymentId).toBe(second.value.paymentId);
    expect(first.value.paymentId).toBe(`x402:${PAYER}:${NONCE}`);
  });

  it("gives different payers or nonces different ids", () => {
    const other = canonicalEnvelope();
    (other.payload.authorization as Record<string, unknown>).nonce = "0x" + "cd".repeat(32);
    const a = parseCanonicalX402Payment(b64(canonicalEnvelope()));
    const b = parseCanonicalX402Payment(b64(other));
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.value.paymentId).not.toBe(b.value.paymentId);
  });

  it("accepts our own flat payload shape too", () => {
    const flat = {
      x402Version: "1",
      scheme: "exactInEvm",
      network: 8453,
      payload: {
        from: PAYER,
        to: RECEIVER,
        value: "20000",
        nonce: NONCE,
        validAfter: "2023-11-14T22:13:20.000Z",
        validBefore: "2023-11-14T23:13:20.000Z",
        signature: "0xsig",
      },
    };
    const result = parseCanonicalX402Payment(b64(flat));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.payment.payload.validAfter).toBe("2023-11-14T22:13:20.000Z");
    expect(result.value.payment.payload.value).toBe("20000");
  });

  it("normalises CAIP-2 and bare numeric networks", () => {
    for (const network of ["eip155:8453", 8453, "8453"]) {
      const parsed = parseCanonicalX402Payment(b64(canonicalEnvelope({ network })));
      expect(parsed.ok).toBe(true);
    }
  });

  it("rejects an unknown scheme", () => {
    const parsed = parseCanonicalX402Payment(b64(canonicalEnvelope({ scheme: "upto" })));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain("unsupported scheme");
  });

  it("rejects an unreadable network", () => {
    const parsed = parseCanonicalX402Payment(b64(canonicalEnvelope({ network: "solana" })));
    expect(parsed.ok).toBe(false);
  });

  it("names every missing required field", () => {
    const broken = canonicalEnvelope();
    delete (broken.payload.authorization as Record<string, unknown>).nonce;
    delete (broken.payload.authorization as Record<string, unknown>).value;
    const parsed = parseCanonicalX402Payment(b64(broken));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain("nonce");
    expect(parsed.reason).toContain("value");
  });

  it("rejects a non-object payload", () => {
    expect(parseCanonicalX402Payment(b64({ scheme: "exact", network: 8453 })).ok).toBe(false);
    expect(parseCanonicalX402Payment(b64("nope")).ok).toBe(false);
  });
});

describe("canonicalAccepts", () => {
  it("advertises the canonical scheme name and CAIP-2 network", () => {
    const [accept] = canonicalAccepts({
      scheme: "exactInEvm",
      network: 8453,
      asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      maxAmountRequired: "10000",
      payTo: RECEIVER,
      maxTimeoutSeconds: 300,
      mimeType: "application/json",
    });
    expect(accept.scheme).toBe("exact");
    expect(accept.network).toBe("eip155:8453");
    // The rest of the requirement is passed through untouched.
    expect(accept.maxAmountRequired).toBe("10000");
    expect(accept.payTo).toBe(RECEIVER);
  });
});

describe("encodePaymentResponse", () => {
  it("round-trips as base64 JSON", () => {
    const encoded = encodePaymentResponse({ success: true, paymentId: "x402:a:b" });
    expect(JSON.parse(Buffer.from(encoded, "base64").toString("utf8"))).toEqual({
      success: true,
      paymentId: "x402:a:b",
    });
  });
});
