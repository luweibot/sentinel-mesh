import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import { createLogger } from "@sentinel-mesh/logger";
import {
  SkillRegistry,
  SkillIntakeRejectedError,
  SkillRegistryError,
  cleanSkillManifest,
  CLEAN_SKILL_MD,
  adversarialSkill,
  dependencySkill,
  rawCandidateWithInjectedFields,
  tamperedContentSkill,
} from "../src/index.js";

const START = Date.parse("2026-03-01T00:00:00.000Z");

function makeRegistry(): SkillRegistry {
  const sink = new PassThrough();
  sink.resume();
  const logger = createLogger({ service: "skills-test", level: "silent", destination: sink });
  return new SkillRegistry({
    allowedCapabilities: ["trend-analysis", "wallet-monitoring", "research", "policy-review"],
    clock: { now: () => new Date(START) },
    logger,
  });
}

describe("skill registry happy path", () => {
  it("validates, submits as non-approved, approves explicitly, installs explicitly", () => {
    const registry = makeRegistry();
    const report = registry.validate({ manifest: cleanSkillManifest(), content: CLEAN_SKILL_MD });
    expect(report.passed).toBe(true);
    expect(report.checkResults.map((result) => result.passed)).toEqual([true, true]);

    const { record } = registry.submit({ manifest: cleanSkillManifest(), content: CLEAN_SKILL_MD });
    // Intake NEVER honors self-declared status.
    expect(record.reviewStatus).toBe("submitted");
    expect(record.isActive).toBe(false);

    // Cannot install before approval.
    expect(() => registry.install("liquidity-snapshot", "1.0.0", "reviewer-1")).toThrow(SkillRegistryError);

    const approved = registry.approve("liquidity-snapshot", "1.0.0", "reviewer-1");
    expect(approved.reviewStatus).toBe("approved");
    expect(approved.reviewedBy).toBe("reviewer-1");

    const installed = registry.install("liquidity-snapshot", "1.0.0", "reviewer-1");
    expect(installed.isActive).toBe(true);
    expect(registry.findActive("liquidity-snapshot")?.manifest.version).toBe("1.0.0");
  });

  it("validates a dependent skill once its dependency is installed", () => {
    const registry = makeRegistry();
    const base = cleanSkillManifest();
    registry.submit({ manifest: base, content: CLEAN_SKILL_MD });
    registry.approve("liquidity-snapshot", "1.0.0", "reviewer-1");
    registry.install("liquidity-snapshot", "1.0.0", "reviewer-1");

    const dependent = dependencySkill(base);
    const report = registry.validate(dependent);
    expect(report.passed).toBe(true);
    const { record } = registry.submit(dependent);
    expect(record.reviewStatus).toBe("submitted");
  });
});

describe("rejection and tamper paths", () => {
  it("rejects content whose hash does not match the manifest claim", () => {
    const registry = makeRegistry();
    const report = registry.validate(tamperedContentSkill());
    expect(report.passed).toBe(false);
    expect(report.issues.some((issue) => issue.code === "content-hash-mismatch")).toBe(true);
  });

  it("rejects capabilities outside the allowlist (no self-granted powers)", () => {
    const registry = makeRegistry();
    const report = registry.validate(adversarialSkill());
    expect(report.passed).toBe(false);
    expect(report.issues.some((issue) => issue.code === "capability-not-allowed")).toBe(true);
    expect(report.issues.some((issue) => issue.code === "content-suspicious")).toBe(true);
    expect(report.issues.some((issue) => issue.code === "sandbox-check-failed")).toBe(true);
  });

  it("refuses manifests carrying injected fields (permissions, reviewStatus, autoInstall)", () => {
    const registry = makeRegistry();
    const raw = rawCandidateWithInjectedFields();
    // Strict schema: the injected keys make intake FAIL, not get honored.
    expect(() => registry.submit(raw as { manifest: unknown; content: unknown })).toThrow(SkillIntakeRejectedError);
    expect(registry.list().length).toBe(0);
    // And there is no path that installs anything without approval anyway.
    expect(() => registry.install("liquidity-snapshot", "1.0.0", "self")).toThrow(SkillRegistryError);
  });

  it("submitValidated refuses a failing candidate without storing it", () => {
    const registry = makeRegistry();
    expect(() => registry.submitValidated(tamperedContentSkill())).toThrow(SkillIntakeRejectedError);
    expect(registry.list().length).toBe(0);
  });

  it("rejects duplicate submissions of the same version", () => {
    const registry = makeRegistry();
    registry.submit({ manifest: cleanSkillManifest(), content: CLEAN_SKILL_MD });
    expect(() => registry.submit({ manifest: cleanSkillManifest(), content: CLEAN_SKILL_MD })).toThrow(/duplicate-version/);
  });

  it("blocks approval when content is flagged suspicious", () => {
    const registry = makeRegistry();
    const adversarial = adversarialSkill();
    registry.submit(adversarial);
    expect(() => registry.approve("evil-skill", "1.0.0", "reviewer-1")).toThrow(/content-suspicious|validation-failed/);
  });
});

describe("sandbox isolation", () => {
  it("untrusted expressions cannot reach host globals and fail closed", () => {
    const registry = makeRegistry();
    const report = registry.validate({
      manifest: {
        ...cleanSkillManifest(),
        skillId: "sandbox-probe",
        checks: [
          { name: "no-process", kind: "expression", expression: "typeof process === 'undefined'", expected: true },
          { name: "no-require", kind: "expression", expression: "typeof require === 'undefined'", expected: true },
          { name: "try-exit", kind: "expression", expression: "process.exit(1)", expected: true },
          { name: "hostile-false", kind: "expression", expression: "1 + 1 === 3", expected: true },
        ],
      },
      content: CLEAN_SKILL_MD,
    });
    const [noProcess, noRequire, tryExit, hostileFalse] = report.checkResults;
    expect(noProcess?.passed).toBe(true);
    expect(noRequire?.passed).toBe(true);
    expect(tryExit?.passed).toBe(false); // threw → failed safely
    expect(hostileFalse?.passed).toBe(false);
    expect(report.passed).toBe(false);
  });
});

describe("rollback", () => {
  it("rolls back to the previous approved version and records the action", () => {
    const registry = makeRegistry();
    registry.submit({ manifest: cleanSkillManifest(), content: CLEAN_SKILL_MD });
    registry.approve("liquidity-snapshot", "1.0.0", "reviewer-1");
    registry.install("liquidity-snapshot", "1.0.0", "reviewer-1");

    const v2Content = `${CLEAN_SKILL_MD}\n<!-- v2 -->\n`;
    const v2 = {
      manifest: {
        ...cleanSkillManifest(),
        version: "1.1.0",
        contentHash: `sha256-${createHash("sha256").update(v2Content, "utf8").digest("hex")}`,
      },
      content: v2Content,
    };

    registry.submit(v2);
    registry.approve("liquidity-snapshot", "1.1.0", "reviewer-1");
    registry.install("liquidity-snapshot", "1.1.0", "reviewer-1");
    expect(registry.findActive("liquidity-snapshot")?.manifest.version).toBe("1.1.0");

    const rollback = registry.rollback("liquidity-snapshot", "reviewer-1");
    expect(rollback).toEqual({ from: "1.1.0", to: "1.0.0" });
    expect(registry.findActive("liquidity-snapshot")?.manifest.version).toBe("1.0.0");
    const history = registry.historyOf("liquidity-snapshot");
    expect(history.some((entry) => entry.action.startsWith("rolled back to 1.0.0"))).toBe(true);

    // Rolling back an uninstalled skill is an explicit error.
    expect(() => registry.rollback("not-a-skill", "reviewer-1")).toThrow(SkillRegistryError);
  });
});
