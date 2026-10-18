import { z } from "zod";
import { EvidenceItem, IntelligenceReport, type HeuristicFinding, type ObservedFact, type Unknown } from "@sentinel-mesh/contracts";
import { defineAgent, type AgentContext, type AgentDefinition } from "@sentinel-mesh/agent-sdk";

/**
 * Fee-intelligence agent.
 *
 * Consumes fee-estimate evidence and reports cost trends. All outputs are
 * advisory: nothing in this agent (or the platform) executes transactions,
 * so "recommendations" are framed as findings about relative cost levels.
 */

export const feeInputSchema = z
  .object({
    chainId: z.string().min(1),
    evidence: z.array(EvidenceItem).min(1),
  })
  .strict();
export type FeeInput = z.infer<typeof feeInputSchema>;

export const feeOutputSchema = z.object({
  subject: z.string().min(1),
  facts: z.array(IntelligenceReport.shape.facts.element),
  findings: z.array(IntelligenceReport.shape.findings.element),
  unknowns: z.array(IntelligenceReport.shape.unknowns.element),
  limitations: z.array(z.string()).min(1),
  freshness: z.array(IntelligenceReport.shape.freshness.element).min(1),
}).strict();
export type FeeOutput = z.infer<typeof feeOutputSchema>;

export const feeIntelligenceAgentManifest = {
  manifestVersion: 1,
  agentId: "fee-intelligence-agent",
  displayName: "Fee Intelligence Agent",
  version: "0.1.0",
  description: "Advisory fee-level analysis over fee-estimate evidence; no execution is performed or recommended automatically.",
  capabilities: ["fee-intelligence"],
  supportedTaskTypes: ["analyze-fees"],
  chainAffinity: ["base", "ethereum", "solana-mainnet", "solana-devnet"],
  permissions: { networkAccess: "mock", canSignTransactions: false },
} as const;

export const HIGH_FEE_USD_THRESHOLD = 5;

export function createFeeIntelligenceAgent(thresholdUsd: number = HIGH_FEE_USD_THRESHOLD): AgentDefinition<FeeInput, FeeOutput> {
  return defineAgent({
    manifest: feeIntelligenceAgentManifest,
    inputSchema: feeInputSchema,
    outputSchema: feeOutputSchema,
    budget: { wallClockMs: 5_000, maxTasksPerMinute: 60, maxConcurrent: 2 },
    retry: { maxAttempts: 2, backoffMs: 50 },
    handle: async (ctx: AgentContext, input: FeeInput): Promise<FeeOutput> => {
      const facts: ObservedFact[] = [];
      const findings: HeuristicFinding[] = [];
      const unknowns: Unknown[] = [];
      const ids = input.evidence.map((item) => item.evidenceId);

      const fees: number[] = [];
      for (const item of input.evidence) {
        const match = /total estimate ([0-9.]+) USD/.exec(item.summary);
        if (match?.[1] !== undefined) {
          fees.push(Number(match[1]));
        }
      }

      if (fees.length === 0) {
        unknowns.push({
          kind: "unknown",
          code: "no-fee-estimates",
          question: "What does a typical transfer cost on this chain?",
          why: "the supplied evidence contains no parseable fee estimates",
          evidenceIds: [],
        });
      } else {
        const avg = Math.round((fees.reduce((a, b) => a + b, 0) / fees.length) * 10_000) / 10_000;
        const max = Math.max(...fees);
        facts.push({
          kind: "fact",
          code: "fee-estimate-average-usd",
          statement: `Average estimated fee across ${fees.length} estimate(s) is ${avg.toFixed(4)} USD (max observed ${max.toFixed(4)} USD).`,
          evidenceIds: ids,
          value: avg,
        });
        if (avg > thresholdUsd) {
          findings.push({
            kind: "finding",
            code: "high-fee-level",
            statement: `Average estimated fee ${avg.toFixed(4)} USD exceeds the advisory threshold ${thresholdUsd.toFixed(2)} USD.`,
            confidence: 0.6,
            evidenceIds: ids,
            heuristic: "fee-average-above-threshold",
          });
        } else {
          findings.push({
            kind: "finding",
            code: "low-fee-level",
            statement: `Average estimated fee ${avg.toFixed(4)} USD is at or below the advisory threshold ${thresholdUsd.toFixed(2)} USD.`,
            confidence: 0.6,
            evidenceIds: ids,
            heuristic: "fee-average-below-threshold",
          });
        }
        if (max > avg * 2 && fees.length > 1) {
          unknowns.push({
            kind: "unknown",
            code: "fee-volatility-cause",
            question: "Why do fee estimates vary between observations?",
            why: "evidence contains point-in-time estimates without enough history for trend analysis",
            evidenceIds: ids,
          });
        }
      }

      const freshness = input.evidence.map((item) => ({
        source: item.provenance.provider,
        observedAt: item.publishedAt ?? item.fetchedAt,
        ingestedAt: item.fetchedAt,
        stale: false,
        declaredMaxLagSec: 60,
        note: item.limitations[0] ?? undefined,
      }));

      ctx.logger.debug({ subject: input.chainId, fees: fees.length }, "fees_analyzed");

      return {
        subject: input.chainId,
        facts,
        findings,
        unknowns,
        limitations: [
          "fee estimates are point-in-time and advisory; actual costs depend on execution-time conditions",
          "USD conversion uses provider reference prices",
          "this agent performs no execution and issues no executable recommendation",
        ],
        freshness,
      };
    },
  });
}
