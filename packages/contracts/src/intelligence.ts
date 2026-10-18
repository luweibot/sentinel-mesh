import { z } from "zod";
import { IsoDateTime, Uuid } from "./primitives.js";

/**
 * Intelligence reporting contracts: observed facts, heuristic findings,
 * unknowns, and source freshness.
 *
 * The whole point of these shapes is that an agent report CANNOT blur
 * "what the data said" (facts), "what a heuristic guessed" (findings), and
 * "what we could not determine" (unknowns). Consumers get three distinct
 * lists plus per-source freshness, and no field allows one kind of
 * statement to masquerade as another.
 */

/** Something directly present in (or derived arithmetically from) evidence. */
export const ObservedFact = z
  .object({
    kind: z.literal("fact"),
    code: z.string().min(1),
    /** Human-readable statement of the fact. */
    statement: z.string().min(1),
    /** Evidence ids backing the fact (required; facts are not free-floating). */
    evidenceIds: z.array(z.string().min(1)).min(1),
    value: z.unknown().optional(),
  })
  .strict();
export type ObservedFact = z.infer<typeof ObservedFact>;

/** A heuristic-derived conclusion; explicitly NOT an observed fact. */
export const HeuristicFinding = z
  .object({
    kind: z.literal("finding"),
    code: z.string().min(1),
    statement: z.string().min(1),
    /** 0..1 heuristic confidence (not evidence confidence). */
    confidence: z.number().min(0).max(1),
    evidenceIds: z.array(z.string().min(1)).min(1),
    /** The heuristic that produced this finding, named for auditability. */
    heuristic: z.string().min(1),
  })
  .strict();
export type HeuristicFinding = z.infer<typeof HeuristicFinding>;

/** A question the evidence could not answer. Unknowns are first-class. */
export const Unknown = z
  .object({
    kind: z.literal("unknown"),
    code: z.string().min(1),
    question: z.string().min(1),
    /** Why it could not be answered from the available evidence. */
    why: z.string().min(1),
    evidenceIds: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type Unknown = z.infer<typeof Unknown>;

/** Freshness of an observation source relative to ingestion time. */
export const SourceFreshness = z
  .object({
    source: z.string().min(1),
    /** When the source data was observed (block/slot time or fetch time). */
    observedAt: IsoDateTime,
    /** When the agent ingested it. */
    ingestedAt: IsoDateTime,
    /** True when observedAt is older than the source's declared max lag. */
    stale: z.boolean(),
    declaredMaxLagSec: z.number().int().min(0),
    note: z.string().optional(),
  })
  .strict();
export type SourceFreshness = z.infer<typeof SourceFreshness>;

/** Common report envelope for intelligence agents. */
export const IntelligenceReport = z
  .object({
    reportId: Uuid,
    subject: z.string().min(1),
    facts: z.array(ObservedFact),
    findings: z.array(HeuristicFinding),
    unknowns: z.array(Unknown),
    limitations: z.array(z.string()).min(1),
    freshness: z.array(SourceFreshness).min(1),
  })
  .strict();
export type IntelligenceReport = z.infer<typeof IntelligenceReport>;
