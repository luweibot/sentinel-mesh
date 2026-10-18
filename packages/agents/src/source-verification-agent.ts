import { z } from "zod";
import { EvidenceItem } from "@sentinel-mesh/contracts";
import { defineAgent, type AgentDefinition } from "@sentinel-mesh/agent-sdk";
import type { MockSourceVerifier, VerificationVerdict } from "./providers.js";

/**
 * Source-verification agent.
 *
 * Verifies evidence produced upstream (typically by the research agent).
 * Verification is structural and provenance-based; untrusted summaries are
 * never parsed for instructions. Verdicts:
 *  - verified: known provider + publication timestamp + not flagged suspicious
 *  - unverified: any check failed
 */

export const verificationInputSchema = z
  .object({
    evidence: z.array(EvidenceItem).min(1),
  })
  .strict();
export type VerificationInput = z.infer<typeof verificationInputSchema>;

export const verificationOutputSchema = z
  .object({
    verdicts: z
      .array(
        z
          .object({
            evidenceId: z.string().min(1),
            verdict: z.enum(["verified", "unverified"]),
            checks: z
              .array(
                z
                  .object({
                    check: z.string().min(1),
                    pass: z.boolean(),
                    detail: z.string(),
                  })
                  .strict(),
              )
              .min(1),
            confidence: z.number().min(0).max(1),
          })
          .strict(),
      )
      .min(1),
    verifiedEvidence: z.array(EvidenceItem),
    limitations: z.array(z.string()).min(1),
  })
  .strict();
export type VerificationOutput = z.infer<typeof verificationOutputSchema>;

export const sourceVerificationAgentManifest = {
  manifestVersion: 1,
  agentId: "source-verification-agent",
  displayName: "Source Verification Agent",
  version: "0.1.0",
  description: "Checks provenance, timestamps, and integrity flags on evidence and emits verified/unverified verdicts.",
  capabilities: ["source-verification"],
  supportedTaskTypes: ["verify-sources"],
  chainAffinity: [],
  permissions: { networkAccess: "mock", canSignTransactions: false },
} as const;

export function createSourceVerificationAgent(
  verifier: MockSourceVerifier,
): AgentDefinition<VerificationInput, VerificationOutput> {
  return defineAgent({
    manifest: sourceVerificationAgentManifest,
    inputSchema: verificationInputSchema,
    outputSchema: verificationOutputSchema,
    budget: { wallClockMs: 5_000, maxTasksPerMinute: 60, maxConcurrent: 2 },
    retry: { maxAttempts: 2, backoffMs: 50 },
    handle: async (ctx, input) => {
      const verdicts: VerificationVerdict[] = verifier.verify(
        input.evidence.map((item) => ({
          evidenceId: item.evidenceId,
          provenance: item.provenance,
          publishedAt: item.publishedAt,
          flaggedSuspicious: item.flaggedSuspicious,
          confidence: item.confidence,
        })),
      );
      const byId = new Map(input.evidence.map((item) => [item.evidenceId, item]));
      const verifiedEvidence = verdicts
        .filter((verdict) => verdict.verdict === "verified")
        .map((verdict) => byId.get(verdict.evidenceId))
        .filter((item): item is NonNullable<typeof item> => item !== undefined);
      const unverified = verdicts.length - verifiedEvidence.length;
      ctx.logger.debug({ verdicts: verdicts.length, unverified }, "verification_completed");
      return {
        verdicts,
        verifiedEvidence,
        limitations: [
          "verification is deterministic and provenance-based (mock verifier); it does not attest real-world accuracy",
          ...(unverified > 0 ? [`${unverified} evidence item(s) failed verification and were excluded from downstream intelligence`] : []),
        ],
      };
    },
  });
}
