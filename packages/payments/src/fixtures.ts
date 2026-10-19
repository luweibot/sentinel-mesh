import type { AssetAllowlistEntry, RecipientAllowlistEntry } from "@sentinel-mesh/contracts";

/**
 * Deterministic x402 MOCK fixtures (USDC-style stablecoin shapes, no real
 * contracts, no keys, no network). Tests use these to exercise every
 * guard path. `paymentSignatureOf` derives a deterministic
 * pseudo-signature — the guard treats signature bytes as opaque
 * evidence, never as authority.
 */

export const BASE_TIME = Date.parse("2026-04-01T12:00:00.000Z");

export const MOCK_ASSETS: AssetAllowlistEntry[] = [
  { chain: "base", address: "0x833589fcd6edb6e08f4c2c6ff80ffe7fd34502b0", symbol: "USDC", decimals: 6 },
  { chain: "ethereum", address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", symbol: "USDC", decimals: 6 },
];

export const MOCK_RECIPIENTS: RecipientAllowlistEntry[] = [
  // Fixture recipient only (paper tests): this address is the WATCHED TRADER
  // ("Base Trader #1" in WatchedWallet), not the project wallet. The real
  // receiver is wired from AppConfig.paymentsReceiverAddress (our wallet).
  // OUR project wallet (EVM_PRIVATE_KEY holder, x402 receiver in prod and
  // default payTo in mockRequirement below).
  { address: "0x0bee61d45d42d7342d57ea7581d17581203447a8", label: "sentinel-mesh project wallet" },
  { address: "0xa94c05c9949cafd958c858036c4830cd8bc1618a", label: "watched-trader-fixture (demo)" },
  { address: "0x9990000000000000000000000000000000000001", label: "data-provider-a (demo)" },
  { address: "0x9990000000000000000000000000000000000002", label: "data-provider-b (demo)" },
];

export function mockRequirement(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    scheme: "exactInEvm",
    network: 8453,
    asset: "0x833589fcd6edb6e08f4c2c6ff80ffe7fd34502b0",
    maxAmountRequired: "1000000",
    // Default receiver: OUR project wallet — matches the guard recipient
    // allowlist wired from AppConfig.paymentsReceiverAddress.
    payTo: "0x0bee61d45d42d7342d57ea7581d17581203447a8",
    maxTimeoutSeconds: 300,
    mimeType: "application/json",
    extra: { name: "sentinel-mesh-data", version: "1", description: "demo fixture" },
    ...overrides,
  };
}

export function mockPayment(
  requirement: { payTo: string; maxAmountRequired: string },
  nonce: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    x402Version: "1",
    scheme: "exactInEvm",
    payload: {
      from: "0x1110000000000000000000000000000000000001",
      to: requirement.payTo,
      value: requirement.maxAmountRequired,
      nonce,
      validAfter: new Date(BASE_TIME - 60_000).toISOString(),
      validBefore: new Date(BASE_TIME + 300_000).toISOString(),
      signature: paymentSignatureOf(nonce),
      ...overrides,
    },
  };
}

export function mockSettlement(transactionHash: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    scheme: "exactInEvm",
    network: 8453,
    payload: { success: true, transactionHash },
    facilitatorId: "mock-facilitator",
    settledAt: new Date(BASE_TIME).toISOString(),
    ...overrides,
  };
}

/** Deterministic pseudo-signature (fixture only; guard treats it as opaque). */
export function paymentSignatureOf(nonce: string): string {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(nonce, "utf8")) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `0x${hash.toString(16).padStart(64, "0")}`;
}
