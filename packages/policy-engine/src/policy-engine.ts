import type { PolicyDecision, PolicyEvaluationRequest } from "@sentinel-mesh/contracts";

/**
 * Policy engine interface.
 *
 * Independence rules (see docs/ARCHITECTURE.md):
 *  - The policy engine is the ONLY component allowed to produce a
 *    PolicyDecision. No other package may construct one.
 *  - The interface must stay implementable without any chain adapter,
 *    queue, database, or HTTP dependency. It is a pure function of
 *    (request, rules) -> decision.
 *  - The engine never executes anything. It only decides. Execution (which in
 *    phase 0 does not exist) is a separate concern with its own audit trail.
 */
export interface PolicyEngine {
  /** Version of the policy ruleset in effect, included in every decision. */
  readonly policyVersion: string;
  evaluate(request: PolicyEvaluationRequest): Promise<PolicyDecision>;
}
