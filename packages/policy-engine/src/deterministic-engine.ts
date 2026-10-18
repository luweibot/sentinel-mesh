import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ChainId, PolicyDecision, PolicyEvaluationRequest } from "@sentinel-mesh/contracts";
import type { PolicyEngine } from "./policy-engine.js";

export class PolicyConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyConfigurationError";
  }
}

export const PolicyRulesSchema = z
  .object({
    /** Chains a signal may target. */
    allowedChains: z.array(ChainId).min(1),
    /** Hard cap on notional per signal, in USD cents. */
    maxNotionalUsdCents: z.number().int().positive(),
    /** Signals above this fraction of the cap get an advisory reason. */
    notionalAdvisoryFraction: z.number().gt(0).max(1).default(0.5),
  })
  .strict();

/** Input shape (notionalAdvisoryFraction optional, defaults to 0.5). */
export type PolicyRulesInput = z.input<typeof PolicyRulesSchema>;
/** Parsed output shape with defaults filled in. */
export type PolicyRules = z.output<typeof PolicyRulesSchema>;

export const REASON_CODES = {
  chainNotAllowed: "chain-not-allowed",
  notionalExceedsCap: "notional-exceeds-cap",
  approachingNotionalCap: "approaching-notional-cap",
} as const;

/**
 * Deterministic, rules-based policy engine.
 *
 * Rules (phase 0):
 *  1. Signal chain must be in allowedChains, else REJECT "chain-not-allowed".
 *  2. Notional must not exceed maxNotionalUsdCents, else REJECT
 *     "notional-exceeds-cap".
 *  3. Notional above notionalAdvisoryFraction of the cap adds an ADVISORY
 *     reason. Any advisory (with no rejects) yields verdict "requires-review"
 *     so a human or a future autonomous reviewer looks at large trades.
 *  4. No reasons -> verdict "allow".
 *
 * Every decision carries executionMode "simulation" (contract-level literal).
 */
export class DeterministicPolicyEngine implements PolicyEngine {
  readonly policyVersion: string;
  private readonly rules: PolicyRules; // parsed with defaults applied

  constructor(options: { policyVersion: string; rules: PolicyRulesInput }) {
    if (!/^\d+\.\d+\.\d+$/.test(options.policyVersion)) {
      throw new PolicyConfigurationError("policyVersion must be semver");
    }
    this.policyVersion = options.policyVersion;
    this.rules = PolicyRulesSchema.parse(options.rules);
  }

  async evaluate(request: PolicyEvaluationRequest): Promise<PolicyDecision> {
    const parsed = PolicyEvaluationRequest.parse(request);

    const rejectReasons: Array<{ code: string; message: string; severity: "reject" | "advisory" }> = [];
    const advisoryReasons: Array<{ code: string; message: string; severity: "reject" | "advisory" }> = [];

    if (!this.rules.allowedChains.includes(parsed.chain)) {
      rejectReasons.push({
        code: REASON_CODES.chainNotAllowed,
        message: `chain '${parsed.chain}' is not in the allowed chains [${this.rules.allowedChains.join(", ")}]`,
        severity: "reject",
      });
    }

    if (parsed.notionalUsdCents > this.rules.maxNotionalUsdCents) {
      rejectReasons.push({
        code: REASON_CODES.notionalExceedsCap,
        message: `notional ${parsed.notionalUsdCents}c exceeds the cap of ${this.rules.maxNotionalUsdCents}c`,
        severity: "reject",
      });
    } else if (
      parsed.notionalUsdCents >
      this.rules.maxNotionalUsdCents * this.rules.notionalAdvisoryFraction
    ) {
      advisoryReasons.push({
        code: REASON_CODES.approachingNotionalCap,
        message: `notional ${parsed.notionalUsdCents}c is above ${Math.round(
          this.rules.maxNotionalUsdCents * this.rules.notionalAdvisoryFraction,
        )}c (${this.rules.notionalAdvisoryFraction * 100}% of the cap); requires review`,
        severity: "advisory",
      });
    }

    const reasons = [...rejectReasons, ...advisoryReasons];
    const verdict = rejectReasons.length > 0 ? "reject" : advisoryReasons.length > 0 ? "requires-review" : "allow";

    return PolicyDecision.parse({
      schemaVersion: 1,
      decisionId: randomUUID(),
      signalId: parsed.signalId,
      verdict,
      executionMode: "simulation",
      reasons,
      policyVersion: this.policyVersion,
      evaluatedAt: new Date().toISOString(),
    });
  }
}
