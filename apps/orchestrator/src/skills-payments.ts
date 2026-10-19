import type { AppConfig } from "@sentinel-mesh/config";
import type { Logger } from "@sentinel-mesh/logger";
import { SkillRegistry } from "@sentinel-mesh/skills";
import { LiveFacilitator, MockFacilitator, PaymentRecordStore, SpendCapLedger, X402PaymentGuard, MOCK_ASSETS, createHttpRpcCaller, LIVE_FACILITATOR_ID } from "@sentinel-mesh/payments";
import type { SpendCapStateJournal } from "@sentinel-mesh/orchestrator";
import type { AgentCapability } from "@sentinel-mesh/contracts";

/**
 * Dev-environment skills + x402 payments wiring.
 *
 * Everything is deterministic and in-memory: the skill registry gates every
 * install behind an explicit human approve(), and the payment guard runs
 * against mock facilitators and fixture requirements (no keys, no network,
 * no API credentials). Adding a live facilitator requires an ADR and a
 * config flag (see docs/X402.md).
 */

export interface SkillsStack {
  registry: SkillRegistry;
}

/** Durable spend-cap journal (optional; absent in dev mode). */
export interface PaymentsDeps {
  journal?: SpendCapStateJournal;
}

export interface PaymentsStack {
  guard: X402PaymentGuard;
  facilitator: MockFacilitator | LiveFacilitator;
  /** The spend-cap ledger, exposed for boot-time durable restore. */
  caps: SpendCapLedger;
}

/**
 * Capability allowlist for THIS deployment. A skill may never exceed it.
 * DELIBERATELY excludes trade-simulation, signal-generation, and
 * paper-trading: skills can extend intelligence, never execution.
 */
export const SKILL_CAPABILITY_ALLOWLIST: readonly AgentCapability[] = [
  "trend-analysis",
  "wallet-monitoring",
  "research",
  "source-verification",
  "news-intelligence",
  "token-risk",
  "whale-tracking",
  "fee-intelligence",
];

export function buildSkillsStack(config: AppConfig, logger: Logger, clock: { now(): Date }): SkillsStack {
  void config;
  return {
    registry: new SkillRegistry({
      allowedCapabilities: SKILL_CAPABILITY_ALLOWLIST,
      clock,
      logger,
    }),
  };
}

/** Demo per-agent daily caps (USD cents): $10/agent/day, paper fixtures. */
const DEMO_SPEND_CAPS: Record<string, number> = {
  "trend-scout-agent": 1_000,
  "whale-tracking-agent": 1_000,
};

export function buildPaymentsStack(
  config: AppConfig,
  logger: Logger,
  clock: { now(): Date },
  deps: PaymentsDeps = {},
): PaymentsStack {
  // LIVE mode: signatures are verified cryptographically and settlement is
  // confirmed on-chain (Base public RPC). PAPER mode: mock facilitator, trust.
  const facilitator =
    config.paymentsMode === "live"
      ? new LiveFacilitator(createHttpRpcCaller(config.baseRpcUrl), clock, { usdcAddress: config.baseUsdcAddress })
      : new MockFacilitator(clock);
  const caps = new SpendCapLedger(DEMO_SPEND_CAPS, 5_000, deps.journal);
  // x402 receiver: the project's wallet (config), never the demo fixtures.
  const recipients = [{ address: config.paymentsReceiverAddress, label: "sentinel-mesh project wallet" }];
  const guard = new X402PaymentGuard({
    // Base USDC address follows config (BASE_USDC_ADDRESS) so the guard's
    // allowlist matches the requirement asset on this deployment's chain.
    assets: MOCK_ASSETS.map((a) =>
      a.chain === "base" ? { ...a, address: config.baseUsdcAddress } : a,
    ),
    recipients,
    caps,
    records: new PaymentRecordStore(),
    facilitator,
    facilitatorIds: [facilitator.facilitatorId],
    clock,
    logger,
  });
  return { guard, facilitator, caps };
}
