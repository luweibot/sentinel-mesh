import { z } from "zod";
import { EvidenceItem, IntelligenceReport, type HeuristicFinding, type ObservedFact, type Unknown } from "@sentinel-mesh/contracts";
import { defineAgent, type AgentContext, type AgentDefinition } from "@sentinel-mesh/agent-sdk";

/**
 * Whale-tracking agent.
 *
 * Consumes wallet-activity evidence for one wallet and reports large-transfer
 * findings. "Whale" here is an explicitly declared heuristic threshold, not
 * an observed fact. Wallet intent is an unknown by definition: chain data
 * cannot establish WHY a transfer happened.
 */

export const whaleInputSchema = z
  .object({
    wallet: z.string().min(1),
    chainId: z.string().min(1),
    evidence: z.array(EvidenceItem).min(1),
  })
  .strict();
export type WhaleInput = z.infer<typeof whaleInputSchema>;

export const whaleOutputSchema = z.object({
  subject: z.string().min(1),
  facts: z.array(IntelligenceReport.shape.facts.element),
  findings: z.array(IntelligenceReport.shape.findings.element),
  unknowns: z.array(IntelligenceReport.shape.unknowns.element),
  limitations: z.array(z.string()).min(1),
  freshness: z.array(IntelligenceReport.shape.freshness.element).min(1),
}).strict();
export type WhaleOutput = z.infer<typeof whaleOutputSchema>;

export const whaleTrackingAgentManifest = {
  manifestVersion: 1,
  agentId: "whale-tracking-agent",
  displayName: "Whale Tracking Agent",
  version: "0.1.0",
  description: "Heuristic large-transfer tracking over wallet activity evidence, with intent explicitly recorded as unknown.",
  capabilities: ["whale-tracking"],
  supportedTaskTypes: ["track-whales"],
  chainAffinity: ["base", "ethereum", "solana-mainnet", "solana-devnet"],
  permissions: { networkAccess: "mock", canSignTransactions: false },
} as const;

export const WHALE_USD_THRESHOLD = 100_000;

export function createWhaleTrackingAgent(thresholdUsd: number = WHALE_USD_THRESHOLD): AgentDefinition<WhaleInput, WhaleOutput> {
  return defineAgent({
    manifest: whaleTrackingAgentManifest,
    inputSchema: whaleInputSchema,
    outputSchema: whaleOutputSchema,
    budget: { wallClockMs: 5_000, maxTasksPerMinute: 60, maxConcurrent: 2 },
    retry: { maxAttempts: 2, backoffMs: 50 },
    handle: async (ctx: AgentContext, input: WhaleInput): Promise<WhaleOutput> => {
      const subject = `${input.chainId}:${input.wallet}`;
      const activity = input.evidence.filter((item) => item.kind === "onchain-observation");
      const facts: ObservedFact[] = [];
      const findings: HeuristicFinding[] = [];
      const unknowns: Unknown[] = [];

      facts.push({
        kind: "fact",
        code: "activity-evidence-count",
        statement: `Wallet analysis is based on ${activity.length} activity evidence item(s).`,
        evidenceIds: activity.map((item) => item.evidenceId),
        value: activity.length,
      });

      // Count USD-valued transfers via the anchored pattern; USD estimates are
      // provider-supplied numbers, not free text.
      let valuedTransfers = 0;
      let whaleTransfers = 0;
      const whaleEvidenceIds: string[] = [];
      for (const item of activity) {
        const match = /~([0-9.]+) USD/.exec(item.summary);
        if (match?.[1] === undefined) {
          continue;
        }
        valuedTransfers += 1;
        const usd = Number(match[1]);
        if (usd >= thresholdUsd) {
          whaleTransfers += 1;
          whaleEvidenceIds.push(item.evidenceId);
        }
      }

      if (valuedTransfers > 0) {
        facts.push({
          kind: "fact",
          code: "usd-valued-transfers",
          statement: `${valuedTransfers} of ${activity.length} activity event(s) carried USD estimates.`,
          evidenceIds: activity.map((item) => item.evidenceId),
          value: valuedTransfers,
        });
      }

      if (whaleTransfers > 0) {
        findings.push({
          kind: "finding",
          code: "whale-sized-transfers",
          statement: `${whaleTransfers} transfer(s) met the whale threshold of ${thresholdUsd.toFixed(2)} USD.`,
          confidence: 0.6,
          evidenceIds: whaleEvidenceIds,
          heuristic: "transfer-usd-above-threshold",
        });
      } else {
        unknowns.push({
          kind: "unknown",
          code: "whale-status-unclear",
          question: "Is this wallet making whale-sized transfers?",
          why:
            valuedTransfers === activity.length
              ? `no observed transfer met the ${thresholdUsd.toFixed(2)} USD threshold`
              : "some activity events carried no USD estimate, so sizes are only partially known",
          evidenceIds: [],
        });
      }

      // Intent is unknowable from chain data; record it explicitly.
      unknowns.push({
        kind: "unknown",
        code: "transfer-intent",
        question: "Why were these transfers made?",
        why: "on-chain activity does not contain intent information",
        evidenceIds: [],
      });

      const freshness = input.evidence.map((item) => ({
        source: item.provenance.provider,
        observedAt: item.publishedAt ?? item.fetchedAt,
        ingestedAt: item.fetchedAt,
        stale: false,
        declaredMaxLagSec: 60,
        note: item.limitations[0] ?? undefined,
      }));

      ctx.logger.debug({ subject, whaleTransfers }, "whale_activity_assessed");

      return {
        subject,
        facts,
        findings,
        unknowns,
        limitations: [
          "whale classification is a heuristic USD threshold, not an observed fact",
          "USD estimates are provider-supplied and may be missing or inaccurate",
          "activity is limited to the evidence window provided to this task",
          "wallet intent cannot be established from on-chain data",
        ],
        freshness,
      };
    },
  });
}
