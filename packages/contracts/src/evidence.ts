import { z } from "zod";
import { IsoDateTime } from "./primitives.js";

/**
 * Evidence contracts.
 *
 * Retrieved content is UNTRUSTED INPUT. The contracts below enforce that
 * structurally:
 *  - Evidence text lives in a plain string field (summary), is length-capped
 *    and control-character-sanitized via `sanitizeUntrustedText`.
 *  - Evidence schemas are closed-set: any key an external document tries to
 *    inject (permissions, policies, instructions) is DROPPED at parse time.
 *  - Nothing in this package (or any agent) parses evidence text for
 *    instructions. Policy engines and manifest loaders never receive
 *    evidence-derived strings as configuration.
 *  - `detectSuspiciousInstructions` flags known injection patterns so
 *    downstream agents can quarantine suspicious content instead of
 *    trusting it.
 */

export const UNTRUSTED_TEXT_MAX_LENGTH = 2_000;

/**
 * Detects common prompt-injection / instruction-style patterns in untrusted
 * text. Detection is deliberately conservative and purely lexical; it does
 * not interpret the text.
 */
export const SUSPICIOUS_INSTRUCTION_PATTERNS: RegExp[] = [
  /ignore (all|any|the|previous|prior|above) (instructions?|prompts?|directions?|rules?)/i,
  /disregard (all|any|the|previous|prior|above)/i,
  /system (prompt|instruction)/i,
  /you are now/i,
  /change (your )?(permissions?|polic(y|ies)|settings?)/i,
  /reveal (your )?(system prompt|instructions|secrets?)/i,
  /\bexec(ute)?\b.*\b(shell|command|script)\b/i,
  /\brm\s+-rf\b/i,
  /\bcurl\b.*\|\s*(ba)?sh\b/i,
  /\beval\b\s*\(/i,
];

export function detectSuspiciousInstructions(text: string): boolean {
  return SUSPICIOUS_INSTRUCTION_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Sanitize external text before storage: strip control characters except
 * newline/tab, collapse whitespace runs, hard-cap length.
 */
export function sanitizeUntrustedText(raw: string): string {
  return raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .slice(0, UNTRUSTED_TEXT_MAX_LENGTH);
}

/** Evidence id: a uuid prefixed "ev-" for greppability. */
export const EvidenceId = z
  .string()
  .regex(/^ev-[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, "must look like ev-<uuid4>");

export const EvidenceKind = z.enum([
  "news-article",
  "price-observation",
  "onchain-observation",
  "research-note",
  "social-post",
]);

export const RetrievalMethod = z.enum(["mock-fixture", "api-fetch", "rss", "scrape"]);

export const Provenance = z
  .object({
    /** Which provider produced the content, e.g. "mock-news-provider". */
    provider: z.string().min(1),
    retrievalMethod: RetrievalMethod,
    /** Correlates evidence with a provider run for auditing. */
    providerRunId: z.string().min(1).optional(),
    /** Agent component that retrieved it. */
    retrievedBy: z.string().min(1),
  });
  // Deliberately NOT .strict(): unknown keys coming from external documents are
  // STRIPPED at parse time instead of being carried into agent state.
export type Provenance = z.infer<typeof Provenance>;

export const EvidenceItem = z
  .object({
    evidenceId: EvidenceId,
    kind: EvidenceKind,
    /** UNTRUSTED external text. Sanitized, length-capped, never parsed for instructions. */
    summary: z.string().max(UNTRUSTED_TEXT_MAX_LENGTH),
    sourceUrl: z.string().url().optional(),
    sourceName: z.string().min(1).optional(),
    /** When the underlying content was published, when known. */
    publishedAt: IsoDateTime.optional(),
    /** Required: when our platform retrieved the content. */
    fetchedAt: IsoDateTime,
    provenance: Provenance,
    /** 0..1 provider/agent confidence. */
    confidence: z.number().min(0).max(1),
    /** Declared limitations affecting this piece of evidence. */
    limitations: z.array(z.string()),
    /** True when the text matched known injection patterns. */
    flaggedSuspicious: z.boolean().default(false),
  });
  // Deliberately NOT .strict(): injected keys (permissions, instructions, ...)
  // from hostile documents are stripped here, never carried into results.
export type EvidenceItem = z.infer<typeof EvidenceItem>;

/** Builds a schema-valid evidence id from a uuid4. */
export function toEvidenceId(uuid: string): string {
  return `ev-${uuid}`;
}
