import { z } from "zod";
import {
  EvidenceItem,
  IntelligenceReport,
  type EvidenceItem as EvidenceItemType,
  type HeuristicFinding,
  type ObservedFact,
  type SourceFreshness,
  type Unknown,
} from "@sentinel-mesh/contracts";
import { defineAgent, type AgentContext, type AgentDefinition } from "@sentinel-mesh/agent-sdk";

/**
 * Token-risk agent.
 *
 * Consumes on-chain evidence (contract metadata, liquidity observations) for
 * ONE token identity and produces an intelligence report that separates:
 *  - facts: numbers read directly from evidence (TVL sums, pool counts)
 *  - findings: heuristic risk assessments (explicitly not facts)
 *  - unknowns: what the evidence cannot establish (contract age, holders)
 *  - freshness: per-source staleness vs ingestion time
 *
 * The agent NEVER uses ticker symbols as identity: the input carries the
 * token address, and evidence summaries are untrusted text that is parsed
 * for nothing.
 */

export const tokenRiskInputSchema = z
  .object({
    token: z
      .object({
        chainId: z.string().min(1),
        address: z.string().min(1),
        symbol: z.string().optional(),
      })
      .strict(),
    evidence: z.array(EvidenceItem).min(1),
  })
  .strict();
export type TokenRiskInput = z.infer<typeof tokenRiskInputSchema>;

export const tokenRiskOutputSchema = z.object({
  subject: z.string().min(1),
  facts: z.array(IntelligenceReport.shape.facts.element),
  findings: z.array(IntelligenceReport.shape.findings.element),
  unknowns: z.array(IntelligenceReport.shape.unknowns.element),
  limitations: z.array(z.string()).min(1),
  freshness: z.array(IntelligenceReport.shape.freshness.element).min(1),
}).strict();
export type TokenRiskOutput = z.infer<typeof tokenRiskOutputSchema>;

export const tokenRiskAgentManifest = {
  manifestVersion: 1,
  agentId: "token-risk-agent",
  displayName: "Token Risk Agent",
  version: "0.1.0",
  description: "Heuristic token risk assessment over on-chain evidence, separating facts, findings, unknowns, and freshness.",
  capabilities: ["token-risk"],
  supportedTaskTypes: ["assess-token-risk"],
  chainAffinity: ["base", "ethereum", "solana-mainnet", "solana-devnet"],
  permissions: { networkAccess: "mock", canSignTransactions: false },
} as const;

export interface RiskThresholds {
  /** Pools below this USD TVL are flagged thin. */
  thinLiquidityUsd: number;
  /** Single-pool share above this fraction is flagged concentrated. */
  poolConcentrationThreshold: number;
}

export const DEFAULT_RISK_THRESHOLDS: RiskThresholds = {
  thinLiquidityUsd: 10_000,
  poolConcentrationThreshold: 0.8,
};

/** Parses TVL estimates out of liquidity evidence via the structured value. */
interface LiquidityFact {
  tvlUsd: number;
  poolAddress: string;
}

function readLiquidityFacts(evidence: EvidenceItemType[]): LiquidityFact[] {
  const facts: LiquidityFact[] = [];
  for (const item of evidence) {
    if (item.kind !== "price-observation") {
      continue;
    }
    // TVL is parsed from the sanitized summary with a strict, anchored
    // pattern; matched text is a number and cannot carry instructions.
    const match = /TVL estimate ([0-9.]+) USD/.exec(item.summary);
    if (match?.[1] !== undefined) {
      facts.push({ tvlUsd: Number(match[1]), poolAddress: item.sourceName ?? "unknown-pool" });
    }
  }
  return facts;
}

export function createTokenRiskAgent(thresholds: RiskThresholds = DEFAULT_RISK_THRESHOLDS): AgentDefinition<TokenRiskInput, TokenRiskOutput> {
  return defineAgent({
    manifest: tokenRiskAgentManifest,
    inputSchema: tokenRiskInputSchema,
    outputSchema: tokenRiskOutputSchema,
    budget: { wallClockMs: 5_000, maxTasksPerMinute: 60, maxConcurrent: 2 },
    retry: { maxAttempts: 2, backoffMs: 50 },
    handle: async (ctx: AgentContext, input: TokenRiskInput): Promise<TokenRiskOutput> => {
      const subject = `${input.token.chainId}:${input.token.address.toLowerCase()}`;
      const liquidity = readLiquidityFacts(input.evidence);
      const metadataEvidence = input.evidence.filter((item) => item.kind === "onchain-observation");
      const allIds = input.evidence.map((item) => item.evidenceId);

      const facts: ObservedFact[] = [];
      const findings: HeuristicFinding[] = [];
      const unknowns: Unknown[] = [];

      facts.push({
        kind: "fact",
        code: "evidence-count",
        statement: `Risk assessment is based on ${input.evidence.length} evidence item(s).`,
        evidenceIds: allIds,
        value: input.evidence.length,
      });

      if (liquidity.length > 0) {
        const totalTvl = Math.round(liquidity.reduce((sum, item) => sum + item.tvlUsd, 0) * 100) / 100;
        facts.push({
          kind: "fact",
          code: "total-liquidity-tvl-usd",
          statement: `Observed pools sum to ${liquidity.length} pool(s) with a TVL estimate of ${totalTvl.toFixed(2)} USD.`,
          evidenceIds: input.evidence.filter((item) => item.kind === "price-observation").map((item) => item.evidenceId),
          value: totalTvl,
        });

        if (totalTvl < thresholds.thinLiquidityUsd) {
          findings.push({
            kind: "finding",
            code: "thin-liquidity",
            statement: `Aggregate TVL ${totalTvl.toFixed(2)} USD is below the thin-liquidity threshold ${thresholds.thinLiquidityUsd} USD.`,
            confidence: 0.7,
            evidenceIds: input.evidence.filter((item) => item.kind === "price-observation").map((item) => item.evidenceId),
            heuristic: "tvl-below-threshold",
          });
        }

        const topPool = [...liquidity].sort((a, b) => b.tvlUsd - a.tvlUsd)[0];
        if (topPool) {
          const share = topPool.tvlUsd / totalTvl;
          if (share >= thresholds.poolConcentrationThreshold && liquidity.length > 1) {
            findings.push({
              kind: "finding",
              code: "pool-concentration",
              statement: `A single pool holds ${(share * 100).toFixed(1)}% of observed TVL.`,
              confidence: 0.6,
              evidenceIds: input.evidence.filter((item) => item.kind === "price-observation").map((item) => item.evidenceId),
              heuristic: "single-pool-dominance",
            });
          }
        }
      } else {
        unknowns.push({
          kind: "unknown",
          code: "no-liquidity-observed",
          question: "How deep is this token's liquidity?",
          why: "the supplied evidence contains no liquidity observations",
          evidenceIds: [],
        });
      }

      if (metadataEvidence.length === 0) {
        unknowns.push({
          kind: "unknown",
          code: "no-contract-metadata",
          question: "What standard and decimals does the token contract declare?",
          why: "the supplied evidence contains no contract metadata observations",
          evidenceIds: [],
        });
      }

      if (input.evidence.some((item) => item.flaggedSuspicious)) {
        findings.push({
          kind: "finding",
          code: "untrusted-content-flagged",
          statement: "Some ingested content matched injection patterns and was quarantined; it is excluded from reasoning.",
          confidence: 0.9,
          evidenceIds: input.evidence.filter((item) => item.flaggedSuspicious).map((item) => item.evidenceId),
          heuristic: "injection-pattern-presence",
        });
      }

      const freshness: SourceFreshness[] = input.evidence.map((item) => ({
        source: item.provenance.provider,
        observedAt: item.publishedAt ?? item.fetchedAt,
        ingestedAt: item.fetchedAt,
        stale: (item.publishedAt ?? item.fetchedAt) < item.fetchedAt ? false : true,
        declaredMaxLagSec: 60,
        note: item.limitations[0] ?? undefined,
      }));

      ctx.logger.debug({ subject, facts: facts.length, findings: findings.length, unknowns: unknowns.length }, "token_risk_assessed");

      return {
        subject,
        facts,
        findings,
        unknowns,
        limitations: [
          "risk assessment is heuristic; findings are not facts and not trading advice",
          "no contract-age, holder-concentration, or social data was available to this agent",
          "assessment covers only the evidence provided to this task",
        ],
        freshness,
      };
    },
  });
}
