import { createHash } from "node:crypto";
import type { AppConfig } from "@sentinel-mesh/config";
import type { Logger } from "@sentinel-mesh/logger";
import { fixtureProviders } from "@sentinel-mesh/chain-data";
import { DeterministicPolicyEngine } from "@sentinel-mesh/policy-engine";
import {
  AuthorizationService,
  DeterministicMockSigner,
  DeterministicPaperSimulator,
  GuardedExecutionService,
  IdempotencyRegistry,
  InMemoryAuthorizationStore,
  InMemoryLimitStore,
  KillSwitch,
  LimitsService,
  ReconciliationLedger,
  StaticLimitPolicySource,
  type ExecutionPort,
} from "@sentinel-mesh/execution";
import type { TradeIntent } from "@sentinel-mesh/contracts";

/**
 * Dev-environment execution wiring.
 *
 * Everything here is deterministic and in-memory: fixture liquidity,
 * deterministic paper simulator, mock signer, in-memory stores. No keys,
 * no network, no broadcast. The demo limit policies are static because the
 * platform has no user registry in this phase (documented limitation).
 */

export const DEMO_USER = "demo-user";
export const DEMO_STRATEGY = "demo-strategy";
/** Harness approver for the dev environment ONLY; production uses a real
 *  approver (human/governance service) behind the same interface. */
export const DEV_HARNESS_APPROVER = "dev-harness-approver";

export interface ExecutionStack {
  executor: GuardedExecutionService;
  port: ExecutionPort;
  authorizations: AuthorizationService;
  killSwitch: KillSwitch;
  ledger: ReconciliationLedger;
  /** Intent ids that were submitted to the executor, for reconciliation. */
  submittedIntentIds: Set<string>;
}

export function buildExecutionStack(config: AppConfig, logger: Logger, clock: { now(): Date }): ExecutionStack {
  const killSwitch = new KillSwitch();
  // Explicitly clear for the dev environment; ops can engage/unknown it via
  // the kill-switch endpoint at any time.
  killSwitch.setGlobal("clear");

  const policies = new StaticLimitPolicySource();
  // Demo caps (USD cents): $5k/trade, 20 trades/day, $20k open position,
  // $10k daily loss cap, $15k per-chain exposure.
  policies.setUserLimits(DEMO_USER, {
    maxTradeUsdCents: 500_000,
    maxTradesPerDay: 20,
    maxOpenPositionUsdCents: 2_000_000,
    dailyLossCapUsdCents: 1_000_000,
    maxChainExposureUsdCents: {
      base: 1_500_000,
      ethereum: 1_500_000,
      solana: 1_500_000,
      "solana-mainnet": 1_500_000,
      "solana-devnet": 1_500_000,
    },
  });
  policies.setStrategyLimits(DEMO_STRATEGY, { maxTradeUsdCents: 400_000, maxTradesPerDay: 15 });

  const ledger = new ReconciliationLedger();
  // ONE authorization service shared by the minting endpoint and the
  // executor: consume() verifies against this store.
  const authorizations = new AuthorizationService(new InMemoryAuthorizationStore(), clock);
  const executor = new GuardedExecutionService({
    authorizationService: authorizations,
    idempotency: new IdempotencyRegistry(),
    killSwitch,
    limits: new LimitsService(policies, new InMemoryLimitStore(clock), clock),
    ledger,
    policyEngine: new DeterministicPolicyEngine({
      policyVersion: "1.0.0",
      rules: {
        allowedChains: ["base", "ethereum", "solana", "solana-mainnet", "solana-devnet"],
        maxNotionalUsdCents: config.policyMaxNotionalUsdCents,
        notionalAdvisoryFraction: 1,
      },
    }),
    simulator: new DeterministicPaperSimulator(),
    signer: new DeterministicMockSigner(),
    clock,
    logger,
    minPoolTvlUsdCents: 100_000, // $1,000 liquidity floor
    liquidity: fixtureProviders().liquidity,
    // Deterministic dev notional estimate: 1c per 10^6 base units.
    notionalUsdCentsFor: (intent: TradeIntent) => Math.ceil(Number(BigInt(intent.amountInRaw) / 10n ** 6n)),
    mode: { mode: config.executionMode === "paper" ? "paper" : "disabled" },
  });

  const stack: ExecutionStack = {
    executor,
    port: executor,
    authorizations,
    killSwitch,
    ledger,
    submittedIntentIds: new Set(),
  };
  return stack;
}

export function hashDemoIntent(intent: TradeIntent): string {
  return createHash("sha256").update(`${intent.intentId}:${intent.amountInRaw}`).digest("hex");
}
