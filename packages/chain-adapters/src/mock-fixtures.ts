import { createHash } from "node:crypto";

/**
 * Deterministic fixture derivation.
 *
 * Every mock value is a pure function of its input (address, request), hashed
 * through sha256. The same input always produces the same output, which makes
 * tests, snapshots and dev runs fully deterministic.
 */

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Deterministic 4-letter uppercase token symbol derived from a seed. */
export function deriveTokenSymbol(seed: string): string {
  return `M${sha256Hex(seed).toUpperCase().slice(0, 4)}`;
}

export function deriveTokenName(seed: string): string {
  return `Mock Token ${sha256Hex(seed).toUpperCase().slice(4, 12)}`;
}

/** Deterministic EVM-style tx hash (0x + 64 hex chars). */
export function deriveEvmTxHash(seed: string): string {
  return `0x${sha256Hex(`tx:${seed}`)}`;
}

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Deterministic base58-looking string (Solana-style signature). */
export function deriveBase58Hash(seed: string, length = 88): string {
  const hash = sha256Hex(`sig:${seed}`);
  let out = "";
  for (let i = 0; i < length; i++) {
    const hexPair = hash.slice((i * 2) % 60, ((i * 2) % 60) + 2);
    const byte = parseInt(hexPair, 16);
    out += BASE58_ALPHABET.charAt(byte % BASE58_ALPHABET.length);
  }
  return out;
}

/** Deterministic whole-string amount in base units (large integer as string). */
export function deriveAmountRaw(seed: string): string {
  const hash = sha256Hex(`amt:${seed}`);
  // Build a decimal number from the hash, bounded to <= 10^18-ish.
  let amount = "";
  for (let i = 0; i < 8; i++) {
    amount += String(parseInt(hash.slice(i * 2, i * 2 + 2), 16) % 10);
  }
  // Strip leading zeros but always keep at least 1 digit.
  return amount.replace(/^0+(?=.)/, "");
}
