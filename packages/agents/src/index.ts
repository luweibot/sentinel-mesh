import { MockNewsProvider, MockResearchProvider, MockSourceVerifier } from "./providers.js";
import { createTokenRiskAgent } from "./token-risk-agent.js";
import { createWhaleTrackingAgent } from "./whale-tracking-agent.js";
import { createFeeIntelligenceAgent } from "./fee-intelligence-agent.js";
import { fixtureProviders } from "@sentinel-mesh/chain-data";
import type { ExecutionPort } from "@sentinel-mesh/execution";
import { createPaperTradeAgent } from "./paper-trade-agent.js";
import { createResearchAgent } from "./research-agent.js";
import { createSourceVerificationAgent } from "./source-verification-agent.js";
import { createNewsIntelligenceAgent } from "./news-intelligence-agent.js";
import type { OrchestrationEngine } from "@sentinel-mesh/orchestrator";

export * from "./providers.js";
export * from "./research-agent.js";
export * from "./source-verification-agent.js";
export * from "./news-intelligence-agent.js";
export * from "./plan.js";
export * from "./token-risk-agent.js";
export * from "./whale-tracking-agent.js";
export * from "./fee-intelligence-agent.js";
export * from "./paper-trade-agent.js";

/** Deterministic provider set for dev, tests, and traces. */
export function createMockProviders() {
  return {
    research: new MockResearchProvider(),
    verifier: new MockSourceVerifier(),
    news: new MockNewsProvider(),
  };
}

export function createResearchAgents() {
  const providers = createMockProviders();
  return {
    providers,
    agents: [
      createResearchAgent(providers.research),
      createSourceVerificationAgent(providers.verifier),
      createNewsIntelligenceAgent(providers.news),
    ],
  };
}

/** Register all research agents on an engine. */
export function registerResearchAgents(engine: OrchestrationEngine): void {
  const { agents } = createResearchAgents();
  for (const agent of agents) {
    engine.register(agent);
  }
}

/**
 * Register the read-only chain intelligence agents (token-risk,
 * whale-tracking, fee-intelligence). Their inputs are evidence built from
 * the chain-data fixture providers, so no paid API is required.
 */
export function registerChainAgents(engine: OrchestrationEngine): void {
  void fixtureProviders; // referenced for the type import chain; fixtures are used by callers
  engine.register(createTokenRiskAgent());
  engine.register(createWhaleTrackingAgent());
  engine.register(createFeeIntelligenceAgent());
}

/**
 * Register the paper-trading agent with an injected ExecutionPort. The
 * port is created by the host service; the agent gets no signer, keys,
 * or authorization minting capability.
 */
export function registerPaperTradeAgent(engine: OrchestrationEngine, executionPort: ExecutionPort): void {
  engine.register(createPaperTradeAgent(executionPort));
}

/** Register every agent shipped in this package. */
export function registerAllAgents(engine: OrchestrationEngine, executionPort?: ExecutionPort): void {
  registerResearchAgents(engine);
  registerChainAgents(engine);
  if (executionPort) {
    registerPaperTradeAgent(engine, executionPort);
  }
}
