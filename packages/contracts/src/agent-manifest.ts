import { z } from "zod";
import { ChainId, Semver, Slug } from "./primitives.js";

/**
 * Agent manifest contract.
 *
 * A manifest describes an agent that participates in the mesh. Manifests are
 * data, not code: services load and validate them at startup and before
 * dispatching tasks.
 *
 * Phase 0 guardrail: `permissions.canSignTransactions` is typed as the literal
 * `false`. No manifest can declare signing capability, so no downstream code
 * can claim a manifest authorized live signing.
 */

export const AgentCapability = z.enum([
  "trend-analysis",
  "wallet-monitoring",
  "signal-generation",
  "policy-review",
  "trade-simulation",
  "research",
  "source-verification",
  "news-intelligence",
  "token-risk",
  "whale-tracking",
  "fee-intelligence",
  "paper-trading",
]);
export type AgentCapability = z.infer<typeof AgentCapability>;

export const TaskType = z.enum([
  "scan-trending",
  "monitor-wallet",
  "evaluate-signal",
  "simulate-trade",
  "research-topic",
  "verify-sources",
  "summarize-news",
  "assess-token-risk",
  "track-whales",
  "analyze-fees",
  "paper-trade",
]);
export type TaskType = z.infer<typeof TaskType>;

/** Network access modes. `readonly` is reserved for a later phase and not enabled. */
export const NetworkAccessMode = z.enum(["mock", "readonly"]);

export const AgentPermissions = z
  .object({
    networkAccess: NetworkAccessMode,
    /** Hard-coded literal false in phase 0. Agents cannot sign anything real. */
    canSignTransactions: z.literal(false),
  })
  .strict();

export const AgentManifest = z
  .object({
    manifestVersion: z.literal(1),
    agentId: Slug,
    displayName: z.string().min(1),
    version: Semver,
    description: z.string().optional(),
    capabilities: z.array(AgentCapability).min(1),
    /** Task types this agent accepts. Must be non-empty. */
    supportedTaskTypes: z.array(TaskType).min(1),
    /** Chains the agent operates on. May be empty for chain-agnostic agents (e.g. policy review). */
    chainAffinity: z.array(ChainId),
    permissions: AgentPermissions,
    /** Optional HTTP health path when the agent runs as a service. */
    health: z
      .object({
        path: z.string().startsWith("/"),
      })
      .strict()
      .optional(),
  })
  .strict();
export type AgentManifest = z.infer<typeof AgentManifest>;

/** Cross-field rule: an agent that claims "policy-review" or "trade-simulation"
 * capabilities must support the matching task types. */
export function validateManifestCoherence(manifest: AgentManifest): string[] {
  const problems: string[] = [];
  const required: Array<{ capability: AgentCapability; taskType: TaskType }> = [
    { capability: "trend-analysis", taskType: "scan-trending" },
    { capability: "wallet-monitoring", taskType: "monitor-wallet" },
    { capability: "policy-review", taskType: "evaluate-signal" },
    { capability: "trade-simulation", taskType: "simulate-trade" },
    { capability: "research", taskType: "research-topic" },
    { capability: "source-verification", taskType: "verify-sources" },
    { capability: "news-intelligence", taskType: "summarize-news" },
    { capability: "token-risk", taskType: "assess-token-risk" },
    { capability: "whale-tracking", taskType: "track-whales" },
    { capability: "fee-intelligence", taskType: "analyze-fees" },
    { capability: "paper-trading", taskType: "paper-trade" },
  ];
  for (const rule of required) {
    if (manifest.capabilities.includes(rule.capability) && !manifest.supportedTaskTypes.includes(rule.taskType)) {
      problems.push(
        `agent '${manifest.agentId}' declares capability '${rule.capability}' but does not support task type '${rule.taskType}'`,
      );
    }
  }
  return problems;
}
