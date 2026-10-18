import type { AgentManifest } from "./agent-manifest.js";
import { validateManifestCoherence } from "./agent-manifest.js";

/**
 * Deterministic fixture manifests for the phase 0 mesh.
 *
 * These are the agents the API serves from /api/v1/agents and accepts tasks
 * for. They use the same schema as future real agent manifests; only the
 * networkAccess mode is guaranteed to be "mock" in this phase.
 *
 * validateManifestCoherence is enforced at module load: if these fixtures
 * drift out of coherence, tests fail loudly.
 */

function assertCoherent(manifest: AgentManifest): void {
  const problems = validateManifestCoherence(manifest);
  if (problems.length > 0) {
    throw new Error(`Incoherent fixture manifest for '${manifest.agentId}': ${problems.join("; ")}`);
  }
}

export const MOCK_AGENT_MANIFESTS: AgentManifest[] = [
  {
    manifestVersion: 1,
    agentId: "trend-scout",
    displayName: "Trend Scout",
    version: "0.1.0",
    description: "Scans trending tokens across supported chains using deterministic mock fixtures (phase 0).",
    capabilities: ["trend-analysis"],
    supportedTaskTypes: ["scan-trending"],
    chainAffinity: ["base", "solana"],
    permissions: { networkAccess: "mock", canSignTransactions: false },
  },
  {
    manifestVersion: 1,
    agentId: "wallet-watcher",
    displayName: "Wallet Watcher",
    version: "0.1.0",
    description: "Observes watched wallets and emits signals for observed movements (mock data in phase 0).",
    capabilities: ["wallet-monitoring"],
    supportedTaskTypes: ["monitor-wallet"],
    chainAffinity: ["base", "solana"],
    permissions: { networkAccess: "mock", canSignTransactions: false },
  },
  {
    manifestVersion: 1,
    agentId: "policy-guard",
    displayName: "Policy Guard",
    version: "0.1.0",
    description: "Chain-agnostic policy evaluation agent. Evaluates signals against the deterministic policy engine.",
    capabilities: ["policy-review"],
    supportedTaskTypes: ["evaluate-signal"],
    chainAffinity: ["base", "ethereum", "solana"],
    permissions: { networkAccess: "mock", canSignTransactions: false },
  },
  {
    manifestVersion: 1,
    agentId: "sim-executor",
    displayName: "Simulated Executor",
    version: "0.1.0",
    description: "Produces simulated (never broadcast) trade artifacts for allowed signals. No real signing exists in phase 0.",
    capabilities: ["trade-simulation"],
    supportedTaskTypes: ["simulate-trade"],
    chainAffinity: ["base", "solana"],
    permissions: { networkAccess: "mock", canSignTransactions: false },
  },
  {
    manifestVersion: 1,
    agentId: "research-agent",
    displayName: "Research Agent",
    version: "0.1.0",
    description: "Collects topic research from providers and produces evidence items with provenance and limitations.",
    capabilities: ["research"],
    supportedTaskTypes: ["research-topic"],
    chainAffinity: [],
    permissions: { networkAccess: "mock", canSignTransactions: false },
  },
  {
    manifestVersion: 1,
    agentId: "source-verification-agent",
    displayName: "Source Verification Agent",
    version: "0.1.0",
    description: "Checks provenance and flags on evidence and emits verified/unverified verdicts.",
    capabilities: ["source-verification"],
    supportedTaskTypes: ["verify-sources"],
    chainAffinity: [],
    permissions: { networkAccess: "mock", canSignTransactions: false },
  },
  {
    manifestVersion: 1,
    agentId: "news-intelligence-agent",
    displayName: "News Intelligence Agent",
    version: "0.1.0",
    description: "Summarizes verified evidence into sentiment and key topics with explicit limitations.",
    capabilities: ["news-intelligence"],
    supportedTaskTypes: ["summarize-news"],
    chainAffinity: [],
    permissions: { networkAccess: "mock", canSignTransactions: false },
  },
  {
    manifestVersion: 1,
    agentId: "token-risk-agent",
    displayName: "Token Risk Agent",
    version: "0.1.0",
    description: "Heuristic token risk assessment over on-chain evidence, separating facts, findings, unknowns, and freshness.",
    capabilities: ["token-risk"],
    supportedTaskTypes: ["assess-token-risk"],
    chainAffinity: ["base", "ethereum", "solana-mainnet", "solana-devnet"],
    permissions: { networkAccess: "mock", canSignTransactions: false },
  },
  {
    manifestVersion: 1,
    agentId: "whale-tracking-agent",
    displayName: "Whale Tracking Agent",
    version: "0.1.0",
    description: "Heuristic large-transfer tracking over wallet activity evidence.",
    capabilities: ["whale-tracking"],
    supportedTaskTypes: ["track-whales"],
    chainAffinity: ["base", "ethereum", "solana-mainnet", "solana-devnet"],
    permissions: { networkAccess: "mock", canSignTransactions: false },
  },
  {
    manifestVersion: 1,
    agentId: "paper-trade-agent",
    displayName: "Paper Trading Agent",
    version: "0.1.0",
    description: "Submits authorized intents to the guarded paper executor. Never holds keys, never signs, never broadcasts.",
    capabilities: ["paper-trading"],
    supportedTaskTypes: ["paper-trade"],
    chainAffinity: ["base", "ethereum", "solana-mainnet", "solana-devnet"],
    permissions: { networkAccess: "mock", canSignTransactions: false },
  },
  {
    manifestVersion: 1,
    agentId: "fee-intelligence-agent",
    displayName: "Fee Intelligence Agent",
    version: "0.1.0",
    description: "Advisory fee-level analysis over fee-estimate evidence; no execution is performed.",
    capabilities: ["fee-intelligence"],
    supportedTaskTypes: ["analyze-fees"],
    chainAffinity: ["base", "ethereum", "solana-mainnet", "solana-devnet"],
    permissions: { networkAccess: "mock", canSignTransactions: false },
  },
];

for (const manifest of MOCK_AGENT_MANIFESTS) {
  assertCoherent(manifest);
}

export function findManifest(agentId: string): AgentManifest | undefined {
  return MOCK_AGENT_MANIFESTS.find((manifest) => manifest.agentId === agentId);
}
