import { z } from "zod";
import type { SupportedChain } from "./registry.js";

/**
 * Normalized token identities.
 *
 * CORE RULE: a ticker symbol is NOT a token identifier. The unique identity
 * of a token is (chain, on-chain address). Symbols are advisory display
 * metadata only: two different tokens may share a symbol, and nothing in
 * this package ever resolves a symbol to one address. `uniqueTokenKey` is
 * the ONLY canonical identity function.
 */

export const EVM_ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;
export const SOLANA_ADDRESS_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export const EvmAddress = z.string().regex(EVM_ADDRESS_PATTERN, "must be a lowercase 0x-hex EVM address");
export const SolanaAddress = z.string().regex(SOLANA_ADDRESS_PATTERN, "must be a base58 Solana address");

/** Normalize an EVM address: strip whitespace, lowercase. */
export function normalizeEvmAddress(address: string): string {
  const normalized = address.trim().toLowerCase();
  if (!EVM_ADDRESS_PATTERN.test(normalized)) {
    throw new Error(`invalid EVM address: '${address}'`);
  }
  return normalized;
}

/** Normalize a Solana (SPL) address: strip whitespace. */
export function normalizeSolanaAddress(address: string): string {
  const normalized = address.trim();
  if (!SOLANA_ADDRESS_PATTERN.test(normalized)) {
    throw new Error(`invalid Solana address: '${address}'`);
  }
  return normalized;
}

export const TokenIdentity = z
  .object({
    chainId: z.string().min(1),
    /** On-chain contract/mint address (normalized). */
    address: z.string().min(1),
    /** Advisory display symbol; explicitly NOT an identity component. */
    symbol: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    decimals: z.number().int().min(0).max(36).optional(),
  })
  .strict();
export type TokenIdentity = z.infer<typeof TokenIdentity>;

/** Build a validated, normalized token identity for an EVM token. */
export function evmToken(chain: SupportedChain, address: string, metadata?: { symbol?: string; name?: string; decimals?: number }): TokenIdentity {
  if (chain.kind !== "evm") {
    throw new Error(`chain '${chain.id}' is not an EVM chain`);
  }
  return TokenIdentity.parse({
    chainId: chain.id,
    address: normalizeEvmAddress(address),
    ...metadata,
  });
}

/** Build a validated, normalized token identity for a Solana SPL token. */
export function solanaToken(chain: SupportedChain, mint: string, metadata?: { symbol?: string; name?: string; decimals?: number }): TokenIdentity {
  if (chain.kind !== "solana") {
    throw new Error(`chain '${chain.id}' is not a Solana cluster`);
  }
  return TokenIdentity.parse({
    chainId: chain.id,
    address: normalizeSolanaAddress(mint),
    ...metadata,
  });
}

/** THE canonical unique identity: (chain, address). Symbols never appear. */
export function uniqueTokenKey(token: TokenIdentity): string {
  return `${token.chainId}:${token.address.toLowerCase()}`;
}

/**
 * Guard for call sites tempted to key tokens by symbol. If a caller passes
 * a symbol as the address (i.e. it is not a valid address), it throws.
 */
export function assertSymbolIsNotIdentity(chain: SupportedChain, addressOrSymbol: string): void {
  if (chain.kind === "evm" && EVM_ADDRESS_PATTERN.test(addressOrSymbol.trim().toLowerCase())) {
    return;
  }
  if (chain.kind === "solana" && SOLANA_ADDRESS_PATTERN.test(addressOrSymbol.trim())) {
    return;
  }
  throw new Error(
    `'${addressOrSymbol}' is not a valid ${chain.kind === "evm" ? "EVM" : "Solana"} address; ` +
      "ticker symbols are not token identities",
  );
}
