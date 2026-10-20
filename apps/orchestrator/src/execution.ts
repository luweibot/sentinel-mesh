import { createHash } from "node:crypto";
import type { AppConfig } from "@sentinel-mesh/config";
import type { Logger } from "@sentinel-mesh/logger";
import { buildProviders } from "@sentinel-mesh/chain-data";
import { DeterministicPolicyEngine } from "@sentinel-mesh/policy-engine";
import {
  AuthorizationService,
  DeterministicMockSigner,
  DeterministicPaperSimulator,
  DispatchingLiveSigner,
  DispatchingTradeBroadcast,
  GuardedExecutionService,
  IdempotencyRegistry,
  InMemoryAuthorizationStore,
  InMemoryLimitStore,
  KillSwitch,
  LimitsService,
  LiveEvmSigner,
  LiveQuoteSimulator,
  LiveSolanaSigner,
  ReconciliationLedger,
  StaticLimitPolicySource,
  type ChainTradeLeg,
  type ExecutionPort,
} from "@sentinel-mesh/execution";
import type { TradeIntent } from "@sentinel-mesh/contracts";
import type { GuardStateJournal, GuardStateSnapshot, KillSwitchState } from "@sentinel-mesh/execution";
import { createLiveTradeLegs } from "@sentinel-mesh/chain-adapters";

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
  /** Durably set a kill-switch scope (journal-first), when a journal is wired. */
  setKillSwitch(scope: "global" | "user" | "strategy", id: string | null, state: KillSwitchState): Promise<void>;
}

export interface BuildExecutionDeps {
  /**
   * Durable guard-state journal (audit 2026-10-19). When present:
   *  - commit points are journaled (receipts, idempotency, fills)
   *  - the kill switch does NOT auto-clear at boot: a missing durable
   *    'global' row stays UNKNOWN and execution fails closed until an
   *    operator clears it
   *  - boot restore is available via restoreGuardState()
   */
  journal?: GuardStateJournal;
  /**
   * Live trade legs (ADR-016). REQUIRED when config.executionMode is
   * "live" — the stack fails closed at boot without them. Never wired in
   * paper mode (the config gate still rejects "live" until the owner
   * releases it per docs/EXECUTION.md).
   */
  live?: LiveTradeLegs;
}

/** Live legs + the matching dispatching signer, from runtime env keys. */
export interface LiveTradeLegs {
  evm: ChainTradeLeg;
  solana: ChainTradeLeg;
}

/**
 * Build the live trade legs from the orchestrator runtime env (ADR-016).
 * Fails closed at boot — never at trade time — when a key is missing or
 * malformed: live mode requires BOTH legs to be wired.
 */
export function buildLiveTradeLegs(config: AppConfig, logger: Logger): LiveTradeLegs {
  const evmKey = process.env.EVM_PRIVATE_KEY;
  const solKey = process.env.SOLANA_PRIVATE_KEY;
  // Narrowing throws: each missing key aborts the boot (fail closed).
  if (!evmKey || !/^0x[0-9a-fA-F]{64}$/.test(evmKey)) {
    throw new Error("executionMode=live requires a valid EVM_PRIVATE_KEY (0x + 64 hex chars); refusing to start (fail closed)");
  }
  if (!solKey) {
    throw new Error("executionMode=live requires SOLANA_PRIVATE_KEY (base58) in the runtime environment; refusing to start (fail closed)");
  }
  // Constructed inside chain-adapters so viem type identities never
  // cross the package boundary (same pattern as the treasury leg).
  const legs = createLiveTradeLegs({
    rpcUrl: config.baseRpcUrl,
    privateKey: evmKey as `0x${string}`,
    recipient: config.paymentsReceiverAddress as `0x${string}`,
    solanaSecretKey: solKey,
    jupiterApiKey: process.env.JUPITER_API_KEY,
  });
  logger.warn({ solana: legs.solana.takerAddress }, "live_trade_legs_wired");
  return { evm: legs.evm, solana: legs.solana };
}



export function buildExecutionStack(
  config: AppConfig,
  logger: Logger,
  clock: { now(): Date },
  deps: BuildExecutionDeps = {},
): ExecutionStack {
  const liveMode = config.executionMode === "live";
  // Fail closed AT BOOT — never at trade time — when live mode is
  // requested without fully wired legs and keys.
  if (liveMode) {
    if (!deps.live?.evm || !deps.live?.solana || !process.env.EVM_PRIVATE_KEY || !process.env.SOLANA_PRIVATE_KEY) {
      throw new Error("executionMode=live requires live trade legs AND both runtime signer keys; refusing to start (fail closed)");
    }
  }
  const broadcaster = liveMode ? new DispatchingTradeBroadcast(deps.live?.evm, deps.live?.solana) : undefined;
  const evmKey = process.env.EVM_PRIVATE_KEY as `0x${string}` | undefined;
  const solKey = process.env.SOLANA_PRIVATE_KEY;
  const signer = liveMode
    ? new DispatchingLiveSigner(
        evmKey ? new LiveEvmSigner({ privateKey: evmKey }) : undefined,
        solKey ? new LiveSolanaSigner({ base58SecretKey: solKey }) : undefined,
      )
    : new DeterministicMockSigner();
  const killSwitch = new KillSwitch();
  // SECURITY (audit 2026-10-19): auto-clear ONLY in pure in-memory dev
  // mode. With a durable journal the switch restores from storage and a
  // missing 'global' row stays "unknown" (fail closed) — an ENGAGED switch
  // can never be lost to a restart, and every fresh deploy requires an
  // explicit operator clear.
  if (!deps.journal) {
    killSwitch.setGlobal("clear");
  }

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
  const idempotency = new IdempotencyRegistry();
  const limitStore = new InMemoryLimitStore(clock);
  // ONE authorization service shared by the minting endpoint and the
  // executor: consume() verifies against this store.
  const authorizations = new AuthorizationService(new InMemoryAuthorizationStore(), clock);
  const executor = new GuardedExecutionService({
    authorizationService: authorizations,
    idempotency,
    killSwitch,
    limits: new LimitsService(policies, limitStore, clock, deps.journal),
    ledger,
    policyEngine: new DeterministicPolicyEngine({
      policyVersion: "1.0.0",
      rules: {
        allowedChains: ["base", "ethereum", "solana", "solana-mainnet", "solana-devnet"],
        maxNotionalUsdCents: config.policyMaxNotionalUsdCents,
        notionalAdvisoryFraction: 1,
      },
    }),
    simulator: liveMode
      ? new LiveQuoteSimulator(broadcaster!, { slippageBps: 100 })
      : new DeterministicPaperSimulator(),
    signer,
    broadcaster,
    slippageBps: 100,
    clock,
    logger,
    minPoolTvlUsdCents: 100_000, // $1,000 liquidity floor
    liquidity: buildProviders(config.dataSource).liquidity,
    // Deterministic dev notional estimate: 1c per 10^6 base units.
    notionalUsdCentsFor: (intent: TradeIntent) => Math.ceil(Number(BigInt(intent.amountInRaw) / 10n ** 6n)),
    mode: { mode: liveMode ? "live" : config.executionMode === "paper" ? "paper" : "disabled" },
    journal: deps.journal,
  });

  const journal = deps.journal;
  const setKillSwitch = async (scope: "global" | "user" | "strategy", id: string | null, state: KillSwitchState): Promise<void> => {
    if (journal) {
      // Journal FIRST: a failed write never silently drops an ENGAGED
      // state, and a crash between the write and the memory set can only
      // lag the (older, fail-closed-safe) in-memory state by one request.
      const journalScope = scope === "global" ? "global" : `${scope}:${id}`;
      await journal.recordKillSwitch(journalScope, state);
    }
    if (scope === "global") {
      killSwitch.setGlobal(state);
    } else if (scope === "user" && id) {
      killSwitch.setUser(id, state);
    } else {
      killSwitch.setStrategy(id as string, state);
    }
  };

  const stack: ExecutionStack = {
    executor,
    port: executor,
    authorizations,
    killSwitch,
    ledger,
    submittedIntentIds: new Set(),
    setKillSwitch,
  };
  // Kept for restoreGuardState(); the stores are the same objects the
  // executor holds.
  (stack as ExecutionStack & { idempotency: IdempotencyRegistry; limitStore: InMemoryLimitStore }).idempotency = idempotency;
  (stack as ExecutionStack & { idempotency: IdempotencyRegistry; limitStore: InMemoryLimitStore }).limitStore = limitStore;
  return stack;
}

/**
 * SECURITY (audit 2026-10-19): boot-time restore of durable guard state.
 * MUST run before the server accepts traffic. Rebuilds:
 *  - the reconciliation ledger (receipts, incl. rejections)
 *  - the idempotency registry (recorded entries replay their receipts;
 *    in-flight entries were already dropped by the journal's restore())
 *  - limit-store fills (trade/position/exposure/loss caps keep counting)
 *  - kill-switch states (an ENGAGED switch survives; a missing global row
 *    stays unknown = fail closed)
 *  - submitted intent ids (reconciliation coverage after restart)
 */
export async function restoreGuardState(
  snapshot: GuardStateSnapshot,
  stack: ExecutionStack,
  logger: Logger,
): Promise<void> {
  stack.ledger.restore(snapshot.receipts);
  const internal = stack as ExecutionStack & { idempotency: IdempotencyRegistry; limitStore: InMemoryLimitStore };
  internal.idempotency.restore(snapshot.idempotency);
  internal.limitStore.restore(snapshot.fills);
  stack.killSwitch.restore(snapshot.killSwitch);
  // Reconciliation coverage is derived from RECEIPTS, not idempotency
  // rows: every journaled receipt — execution OR rejection (kill-switch,
  // limits) — proves its intent was submitted. Rejection receipts have
  // no 'recorded' idempotency row, so restoring the set from idempotency
  // alone flagged every rejected intent as an orphan after a restart
  // (observed in the ADR-015 drill). 'recorded' idempotency rows commit
  // in the same transaction as their receipt, so receipts are a
  // complete, duplicate-free source.
  for (const receipt of snapshot.receipts) {
    stack.submittedIntentIds.add(receipt.intentId);
  }
  logger.info(
    {
      receipts: snapshot.receipts.length,
      submittedIntents: stack.submittedIntentIds.size,
      idempotency: snapshot.idempotency.length,
      fills: snapshot.fills.length,
      killSwitch: snapshot.killSwitch.length,
    },
    "guard_state_restored",
  );
}

export function hashDemoIntent(intent: TradeIntent): string {
  return createHash("sha256").update(`${intent.intentId}:${intent.amountInRaw}`).digest("hex");
}
