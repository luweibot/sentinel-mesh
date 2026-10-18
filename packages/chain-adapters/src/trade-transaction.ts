import { z } from "zod";
import { ChainId } from "@sentinel-mesh/contracts";
import { createHash } from "node:crypto";
import { sha256Hex } from "./mock-fixtures.js";

/**
 * Chain-specific transaction VALIDATION for guarded execution.
 *
 * This file defines the EVM and Solana trade-transaction surfaces used by
 * the guarded executor for pre-trade validation in the paper phase:
 *  - EvmTradeAdapter: validates an EVM transaction draft (chain binding,
 *    router allowlist, calldata size, gas bounds)
 *  - SolanaTradeAdapter: validates a Solana transaction draft (instruction
 *    count, compute budget, program allowlist, account key bounds)
 *
 * There is still NO broadcast/send method in this package. These interfaces
 * exist so a future live phase has a validated, typed seam to plug into;
 * in the paper phase they validate paper drafts only.
 */

export const EVM_ROUTER_ALLOWLIST: Record<"base" | "ethereum", string> = {
  base: `0x${sha256Hex("mock-router:base").slice(0, 40)}`,
  ethereum: `0x${sha256Hex("mock-router:ethereum").slice(0, 40)}`,
};

export const SOLANA_PROGRAM_ALLOWLIST: string[] = [
  sha256Hex("mock-program:jupiter").slice(0, 44),
  sha256Hex("mock-program:token").slice(0, 44),
];

export const EvmTransactionDraft = z
  .object({
    kind: z.literal("evm"),
    chainId: z.number().int().positive(),
    /** Expected registry chain id, checked against chainId. */
    expectedChainId: z.number().int().positive(),
    to: z.string().regex(/^0x[0-9a-f]{40}$/),
    valueWei: z.string().regex(/^\d+$/),
    /** Hex calldata with 0x prefix. */
    data: z.string().regex(/^0x([0-9a-f]{2})*$/),
    gasLimit: z.number().int().positive(),
    /** Sha-256 of the calldata the authorization bound to. */
    expectedDataHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type EvmTransactionDraft = z.infer<typeof EvmTransactionDraft>;

export const SolanaTransactionDraft = z
  .object({
    kind: z.literal("solana"),
    cluster: z.enum(["mainnet-beta", "devnet"]),
    expectedCluster: z.enum(["mainnet-beta", "devnet"]),
    instructions: z
      .array(
        z
          .object({
            programId: z.string().min(1),
            /** Number of account keys referenced by the instruction. */
            accountKeys: z.number().int().min(0),
            /** Instruction payload size in bytes. */
            dataBytes: z.number().int().min(0),
          })
          .strict(),
      )
      .min(1),
    computeUnitLimit: z.number().int().positive(),
    /** Sha-256 of the serialized instruction payloads the authorization bound to. */
    expectedPayloadHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type SolanaTransactionDraft = z.infer<typeof SolanaTransactionDraft>;

export interface ValidationProblem {
  code: string;
  message: string;
}

export interface EvmTradeAdapter {
  readonly kind: "evm";
  validateTransaction(draft: EvmTransactionDraft): { ok: boolean; problems: ValidationProblem[] };
}

export interface SolanaTradeAdapter {
  readonly kind: "solana";
  validateTransaction(draft: SolanaTransactionDraft): { ok: boolean; problems: ValidationProblem[] };
}

const EVM_MAX_CALLDATA_BYTES = 2048;
const EVM_MAX_GAS = 2_000_000;
const SOLANA_MAX_INSTRUCTIONS = 8;
const SOLANA_MAX_CU = 1_400_000;
const SOLANA_MAX_ACCOUNT_KEYS = 32;
const SOLANA_MAX_DATA_BYTES = 1024;

export function evmDataHash(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function solanaPayloadHash(payloads: string[]): string {
  return createHash("sha256").update(payloads.join("|")).digest("hex");
}

/** EVM validation: chain binding, router allowlist, calldata + gas bounds. */
export class MockEvmTradeAdapter implements EvmTradeAdapter {
  readonly kind = "evm" as const;

  constructor(private readonly routerAllowlist: Record<string, string> = EVM_ROUTER_ALLOWLIST) {}

  validateTransaction(draft: EvmTransactionDraft): { ok: boolean; problems: ValidationProblem[] } {
    const problems: ValidationProblem[] = [];
    if (draft.chainId !== draft.expectedChainId) {
      problems.push({ code: "chain-mismatch", message: `transaction targets chainId ${draft.chainId} but execution is bound to ${draft.expectedChainId}` });
    }
    const router = this.routerAllowlist[draft.chainId === 8453 ? "base" : draft.chainId === 1 ? "ethereum" : ""];
    if (!router || draft.to !== router) {
      problems.push({ code: "router-not-allowed", message: `router ${draft.to} is not on the allowlist for chainId ${draft.chainId}` });
    }
    if ((draft.data.length - 2) / 2 > EVM_MAX_CALLDATA_BYTES) {
      problems.push({ code: "calldata-too-large", message: `calldata exceeds ${EVM_MAX_CALLDATA_BYTES} bytes` });
    }
    if (draft.gasLimit > EVM_MAX_GAS) {
      problems.push({ code: "gas-limit-too-high", message: `gas limit ${draft.gasLimit} exceeds ${EVM_MAX_GAS}` });
    }
    if (evmDataHash(draft.data) !== draft.expectedDataHash) {
      problems.push({ code: "calldata-altered", message: "calldata does not match the hash the authorization bound to" });
    }
    return { ok: problems.length === 0, problems };
  }
}

/** Solana validation: cluster binding, program allowlist, CU + size bounds. */
export class MockSolanaTradeAdapter implements SolanaTradeAdapter {
  readonly kind = "solana" as const;

  constructor(private readonly programAllowlist: string[] = SOLANA_PROGRAM_ALLOWLIST) {}

  validateTransaction(draft: SolanaTransactionDraft): { ok: boolean; problems: ValidationProblem[] } {
    const problems: ValidationProblem[] = [];
    if (draft.cluster !== draft.expectedCluster) {
      problems.push({ code: "chain-mismatch", message: `transaction targets cluster ${draft.cluster} but execution is bound to ${draft.expectedCluster}` });
    }
    if (draft.instructions.length > SOLANA_MAX_INSTRUCTIONS) {
      problems.push({ code: "too-many-instructions", message: `instruction count ${draft.instructions.length} exceeds ${SOLANA_MAX_INSTRUCTIONS}` });
    }
    if (draft.computeUnitLimit > SOLANA_MAX_CU) {
      problems.push({ code: "compute-budget-too-high", message: `compute budget ${draft.computeUnitLimit} exceeds ${SOLANA_MAX_CU}` });
    }
    for (const [index, instruction] of draft.instructions.entries()) {
      if (!this.programAllowlist.includes(instruction.programId)) {
        problems.push({ code: "program-not-allowed", message: `instruction ${index} invokes non-allowlisted program ${instruction.programId}` });
      }
      if (instruction.accountKeys > SOLANA_MAX_ACCOUNT_KEYS) {
        problems.push({ code: "too-many-accounts", message: `instruction ${index} references ${instruction.accountKeys} account keys (max ${SOLANA_MAX_ACCOUNT_KEYS})` });
      }
      if (instruction.dataBytes > SOLANA_MAX_DATA_BYTES) {
        problems.push({ code: "instruction-data-too-large", message: `instruction ${index} payload is ${instruction.dataBytes} bytes (max ${SOLANA_MAX_DATA_BYTES})` });
      }
    }
    const payloads = draft.instructions.map((instruction) => `${instruction.programId}:${instruction.accountKeys}:${instruction.dataBytes}`);
    if (solanaPayloadHash(payloads) !== draft.expectedPayloadHash) {
      problems.push({ code: "instructions-altered", message: "instruction payloads do not match the hash the authorization bound to" });
    }
    return { ok: problems.length === 0, problems };
  }
}

/** Build a deterministic, validation-passing EVM paper draft for an intent. */
export function buildEvmPaperDraft(input: { chain: "base" | "ethereum"; amountInRaw: string; tokenIn: string; tokenOut: string; minAmountOutRaw: string }): EvmTransactionDraft {
  const chainId = input.chain === "base" ? 8453 : 1;
  const data = `0x${sha256Hex(`${input.tokenIn}:${input.tokenOut}:${input.amountInRaw}:${input.minAmountOutRaw}`).slice(0, 128)}`;
  return {
    kind: "evm",
    chainId,
    expectedChainId: chainId,
    to: EVM_ROUTER_ALLOWLIST[input.chain],
    valueWei: "0",
    data,
    gasLimit: 250_000,
    expectedDataHash: evmDataHash(data),
  };
}

/** Build a deterministic, validation-passing Solana paper draft for an intent. */
export function buildSolanaPaperDraft(input: { cluster: "mainnet-beta" | "devnet"; amountInRaw: string; tokenIn: string; tokenOut: string; minAmountOutRaw: string }): SolanaTransactionDraft {
  const swapProgram = SOLANA_PROGRAM_ALLOWLIST[0]!;
  const payload = sha256Hex(`${input.tokenIn}:${input.tokenOut}:${input.amountInRaw}:${input.minAmountOutRaw}`).slice(0, 64);
  const instructions = [
    { programId: swapProgram, accountKeys: 8, dataBytes: Math.ceil(payload.length / 2) },
  ];
  return {
    kind: "solana",
    cluster: input.cluster,
    expectedCluster: input.cluster,
    instructions,
    computeUnitLimit: 250_000,
    expectedPayloadHash: solanaPayloadHash([`${swapProgram}:8:${Math.ceil(payload.length / 2)}`]),
  };
}

export function chainRegistryIdToCluster(chain: ChainId): "mainnet-beta" | "devnet" {
  if (chain === "solana-devnet") {
    return "devnet";
  }
  return "mainnet-beta";
}
