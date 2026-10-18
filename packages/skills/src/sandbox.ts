import { createHash } from "node:crypto";
import vm from "node:vm";
import {
  SUSPICIOUS_INSTRUCTION_PATTERNS,
  SkillContent,
  SkillManifest,
  type SkillCheckResult,
  type SkillContent as SkillContentType,
  type SkillManifest as SkillManifestType,
} from "@sentinel-mesh/contracts";

/**
 * Sandboxed validation for skills.
 *
 * Skill-declared check expressions are UNTRUSTED CODE. They are evaluated
 * in a fresh V8 context with NO access to: require, import, process, fs,
 * network, timers, globals, the registry, or the host module graph. The
 * only values in scope are the explicitly provided context object and a
 * small set of pure helpers. A hard timeout aborts runaway expressions.
 */

export interface SandboxContext {
  manifest: SkillManifestType;
  content: SkillContentType;
}

const SANDBOX_TIMEOUT_MS = 50;

/**
 * Evaluates one untrusted check expression. Returns { passed, threw }:
 * an expression that throws or times out fails safely (never crashes the
 * registry, never escapes the sandbox).
 */
export function runIsolatedCheck(expression: string, context: SandboxContext): { passed: boolean; threw: boolean; value: unknown } {
  const sandbox = Object.freeze({
    manifest: structuredClone(context.manifest),
    contentLength: context.content.length,
    contentPreview: context.content.slice(0, 200),
  });
  try {
    const value = vm.runInNewContext(`(${expression})`, sandbox, { timeout: SANDBOX_TIMEOUT_MS, displayErrors: false });
    return { passed: typeof value === "boolean" ? value : false, threw: false, value };
  } catch {
    // Timeout, syntax error, ReferenceError (e.g. `process`): all fail closed.
    return { passed: false, threw: true, value: undefined };
  }
}

/** sha256 of the SKILL.md content, in the registry's canonical form. */
export function hashSkillContent(content: SkillContentType): string {
  return `sha256-${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

/** Lexical scan of untrusted SKILL.md content for instruction-injection patterns. */
export function scanSkillContent(content: SkillContentType): string[] {
  return SUSPICIOUS_INSTRUCTION_PATTERNS.filter((pattern) => pattern.test(content)).map((pattern) => pattern.source);
}

/**
 * Runs every sandboxed check a manifest declares. Unknown/failed checks
 * surface as failures with details for the reviewer.
 */
export function runManifestChecks(manifest: SkillManifestType, content: SkillContentType): SkillCheckResult[] {
  return manifest.checks.map((check) => {
    const result = runIsolatedCheck(check.expression, { manifest, content });
    const passed = !result.threw && result.passed === check.expected;
    return {
      name: check.name,
      passed,
      detail: result.threw
        ? "expression threw or timed out in the sandbox (treated as failure)"
        : `expression evaluated to ${String(result.value)}`,
    };
  });
}

export interface ParsedCandidate {
  manifest: SkillManifestType;
  content: SkillContentType;
}

/**
 * Parse a submitted skill candidate. CRITICAL: the manifest is parsed with
 * the STRICT schema — injected keys like `permissions`, `reviewStatus`, or
 * `autoInstall` are DROPPED here, so a skill can never smuggle privileges
 * in through extra fields. The content is capped and stored as inert text.
 */
export function parseSkillCandidate(rawManifest: unknown, rawContent: unknown): ParsedCandidate {
  const manifest = SkillManifest.parse(rawManifest);
  const content = SkillContent.parse(rawContent);
  return { manifest, content };
}
