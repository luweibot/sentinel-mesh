import { z } from "zod";
import { EvidenceItem } from "@sentinel-mesh/contracts";
import { defineAgent, type AgentDefinition } from "@sentinel-mesh/agent-sdk";
import type { MockNewsProvider } from "./providers.js";

/**
 * News-intelligence agent.
 *
 * Consumes VERIFIED evidence only (the workflow plan filters upstream) and
 * produces a deterministic sentiment score and key topics. Untrusted
 * summaries are hashed by the provider, never parsed for instructions.
 */

export const newsInputSchema = z
  .object({
    topic: z.string().min(1).max(200),
    evidence: z.array(EvidenceItem).min(1),
  })
  .strict();
export type NewsInput = z.infer<typeof newsInputSchema>;

export const newsOutputSchema = z
  .object({
    topic: z.string(),
    sentimentScore: z.number().min(-1).max(1),
    keyTopics: z.array(z.string()).min(1),
    evidenceIds: z.array(z.string().min(1)).min(1),
    limitations: z.array(z.string()).min(1),
  })
  .strict();
export type NewsOutput = z.infer<typeof newsOutputSchema>;

export const newsIntelligenceAgentManifest = {
  manifestVersion: 1,
  agentId: "news-intelligence-agent",
  displayName: "News Intelligence Agent",
  version: "0.1.0",
  description: "Summarizes verified evidence into sentiment and key topics with explicit limitations.",
  capabilities: ["news-intelligence"],
  supportedTaskTypes: ["summarize-news"],
  chainAffinity: [],
  permissions: { networkAccess: "mock", canSignTransactions: false },
} as const;

export function createNewsIntelligenceAgent(
  provider: MockNewsProvider,
): AgentDefinition<NewsInput, NewsOutput> {
  return defineAgent({
    manifest: newsIntelligenceAgentManifest,
    inputSchema: newsInputSchema,
    outputSchema: newsOutputSchema,
    budget: { wallClockMs: 5_000, maxTasksPerMinute: 60, maxConcurrent: 2 },
    retry: { maxAttempts: 2, backoffMs: 50 },
    handle: async (ctx, input) => {
      const summary = provider.summarize(
        input.topic,
        input.evidence.map((item) => item.summary),
      );
      ctx.logger.debug({ topic: input.topic, evidence: input.evidence.length }, "news_summarized");
      return {
        topic: input.topic,
        sentimentScore: summary.sentimentScore,
        keyTopics: summary.keyTopics,
        evidenceIds: input.evidence.map((item) => item.evidenceId),
        limitations: [
          "sentiment is a deterministic hash of the evidence summaries, not a semantic model",
          "based on mock evidence only; not real-world market intelligence",
        ],
      };
    },
  });
}
