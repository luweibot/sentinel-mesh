import { z } from "zod";

/**
 * Shared primitive schemas used across all Sentinel Mesh contracts.
 * Every schema in this package is the single source of truth; do not
 * duplicate validation logic in services.
 */

/** Lowercase kebab-case identifier, e.g. "trend-scout". */
export const Slug = z.string().regex(/^[a-z][a-z0-9-]*$/, "must be a lowercase kebab-case slug");

/** Strict semver (major.minor.patch), e.g. "0.1.0". */
export const Semver = z.string().regex(/^\d+\.\d+\.\d+$/, "must be semver (major.minor.patch)");

/** Chains supported by the platform in phase 0. */
export const ChainId = z.enum(["base", "ethereum", "solana", "solana-mainnet", "solana-devnet"]);
export type ChainId = z.infer<typeof ChainId>;

/** EVM address (EIP-55-insensitive, 20 bytes hex). */
export const EvmAddress = z.string().regex(/^0x[a-fA-F0-9]{40}$/, "must be a 20-byte hex EVM address");

/** Base58 Solana public key (32-44 chars, base58 alphabet). */
export const SolanaAddress = z
  .string()
  .regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "must be a base58 Solana address");

/** RFC 4122 UUID v4. */
export const Uuid = z.string().uuid();

/** ISO-8601 date-time string with timezone, e.g. "2026-01-01T00:00:00.000Z". */
export const IsoDateTime = z.string().datetime({ offset: true });

/** Non-empty token identifier (chain-agnostic; validate per chain at the adapter). */
export const TokenAddress = z.string().min(1);

/** Positive integer amount in USD cents. $5.00 -> 500. */
export const UsdCents = z.number().int().positive();

/** Structured error used in task results, workflow steps, and API errors. */
export const StructuredError = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    details: z.unknown().optional(),
  })
  .strict();
export type StructuredError = z.infer<typeof StructuredError>;
