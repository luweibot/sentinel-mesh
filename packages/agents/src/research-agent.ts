import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  EvidenceItem,
  sanitizeUntrustedText,
  detectSuspiciousInstructions,
  toEvidenceId,
  type EvidenceItem as EvidenceItemType,
} from "@sentinel-mesh/contracts";
import { defineAgent, type AgentDefinition } from "@sentinel-mesh/agent-sdk";

/**
 * Research agent.
 *
 * Collects documents for a topic from the (deterministic mock) research
 * provider and converts them into evidence items. Evidence rules:
 *  - every item carries an evidence ID (ev-<uuid4>)
 *  - every item carries provenance (provider, method, retriever, run id)
 *  - every item carries a required fetchedAt timestamp
 *  - summaries are UNTRUSTED text: sanitized, capped, and scanned for
 *    injection patterns; suspicious items are flagged, never interpreted
 *  - the result always declares limitations (at minimum: mock provenance)
 */

export const researchInputSchema = z
  .object({
    topic: z.string().min(1).max(200),
    maxDocuments: z.number().int().min(1).max(5).default(3),
  })
  .strict();
export type ResearchInput = z.infer<typeof researchInputSchema>;

export const researchOutputSchema = z
  .object({
    topic: z.string(),
    evidence: z.array(EvidenceItem).min(1),
    limitations: z.array(z.string()).min(1),
  })
  .strict();
export type ResearchOutput = z.infer<typeof researchOutputSchema>;

export const researchAgentManifest = {
  manifestVersion: 1,
  agentId: "research-agent",
  displayName: "Research Agent",
  version: "0.1.0",
  description: "Collects topic research from providers and produces evidence items with provenance, timestamps, and limitations.",
  capabilities: ["research"],
  supportedTaskTypes: ["research-topic"],
  chainAffinity: [],
  permissions: { networkAccess: "mock", canSignTransactions: false },
} as const;

export function createResearchAgent(provider: { fetch(topic: string, maxDocuments: number): Array<{ title: string; body: string; sourceName: string; sourceUrl: string; publishedAt: string; tags: string[]; confidence: number }>; name: string }): AgentDefinition<ResearchInput, ResearchOutput> {
  return defineAgent({
    manifest: researchAgentManifest,
    inputSchema: researchInputSchema,
    outputSchema: researchOutputSchema,
    budget: { wallClockMs: 5_000, maxTasksPerMinute: 60, maxConcurrent: 2 },
    retry: { maxAttempts: 2, backoffMs: 50 },
    handle: async (ctx, input) => {
      const runId = `${provider.name}:${ctx.now().toISOString()}`;
      const documents = provider.fetch(input.topic, input.maxDocuments);
      const evidence: EvidenceItemType[] = documents.map((doc) => {
        const sanitized = sanitizeUntrustedText(`${doc.title}. ${doc.body}`);
        const suspicious = detectSuspiciousInstructions(doc.body);
        return {
          evidenceId: toEvidenceId(randomUUID()),
          kind: "research-note",
          summary: sanitized,
          sourceUrl: doc.sourceUrl,
          sourceName: doc.sourceName,
          publishedAt: doc.publishedAt,
          fetchedAt: ctx.now().toISOString(),
          provenance: {
            provider: provider.name,
            retrievalMethod: "mock-fixture",
            providerRunId: runId,
            retrievedBy: "research-agent",
          },
          confidence: Math.min(0.99, doc.confidence),
          limitations: suspicious
            ? [
                "summary matched known injection patterns; content is quarantined as untrusted text",
              ]
            : [],
          flaggedSuspicious: suspicious,
        };
      });
      const flagged = evidence.filter((item) => item.flaggedSuspicious).length;
      const limitations = [
        "evidence comes from a deterministic mock provider; it is not real-world information",
      ];
      if (flagged > 0) {
        limitations.push(`${flagged} of ${evidence.length} evidence items matched injection patterns and are flagged`);
      }
      ctx.logger.debug({ topic: input.topic, evidenceCount: evidence.length, flagged }, "research_completed");
      return {
        topic: input.topic,
        evidence,
        limitations,
      };
    },
  });
}
