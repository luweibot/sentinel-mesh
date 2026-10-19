/**
 * Base Builder Code (ERC-8021) attribution.
 *
 * Registered via the Base agent API:
 *   POST https://api.base.dev/v1/agents/builder-codes { walletAddress }
 * The same wallet always returns the same code; safe to call on every deploy.
 *
 * The suffix is appended to every EVM transaction's calldata. Smart contracts
 * ignore the trailing bytes (offchain indexers read them), so this is safe
 * for all existing contracts with no redeployment required. Gas overhead is
 * 16 gas per non-zero byte.
 *
 * Suffix format (ERC-8021): [len: 1 byte][code: UTF-8][0x8021 repeated 8x]
 * The last 16 bytes of the calldata are the 0x8021 repeating pattern.
 */

import { Buffer } from "node:buffer";

export const BUILDER_CODE = "bc_fakbdw5t";

/** Project wallet the builder code is registered to (Base mainnet). */
export const BUILDER_CODE_WALLET = "0x0bee61d45d42d7342d57ea7581d17581203447a8";

/** 16 trailing bytes: the 0x8021 pattern repeated 8 times. */
export const ERC8021_PATTERN = `0x${"8021".repeat(8)}`;

const codeHex = Buffer.from(BUILDER_CODE, "utf8").toString("hex");
const lenHex = Buffer.from([Buffer.from(BUILDER_CODE, "utf8").length]).toString("hex");

/** The ERC-8021 attribution suffix for the builder code, hex with 0x prefix. */
export const BUILDER_CODE_SUFFIX = `0x${lenHex}${codeHex}${ERC8021_PATTERN.slice(2)}`;

/** Append the ERC-8021 attribution suffix to hex calldata (idempotent). */
export function withBuilderCodeSuffix(data: string): string {
  if (!/^0x([0-9a-fA-F]{2})*$/.test(data)) {
    throw new Error(`calldata must be hex with 0x prefix: ${data.slice(0, 10)}`);
  }
  if (data.toLowerCase().endsWith(BUILDER_CODE_SUFFIX.slice(2))) {
    return data; // already attributed
  }
  return data + BUILDER_CODE_SUFFIX.slice(2);
}

/** True when calldata ends with our valid ERC-8021 attribution suffix. */
export function isBuilderCodeAttributed(data: string): boolean {
  if (!/^0x([0-9a-fA-F]{2})*$/.test(data)) {
    return false;
  }
  const body = data.slice(2).toLowerCase();
  const suffix = BUILDER_CODE_SUFFIX.slice(2);
  const pattern = ERC8021_PATTERN.slice(2);
  return body.endsWith(pattern) && body.length >= suffix.length && body.slice(-suffix.length) === suffix;
}
