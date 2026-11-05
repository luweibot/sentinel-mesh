import { SUPPORTED_X402_VERSION } from "@sentinel-mesh/contracts";

/**
 * Canonical x402 client compatibility.
 *
 * WHY THIS EXISTS
 * ---------------
 * Our original flow was private to us: the payer sent the payment to
 * POST /api/v1/payments/verify, received a paymentId, and retried the
 * original request with `X-PAYMENTS: <paymentId>`. Standard x402 clients
 * do something completely different — they sign an EIP-3009
 * transferWithAuthorization, base64 it into a single `X-PAYMENT` header
 * (singular) with scheme `exact`, and replay the request with that header.
 * They never call a verify endpoint.
 *
 * Verified 2026-11-05: a standard third-party agent runtime (Thirdeye)
 * sends the canonical header, so our priced routes were unbuyable by any
 * standard client. This module translates a canonical header into the
 * internal payload the guard already validates, so both client styles work
 * against the same exact-in checks, spend caps and replay protection.
 *
 * It performs NO verification of its own: parsing and normalisation only.
 * Every semantic check (chain, asset, recipient, exact amount, signature,
 * time window, nonce replay, spend caps) stays in the guard.
 */

/** What the guard needs to process a canonical payment. */
export interface CanonicalX402Payment {
  /** Payer address; also the identity the spend caps are keyed on. */
  agentId: string;
  /** Deterministic id, so a retried header cannot double-count. */
  paymentId: string;
  /**
   * The authorization in the shape the settlement broadcaster needs
   * (ISO validity window, 65-byte signature). Present so the server can
   * submit transferWithAuthorization for a canonical buyer.
   */
  authorization: {
    from: string;
    to: string;
    value: string;
    validAfter: string;
    validBefore: string;
    nonce: string;
    signature: string;
  };
  /** Internal payload shape (X402PaymentPayload) the guard validates. */
  payment: {
    x402Version: string;
    scheme: string;
    payload: {
      from: string;
      to: string;
      value: string;
      nonce: string;
      validAfter: string;
      validBefore: string;
      signature: string;
    };
  };
}

export type CanonicalParseResult =
  | { ok: true; value: CanonicalX402Payment }
  | { ok: false; reason: string };

/**
 * Decode a base64 or base64url JSON header value.
 * Clients differ on padding and on `-`/`_` vs `+`/`/`, so accept both.
 */
export function decodePaymentHeader(header: string): unknown {
  const normalised = header.trim().replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalised + "=".repeat((4 - (normalised.length % 4)) % 4);
  let json: string;
  try {
    json = Buffer.from(padded, "base64").toString("utf8");
  } catch {
    throw new Error("X-PAYMENT is not valid base64");
  }
  try {
    return JSON.parse(json);
  } catch {
    throw new Error("X-PAYMENT does not decode to JSON");
  }
}

/** EIP-3009 time fields: canonical clients send unix seconds, we store ISO. */
function toIsoDateTime(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value * 1000).toISOString();
  }
  if (typeof value === "string") {
    if (/^\d+$/.test(value)) return new Date(Number(value) * 1000).toISOString();
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
  }
  return undefined;
}

/**
 * Canonical clients name the chain loosely: "base", "8453", "eip155:8453"
 * or a bare number. Normalise to the numeric evm chain id the guard checks.
 */
function toChainId(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string") {
    const trimmed = value.trim().toLowerCase();
    if (trimmed === "base") return 8453;
    if (trimmed === "ethereum" || trimmed === "mainnet") return 1;
    const caip = /^eip155:(\d+)$/.exec(trimmed);
    if (caip) return Number(caip[1]);
    if (/^\d+$/.test(trimmed)) return Number(trimmed);
  }
  return undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Parse an `X-PAYMENT` header into the internal payment payload.
 *
 * Accepts the canonical envelope
 *   { scheme, network, payload: { signature, authorization: {from,to,value,validAfter,validBefore,nonce} } }
 * and our own envelope
 *   { x402Version, scheme, payload: { from,to,value,nonce,validAfter,validBefore,signature } }
 * so a client that learned our shape keeps working too.
 */
export function parseCanonicalX402Payment(header: string): CanonicalParseResult {
  let decoded: unknown;
  try {
    decoded = decodePaymentHeader(header);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "unreadable X-PAYMENT header" };
  }
  if (typeof decoded !== "object" || decoded === null) {
    return { ok: false, reason: "X-PAYMENT must decode to a JSON object" };
  }

  const envelope = decoded as Record<string, unknown>;
  const rawScheme = str(envelope.scheme)?.toLowerCase();
  if (rawScheme !== "exact" && rawScheme !== "exactinevm") {
    return { ok: false, reason: `unsupported scheme '${String(envelope.scheme)}' (expected 'exact')` };
  }

  const network = toChainId(envelope.network);
  if (network === undefined) {
    return { ok: false, reason: `unreadable network '${String(envelope.network)}'` };
  }

  const payload = envelope.payload;
  if (typeof payload !== "object" || payload === null) {
    return { ok: false, reason: "X-PAYMENT is missing its payload" };
  }
  const outer = payload as Record<string, unknown>;
  // Canonical nests the authorization; ours is flat.
  const inner =
    typeof outer.authorization === "object" && outer.authorization !== null
      ? (outer.authorization as Record<string, unknown>)
      : outer;

  const from = str(inner.from);
  const to = str(inner.to);
  const value = str(inner.value);
  const nonce = str(inner.nonce);
  const signature = str(outer.signature) ?? str(inner.signature);
  const validAfter = toIsoDateTime(inner.validAfter);
  const validBefore = toIsoDateTime(inner.validBefore);

  const missing = [
    ["from", from],
    ["to", to],
    ["value", value],
    ["nonce", nonce],
    ["signature", signature],
    ["validAfter", validAfter],
    ["validBefore", validBefore],
  ]
    .filter(([, v]) => v === undefined)
    .map(([k]) => k);
  if (missing.length > 0) {
    return { ok: false, reason: `X-PAYMENT is missing required fields: ${missing.join(", ")}` };
  }

  // Deterministic id: a client retrying the same authorization must not
  // create a second record or consume a second spend-cap slot.
  const paymentId = `x402:${from!.toLowerCase()}:${nonce!.toLowerCase()}`;

  return {
    ok: true,
    value: {
      agentId: from!,
      paymentId,
      authorization: {
        from: from!,
        to: to!,
        value: value!,
        validAfter: validAfter!,
        validBefore: validBefore!,
        nonce: nonce!,
        signature: signature!,
      },
      payment: {
        x402Version: SUPPORTED_X402_VERSION,
        scheme: "exactInEvm",
        payload: {
          from: from!,
          to: to!,
          value: value!,
          nonce: nonce!,
          validAfter: validAfter!,
          validBefore: validBefore!,
          signature: signature!,
        },
      },
    },
  };
}

/**
 * The canonical `accepts` entry for a requirement. Standard clients read
 * this array, so it must advertise the canonical scheme name (`exact`)
 * even though we accept both.
 */
export function canonicalAccepts(
  requirement: Record<string, unknown>,
): Array<Record<string, unknown>> {
  return [{ ...requirement, scheme: "exact", network: "eip155:8453" }];
}

/** Encoded X-PAYMENT-RESPONSE settlement receipt value. */
export function encodePaymentResponse(body: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(body), "utf8").toString("base64");
}
