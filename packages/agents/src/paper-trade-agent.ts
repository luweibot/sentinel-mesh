import { z } from "zod";
import {
  ExecutionReceipt,
  TradeAuthorization,
  TradeIntent,
} from "@sentinel-mesh/contracts";
import { defineAgent, type AgentContext, type AgentDefinition } from "@sentinel-mesh/agent-sdk";
import type { ExecutionPort } from "@sentinel-mesh/execution";

/**
 * Paper-trading strategy agent.
 *
 * ISOLATION CONTRACT: this agent receives ONLY the ExecutionPort interface
 * (submitIntent / receipt lookups). It has no access to:
 *  - signing keys or the IsolatedSignerPort (never imported here)
 *  - chain adapters or transaction construction
 *  - the authorization service (it cannot mint or revoke authorizations)
 *
 * Every trade it requests must arrive WITH a short-lived authorization
 * minted by a separate approver. The executor fails closed without one.
 */

export const paperTradeInputSchema = z
  .object({
    intent: TradeIntent,
    authorization: TradeAuthorization,
  })
  .strict();
export type PaperTradeInput = z.infer<typeof paperTradeInputSchema>;

export const paperTradeOutputSchema = z
  .object({
    receipt: ExecutionReceipt,
  })
  .strict();
export type PaperTradeOutput = z.infer<typeof paperTradeOutputSchema>;

export const paperTradeAgentManifest = {
  manifestVersion: 1,
  agentId: "paper-trade-agent",
  displayName: "Paper Trading Agent",
  version: "0.1.0",
  description: "Submits authorized intents to the guarded paper executor. Never holds keys, never signs, never broadcasts.",
  capabilities: ["paper-trading"],
  supportedTaskTypes: ["paper-trade"],
  chainAffinity: ["base", "ethereum", "solana-mainnet", "solana-devnet"],
  permissions: { networkAccess: "mock", canSignTransactions: false },
} as const;

export function createPaperTradeAgent(executionPort: ExecutionPort): AgentDefinition<PaperTradeInput, PaperTradeOutput> {
  return defineAgent({
    manifest: paperTradeAgentManifest,
    inputSchema: paperTradeInputSchema,
    outputSchema: paperTradeOutputSchema,
    budget: { wallClockMs: 10_000, maxTasksPerMinute: 60, maxConcurrent: 2 },
    retry: { maxAttempts: 1, backoffMs: 50 },
    handle: async (ctx: AgentContext, input: PaperTradeInput): Promise<PaperTradeOutput> => {
      const receipt = await executionPort.submitIntent(input.intent, input.authorization);
      ctx.logger.debug({ intentId: input.intent.intentId, status: receipt.status }, "paper_trade_submitted");
      return { receipt };
    },
  });
}
