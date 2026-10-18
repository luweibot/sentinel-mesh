import { z } from "zod";
import { AgentCapability } from "./agent-manifest.js";
import { IsoDateTime, Slug } from "./primitives.js";

/**
 * Skill contracts.
 *
 * Skills are installable capability modules for agents. SECURITY MODEL:
 *  - The manifest is validated by a STRICT schema: any injected key
 *    (permissions, reviewStatus overrides, autoInstall) makes the parse
 *    FAIL. Skills cannot grant themselves privileges or smuggle state.
 *  - `reviewStatus: "approved"` CANNOT be claimed by a skill. The registry
 *    forces intake status to "submitted" and only an explicit human
 *    reviewer (via the registry API) can approve. Newly generated skills
 *    are NEVER installed automatically.
 *  - SKILL.md content is UNTRUSTED INSTRUCTIONS: it is hashed, scanned, and
 *    stored, but never executed and never parsed for permissions.
 */

export const SKILL_MANIFEST_VERSION = 1;

export const SkillReviewStatus = z.enum(["submitted", "approved", "rejected", "revoked"]);
export type SkillReviewStatus = z.infer<typeof SkillReviewStatus>;

export const SkillTestStatus = z.enum(["untested", "passed", "failed"]);
export type SkillTestStatus = z.infer<typeof SkillTestStatus>;

export const ContentHash = z.string().regex(/^sha256-[0-9a-f]{64}$/, "must be sha256-<64 hex>");

export const SkillProvenance = z
  .object({
    submittedBy: z.string().min(1),
    submittedAt: IsoDateTime,
    /** Where the skill came from, when known. */
    sourceRepo: z.string().url().optional(),
    commitHash: z.string().regex(/^[0-9a-f]{7,40}$/).optional(),
  })
  .strict();
export type SkillProvenance = z.infer<typeof SkillProvenance>;

export const SkillDependency = z
  .object({
    skillId: Slug,
    /** Optional semver-ish range string; absence means "any installed". */
    versionRange: z.string().min(1).max(64).optional(),
  })
  .strict();
export type SkillDependency = z.infer<typeof SkillDependency>;

/**
 * A single sandboxed validation check. `expression` is UNTRUSTED skill code:
 * evaluated in an isolated vm sandbox with no host access and a hard
 * timeout. It must evaluate to a boolean.
 */
export const SkillCheck = z
  .object({
    name: z.string().min(1).max(120),
    kind: z.literal("expression"),
    expression: z.string().min(1).max(500),
    /** The check passes when expression === expected. */
    expected: z.boolean().default(true),
  })
  .strict();
export type SkillCheck = z.infer<typeof SkillCheck>;

export const SkillManifest = z
  .object({
    schemaVersion: z.literal(SKILL_MANIFEST_VERSION),
    skillId: Slug,
    name: z.string().min(1).max(120),
    description: z.string().min(1).max(2_000),
    /** Semver. The registry pins versions; rollback reinstates a prior one. */
    version: z
      .string()
      .regex(/^\d+\.\d+\.\d+$/, "must be MAJOR.MINOR.PATCH"),
    author: z.string().min(1).max(200),
    /** Capabilities the skill claims; must be a subset of the registry allowlist. */
    declaredCapabilities: z.array(AgentCapability).min(1),
    dependencies: z.array(SkillDependency).default([]),
    /** sha256 of the SKILL.md content, verified at intake. */
    contentHash: ContentHash,
    instructionsPath: z.literal("SKILL.md"),
    /** Sandboxed checks run at intake; must all pass for approval. */
    checks: z.array(SkillCheck).default([]),
    provenance: SkillProvenance,
    testStatus: SkillTestStatus.default("untested"),
  })
  .strict();
export type SkillManifest = z.infer<typeof SkillManifest>;

export const SkillContent = z.string().max(100_000);
export type SkillContent = string;

/** A stored registry record for one version of a skill. */
export const SkillRecord = z
  .object({
    manifest: SkillManifest,
    /** Registry-controlled state; NEVER taken from the skill itself. */
    reviewStatus: SkillReviewStatus,
    reviewedBy: z.string().min(1).optional(),
    reviewedAt: IsoDateTime.optional(),
    testStatus: SkillTestStatus,
    /** True when SKILL.md content matched suspicious-instruction patterns. */
    contentFlaggedSuspicious: z.boolean(),
    isActive: z.boolean(),
    recordedAt: IsoDateTime,
  })
  .strict();
export type SkillRecord = z.infer<typeof SkillRecord>;

export const SkillValidationIssue = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    severity: z.enum(["error", "warning"]),
  })
  .strict();
export type SkillValidationIssue = z.infer<typeof SkillValidationIssue>;

export const SkillCheckResult = z
  .object({
    name: z.string(),
    passed: z.boolean(),
    detail: z.string().optional(),
  })
  .strict();
export type SkillCheckResult = z.infer<typeof SkillCheckResult>;

export const SkillValidationReport = z
  .object({
    skillId: z.string(),
    version: z.string(),
    passed: z.boolean(),
    issues: z.array(SkillValidationIssue),
    /** Sandboxed check results, in order. */
    checkResults: z.array(z.object({ name: z.string(), passed: z.boolean(), detail: z.string().optional() })),
  })
  .strict();
export type SkillValidationReport = z.infer<typeof SkillValidationReport>;
