import {
  type AgentCapability,
  type SkillManifest,
  type SkillRecord,
  type SkillValidationIssue,
  type SkillValidationReport,
} from "@sentinel-mesh/contracts";
import { parseSkillCandidate, hashSkillContent, runManifestChecks, scanSkillContent } from "./sandbox.js";
import type { Logger } from "@sentinel-mesh/logger";

/**
 * Skill registry with review gates and rollback.
 *
 * SECURITY MODEL (enforced here, not by convention):
 *  - intake NEVER trusts a self-declared reviewStatus; everything enters as
 *    "submitted". There is no code path that installs a newly generated
 *    skill without an explicit human `approve()` call.
 *  - capabilities must be a subset of the registry's allowlist; a skill can
 *    never grant itself a capability the platform did not allow.
 *  - SKILL.md is stored as inert, hashed text; suspicious content is
 *    flagged and blocks approval.
 */

export interface SkillRegistryDeps {
  /** Capability allowlist; manifests may only declare entries from here. */
  allowedCapabilities: readonly AgentCapability[];
  clock: { now(): Date };
  logger: Logger;
}

export interface SkillCandidate {
  manifest: unknown;
  content: unknown;
}

export class SkillIntakeRejectedError extends Error {
  constructor(readonly report: SkillValidationReport) {
    super(`skill intake rejected (${report.issues.map((issue) => issue.code).join(", ") || "invalid"})`);
    this.name = "SkillIntakeRejectedError";
  }
}

export class SkillRegistryError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "SkillRegistryError";
  }
}

export class SkillRegistry {
  /** skillId -> version -> record */
  private readonly skills = new Map<string, Map<string, SkillRecord>>();
  /** skillId -> active version, when installed. */
  private readonly active = new Map<string, string>();
  /** Rollback history: skillId -> stack of { version, action, reviewer, at }. */
  private readonly history = new Map<string, Array<{ action: string; version: string; actor: string; at: string }>>();

  constructor(private readonly deps: SkillRegistryDeps) {}

  /**
   * Validate a candidate WITHOUT storing anything. Pure function of the
   * candidate and current registry state.
   */
  validate(candidate: SkillCandidate): SkillValidationReport {
    const issues: SkillValidationIssue[] = [];
    let manifest: SkillManifest | undefined;
    let content = "";

    // 1. Strict schema parse: injected keys (permissions etc.) are dropped
    //    by the schema; a structurally invalid manifest stops here.
    try {
      const parsed = parseSkillCandidate(candidate.manifest, candidate.content);
      manifest = parsed.manifest;
      content = parsed.content;
    } catch (error) {
      issues.push({ code: "manifest-invalid", message: error instanceof Error ? error.message : "invalid manifest", severity: "error" });
      return { skillId: "(unknown)", version: "(unknown)", passed: false, issues, checkResults: [] };
    }

    // 2. Content hash must match the manifest's claim (tamper check).
    const actualHash = hashSkillContent(content);
    if (actualHash !== manifest.contentHash) {
      issues.push({
        code: "content-hash-mismatch",
        message: `manifest claims ${manifest.contentHash} but content hashes to ${actualHash}`,
        severity: "error",
      });
    }

    // 3. Capabilities must be within the allowlist (no self-granted powers).
    const extraCapabilities = manifest.declaredCapabilities.filter((capability) => !this.deps.allowedCapabilities.includes(capability));
    if (extraCapabilities.length > 0) {
      issues.push({
        code: "capability-not-allowed",
        message: `declared capabilities outside the allowlist: ${extraCapabilities.join(", ")}`,
        severity: "error",
      });
    }

    // 4. Dependencies must exist and be approved + installed.
    for (const dependency of manifest.dependencies) {
      const record = this.findActive(dependency.skillId);
      if (!record) {
        issues.push({
          code: "dependency-missing",
          message: `depends on '${dependency.skillId}' which is not installed (or not approved)`,
          severity: "error",
        });
      } else if (dependency.versionRange && !record.manifest.version.startsWith(dependency.versionRange.replace(/[^0-9]/g, "").slice(0, 1))) {
        issues.push({
          code: "dependency-version-conflict",
          message: `dependency '${dependency.skillId}' installed at ${record.manifest.version}, range '${dependency.versionRange}' unsatisfied`,
          severity: "error",
        });
      }
    }

    // 5. Sandboxed checks: run every declared expression in isolation.
    const checkResults = runManifestChecks(manifest, content);
    for (const result of checkResults) {
      if (!result.passed) {
        issues.push({ code: "sandbox-check-failed", message: `check '${result.name}' failed: ${result.detail ?? ""}`, severity: "error" });
      }
    }

    // 6. Untrusted content scan: suspicious instructions block approval.
    const suspiciousPatterns = scanSkillContent(content);
    if (suspiciousPatterns.length > 0) {
      issues.push({
        code: "content-suspicious",
        message: `SKILL.md matched injection patterns: ${suspiciousPatterns.join(", ")} — approval is blocked`,
        severity: "error",
      });
    }

    return {
      skillId: manifest.skillId,
      version: manifest.version,
      passed: issues.every((issue) => issue.severity !== "error"),
      issues,
      checkResults,
    };
  }

  /**
   * Submit a candidate for review. Stores it with reviewStatus "submitted"
   * regardless of what the manifest claims — a skill can NEVER self-approve.
   * Re-submitting the same (skillId, version) is rejected.
   */
  submit(candidate: SkillCandidate): { record: SkillRecord; report: SkillValidationReport } {
    const report = this.validate(candidate);
    let parsed: ReturnType<typeof parseSkillCandidate>;
    try {
      parsed = parseSkillCandidate(candidate.manifest, candidate.content);
    } catch (error) {
      // Strict schema gate: injected keys make the parse fail; intake is refused.
      throw new SkillIntakeRejectedError({
        skillId: "(unknown)",
        version: "(unknown)",
        passed: false,
        issues: [{ code: "manifest-invalid", message: error instanceof Error ? error.message : "invalid manifest", severity: "error" }],
        checkResults: [],
      });
    }
    if (this.skills.get(parsed.manifest.skillId)?.has(parsed.manifest.version)) {
      throw new SkillRegistryError(
        "duplicate-version",
        `duplicate-version: skill '${parsed.manifest.skillId}' version '${parsed.manifest.version}' already exists`,
      );
    }
    const record: SkillRecord = {
      manifest: parsed.manifest,
      // Intake status is FORCED; never taken from the manifest.
      reviewStatus: "submitted",
      testStatus: report.checkResults.length > 0 ? (report.checkResults.every((result) => result.passed) ? "passed" : "failed") : "untested",
      contentFlaggedSuspicious: scanSkillContent(parsed.content).length > 0,
      isActive: false,
      recordedAt: this.deps.clock.now().toISOString(),
    };
    const versions = this.skills.get(record.manifest.skillId) ?? new Map<string, SkillRecord>();
    versions.set(record.manifest.version, record);
    this.skills.set(record.manifest.skillId, versions);
    this.storeContent(record.manifest.skillId, record.manifest.version, parsed.content);
    this.deps.logger.info({ skillId: record.manifest.skillId, version: record.manifest.version }, "skill_submitted");
    return { record, report };
  }

  /** Validate a candidate; submit only if validation passes. */
  submitValidated(candidate: SkillCandidate): { record: SkillRecord; report: SkillValidationReport } {
    const report = this.validate(candidate);
    if (!report.passed) {
      throw new SkillIntakeRejectedError(report);
    }
    return this.submit(candidate);
  }

  /** Explicit human approval. Requires a non-empty reviewer id and a passing validation report. */
  approve(skillId: string, version: string, reviewerId: string): SkillRecord {
    const record = this.findVersion(skillId, version);
    if (!record) throw new SkillRegistryError("skill-not-found", `no such skill/version '${skillId}'@'${version}'`);
    const report = this.revalidate(skillId, version);
    if (!report.passed) {
      throw new SkillRegistryError("validation-failed", `cannot approve: ${report.issues.filter((issue) => issue.severity === "error").map((issue) => issue.code).join(", ")}`);
    }
    if (record.contentFlaggedSuspicious) {
      throw new SkillRegistryError("content-suspicious", "SKILL.md matched injection patterns; approval blocked");
    }
    const approved: SkillRecord = {
      ...record,
      reviewStatus: "approved",
      reviewedBy: reviewerId,
      reviewedAt: this.deps.clock.now().toISOString(),
    };
    this.storeVersion(approved);
    this.pushHistory(skillId, "approved", version, reviewerId);
    this.deps.logger.info({ skillId, version, reviewerId }, "skill_approved");
    return approved;
  }

  /** Reject a submitted skill. */
  reject(skillId: string, version: string, reviewerId: string, reason: string): SkillRecord {
    const record = this.findVersion(skillId, version);
    if (!record) throw new SkillRegistryError("skill-not-found", `no such skill/version '${skillId}'@'${version}'`);
    const rejected: SkillRecord = { ...record, reviewStatus: "rejected", reviewedBy: reviewerId, reviewedAt: this.deps.clock.now().toISOString() };
    this.storeVersion(rejected);
    this.pushHistory(skillId, `rejected (${reason})`, version, reviewerId);
    return rejected;
  }

  /**
   * Install (activate) a version. Only approved versions can be activated,
   * and only via this explicit call — nothing installs automatically.
   */
  install(skillId: string, version: string, reviewerId: string): SkillRecord {
    const record = this.findVersion(skillId, version);
    if (!record) throw new SkillRegistryError("skill-not-found", `no such skill/version '${skillId}'@'${version}'`);
    if (record.reviewStatus !== "approved") {
      throw new SkillRegistryError("not-approved", `skill '${skillId}'@'${version}' is '${record.reviewStatus}'; only approved skills install`);
    }
    const previous = this.active.get(skillId);
    if (previous) {
      const previousRecord = this.findVersion(skillId, previous);
      if (previousRecord) this.storeVersion({ ...previousRecord, isActive: false });
    }
    this.active.set(skillId, version);
    const installed: SkillRecord = { ...record, isActive: true };
    this.storeVersion(installed);
    this.pushHistory(skillId, "installed", version, reviewerId);
    return installed;
  }

  /**
   * Rollback: deactivate the current version and reactivate the previous
   * approved one (or deactivate entirely when none exists). Explicit,
   * reviewed, recorded — never automatic.
   */
  rollback(skillId: string, reviewerId: string): { from: string | null; to: string | null } {
    const current = this.active.get(skillId) ?? null;
    if (!current) throw new SkillRegistryError("not-installed", `skill '${skillId}' is not installed`);
    const history = this.history.get(skillId) ?? [];
    const previousInstalled = [...history].reverse().find((entry) => entry.action === "installed" && entry.version !== current);
    this.active.delete(skillId);
    const currentRecord = this.findVersion(skillId, current);
    if (currentRecord) this.storeVersion({ ...currentRecord, isActive: false });
    let to: string | null = null;
    if (previousInstalled) {
      const target = this.findVersion(skillId, previousInstalled.version);
      if (target && target.reviewStatus === "approved") {
        this.active.set(skillId, target.manifest.version);
        this.storeVersion({ ...target, isActive: true });
        to = target.manifest.version;
      }
    }
    this.pushHistory(skillId, `rolled back to ${to ?? "none"}`, current, reviewerId);
    this.deps.logger.info({ skillId, from: current, to, reviewerId }, "skill_rolled_back");
    return { from: current, to };
  }

  /** Re-run validation for a stored version (reviewer support). */
  revalidate(skillId: string, version: string): SkillValidationReport {
    const record = this.findVersion(skillId, version);
    if (!record) {
      return { skillId, version, passed: false, issues: [{ code: "skill-not-found", message: "no such skill/version", severity: "error" }], checkResults: [] };
    }
    return this.validate({ manifest: record.manifest, content: this.contentOf(skillId, version) ?? "" });
  }

  list(): SkillRecord[] {
    return [...this.skills.values()].flatMap((versions) => [...versions.values()]);
  }

  findActive(skillId: string): SkillRecord | undefined {
    const version = this.active.get(skillId);
    return version ? this.findVersion(skillId, version) : undefined;
  }

  historyOf(skillId: string): Array<{ action: string; version: string; actor: string; at: string }> {
    return [...(this.history.get(skillId) ?? [])];
  }

  findVersion(skillId: string, version: string): SkillRecord | undefined {
    return this.skills.get(skillId)?.get(version);
  }

  // The registry stores content alongside the record (inert text).
  private readonly contents = new Map<string, string>();

  storeContent(skillId: string, version: string, content: string): void {
    this.contents.set(`${skillId}@${version}`, content);
  }

  contentOf(skillId: string, version: string): string | undefined {
    return this.contents.get(`${skillId}@${version}`);
  }

  private storeVersion(record: SkillRecord): void {
    const versions = this.skills.get(record.manifest.skillId);
    versions?.set(record.manifest.version, record);
  }

  private pushHistory(skillId: string, action: string, version: string, actor: string): void {
    const entries = this.history.get(skillId) ?? [];
    entries.push({ action, version, actor, at: this.deps.clock.now().toISOString() });
    this.history.set(skillId, entries);
  }
}
