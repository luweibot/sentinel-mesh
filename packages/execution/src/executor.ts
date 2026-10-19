import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import {
  RejectionCode,
  TradeIntent,
  ExecutionReceipt,
  type TradeAuthorization,
  type PolicyEvaluationRequest,
} from "@sentinel-mesh/contracts";
import type { Logger } from "@sentinel-mesh/logger";
import type { PolicyEngine } from "@sentinel-mesh/policy-engine";
import {
  buildEvmPaperDraft,
  buildSolanaPaperDraft,
  chainRegistryIdToCluster,
  MockEvmTradeAdapter,
  MockSolanaTradeAdapter,
} from "@sentinel-mesh/chain-adapters";
import { AuthorizationService, ExecutionRejectedError, intentHash, type Clock } from "./authorization.js";
import type { GuardStateJournal } from "./journal.js";
import { IdempotencyRegistry, KillSwitch, ReconciliationLedger } from "./safety.js";
import { LimitsService } from "./limits.js";
import type { LiquidityProvider } from "@sentinel-mesh/chain-data";
import { evmToken, getChain, solanaToken } from "@sentinel-mesh/chain-data";
import { DeterministicMockSigner, DeterministicPaperSimulator, type IsolatedSignerPort, type TransactionSimulationPort } from "./signing.js";

/**
 * Guarded execution pipeline (PAPER ONLY).
 *
 * Order of guards, fail closed at every step:
 *  1. kill switch            (engaged OR unknown state -> reject)
 *  2. idempotency            (duplicate identical -> replay prior receipt;
 *                             duplicate conflicting -> reject)
 *  3. policy engine          (separate engine; verdict must be "allow" with
 *                             executionMode "simulation"; review/error -> reject)
 *  4. authorization          (exact-bound, short-lived, single-use)
 *  5. limits                 (per-user, per-strategy, position, loss, exposure)
 *  6. liquidity              (pool TVL floor from the read-only data layer)
 *  7. simulation             (must be a clean success; uncertainty -> reject)
 *  8. fee & slippage         (simulated fee/impact within intent bounds)
 *  9. adapter validation      (chain-specific transaction rules)
 * 10. mock signing + paper receipt (never broadcast)
 *
 * There is no code path that skips a guard: submitIntent is the single
 * entry point and every rejection is a typed, recorded receipt.
 */

export const GUARD_PIPELINE_VERSION = "0.1.0" as const;

export interface ExecutionModeConfig {
  /** Only "paper" is representable; there is no live mode. */
  readonly mode: "disabled" | "paper";
}

export interface GuardedExecutorDeps {
  authorizationService: AuthorizationService;
  idempotency: IdempotencyRegistry;
  killSwitch: KillSwitch;
  limits: LimitsService;
  ledger: ReconciliationLedger;
  policyEngine: PolicyEngine;
  simulator: TransactionSimulationPort;
  signer: IsolatedSignerPort;
  clock: Clock;
  logger: Logger;
  /** Minimum pool TVL (USD cents) required for liquidity clearance. */
  minPoolTvlUsdCents: number;
  /** Read-only liquidity source; ABSENT sources fail closed. */
  liquidity: LiquidityProvider | undefined;
  /** Rough notional estimate for limit checks, in USD cents per intent. */
  notionalUsdCentsFor: (intent: TradeIntent) => number;
  mode: ExecutionModeConfig;
  /**
   * Durable guard-state journal (audit 2026-10-19). Absent in the pure
   * in-memory dev mode; when present, commit points are journaled before
   * receipts are returned and state is restored at boot.
   */
  journal?: GuardStateJournal;
}

/**
 * The ONLY execution surface exposed to strategy agents. It accepts an
 * already-authorized intent; the signer, keys, and adapters are not
 * reachable through this interface.
 */
export interface ExecutionPort {
  submitIntent(intent: TradeIntent, authorization: TradeAuthorization | undefined): Promise<ExecutionReceipt>;
  receiptById(receiptId: string): Promise<ExecutionReceipt | undefined>;
  /** Intents that completed (paper-filled) or were rejected; for audit. */
  receiptsForIntent(intentId: string): Promise<ExecutionReceipt[]>;
}

export class GuardedExecutionService implements ExecutionPort {
  private readonly evmAdapter = new MockEvmTradeAdapter();
  private readonly solanaAdapter = new MockSolanaTradeAdapter();

  constructor(private readonly deps: GuardedExecutorDeps) {}

  async submitIntent(intent: TradeIntent, authorization: TradeAuthorization | undefined): Promise<ExecutionReceipt> {
    const decidedAt = this.deps.clock.now().toISOString();
    // Cap reservation handle: set the moment limits pass, released on any
    // later rejection (see catch below). Null until reserved.
    let reservedFillId: string | null = null;
    try {
      TradeIntent.parse(intent);
    } catch (error) {
      return await this.reject(intent, authorization, "invalid-authorization", `intent failed schema validation: ${String(error)}`, decidedAt);
    }

    // Fail closed when execution is not explicitly enabled as paper.
    if (this.deps.mode.mode !== "paper") {
      return await this.reject(intent, authorization, "execution-disabled", "guarded execution is disabled; only the paper mode may execute", decidedAt);
    }

    try {
      // 1. kill switch (fail closed on unknown)
      this.deps.killSwitch.check({ userId: intent.userId, strategyId: intent.strategyId });

      // 2. idempotency
      const hash = intentHash(intent);
      const priorReceiptId = this.deps.idempotency.begin(intent.intentId, hash);
      if (priorReceiptId) {
        const prior = await this.receiptById(priorReceiptId);
        if (prior) {
          return prior; // duplicate submission -> replay the original receipt
        }
        // SECURITY (audit 2026-10-19): the registry recorded this intent as
        // completed but its receipt is not in the ledger (partial restore
        // or ledger corruption). FAIL CLOSED: never re-execute an intent
        // the registry says already completed.
        throw new ExecutionRejectedError(
          "duplicate-submission-conflict",
          `intent ${intent.intentId} is recorded as executed but its receipt is missing from the ledger; failing closed`,
        );
      }

      // 3. policy engine (independent decisionmaker)
      await this.evaluatePolicy(intent);

      // 4. authorization (exact bound, short-lived, single use)
      const consumed = await this.deps.authorizationService.consume(authorization, intent);

      // 5. limits — SECURITY (audit 2026-10-18): the cap check AND the fill
      // reservation happen in one synchronous step so two concurrent intents
      // cannot both pass the caps before either is recorded.
      const notionalUsdCents = this.deps.notionalUsdCentsFor(intent);
      reservedFillId = await this.deps.limits.evaluateAndReserve(intent, notionalUsdCents);

      // 6. liquidity clearance (fail closed when no source is wired)
      await this.checkLiquidity(intent);

      // 7. simulation (uncertainty fails closed; run before fee bounds since
      //    the fee bound is checked against the simulated fee)
      const simulation = await this.deps.simulator.simulate(intent);
      if (simulation.status === "failed") {
        throw new ExecutionRejectedError("simulation-failed", simulation.detail);
      }
      if (simulation.status === "uncertain") {
        throw new ExecutionRejectedError("simulation-uncertain", `${simulation.detail} (RPC uncertainty fails closed)`);
      }

      // 6/8. fee, slippage, price impact bounds from the simulation
      if (simulation.feeUsdCents > intent.maxFeeUsdCents) {
        throw new ExecutionRejectedError("fee-limit-exceeded", `simulated fee ${simulation.feeUsdCents}c exceeds the intent bound ${intent.maxFeeUsdCents}c`);
      }
      if (BigInt(simulation.simulatedOutRaw) < BigInt(intent.minAmountOutRaw)) {
        throw new ExecutionRejectedError("slippage-limit-exceeded", `simulated output ${simulation.simulatedOutRaw} is below the intent minimum ${intent.minAmountOutRaw}`);
      }
      if (simulation.priceImpactBps > intent.maxPriceImpactBps) {
        throw new ExecutionRejectedError("price-impact-exceeded", `simulated impact ${simulation.priceImpactBps}bps exceeds the intent bound ${intent.maxPriceImpactBps}bps`);
      }

      // 9. chain-specific transaction validation
      this.validateTransaction(intent);

      // 10. mock signing + paper receipt (never broadcast)
      const canonical = `${intent.intentId}:${intent.chain}:${intent.tokenIn}:${intent.tokenOut}:${intent.amountInRaw}:${simulation.simulatedOutRaw}`;
      const signed = await this.deps.signer.signExecution(canonical);
      const paperTxHash = `paper-${createHash("sha256").update(`${signed.signature}:${intent.intentId}`).digest("hex").slice(0, 40)}`;

      // The fill was reserved atomically in step 5; it now commits as the
      // receipt is recorded. No second recordFill is needed (and one would
      // double-count).

      const receipt: ExecutionReceipt = {
        schemaVersion: 1,
        receiptId: randomUUID(),
        intentId: intent.intentId,
        authorizationId: consumed.authorizationId,
        status: "paper-filled",
        executionMode: "paper",
        paperTxHash,
        simulatedOutRaw: simulation.simulatedOutRaw,
        feeUsdCents: simulation.feeUsdCents,
        decidedAt: this.deps.clock.now().toISOString(),
        guardPipelineVersion: GUARD_PIPELINE_VERSION,
      };
      this.deps.ledger.record(receipt);
      this.deps.idempotency.complete(intent.intentId, hash, receipt.receiptId);
      // SECURITY (audit 2026-10-19): the receipt AND its idempotency entry
      // are journaled atomically BEFORE the receipt is returned, so a
      // crash after this point can never lose a completed execution. On
      // restore, the recorded entry replays this receipt instead of
      // allowing a second execution.
      if (this.deps.journal) {
        await this.deps.journal.recordCommit(receipt, { intentId: intent.intentId, intentHash: hash, receiptId: receipt.receiptId });
      }
      this.deps.logger.info({ intentId: intent.intentId, receiptId: receipt.receiptId, chain: intent.chain }, "execution_paper_filled");
      return receipt;
    } catch (error) {
      // SECURITY (audit 2026-10-18): release OUR cap reservation (if the
      // pipeline got past limits) so rejected intents do not permanently
      // consume cap space.
      if (reservedFillId !== null) {
        const fillId = reservedFillId;
        reservedFillId = null;
        await this.deps.limits.releaseReservation(fillId);
      }
      if (error instanceof ExecutionRejectedError) {
        // SECURITY (audit 2026-10-18): a duplicate-in-flight rejection must
        // NOT abort the idempotency reservation: that entry belongs to the
        // request that won the race, and deleting it would let a later
        // identical submission execute the intent a second time.
        if (error.code !== "duplicate-submission-conflict") {
          this.deps.idempotency.abort(intent.intentId, intentHash(intent));
          await this.deps.journal?.recordAbort(intent.intentId);
        }
        return await this.reject(intent, authorization, error.code, error.message, decidedAt);
      }
      // Unknown errors are also fail closed, with the generic guard code.
      this.deps.idempotency.abort(intent.intentId, intentHash(intent));
      await this.deps.journal?.recordAbort(intent.intentId);
      return await this.reject(intent, authorization, "policy-error", `unexpected guard pipeline failure: ${String(error)}`, decidedAt);
    }
  }

  async receiptById(receiptId: string): Promise<ExecutionReceipt | undefined> {
    return this.deps.ledger.receiptById(receiptId);
  }

  async receiptsForIntent(intentId: string): Promise<ExecutionReceipt[]> {
    return this.deps.ledger.receiptsForIntent(intentId);
  }

  private async evaluatePolicy(intent: TradeIntent): Promise<void> {
    const request: PolicyEvaluationRequest = {
      schemaVersion: 1,
      signalId: intent.intentId,
      chain: intent.chain,
      tokenIn: intent.tokenIn,
      tokenOut: intent.tokenOut,
      notionalUsdCents: this.deps.notionalUsdCentsFor(intent),
      requestedAt: this.deps.clock.now().toISOString(),
    };
    let decision;
    try {
      decision = await this.deps.policyEngine.evaluate(request);
    } catch (error) {
      throw new ExecutionRejectedError("policy-error", `policy evaluation failed: ${String(error)}`);
    }
    if (decision.verdict === "reject") {
      throw new ExecutionRejectedError("policy-rejected", decision.reasons.filter((r) => r.severity === "reject").map((r) => r.message).join("; ") || "policy engine rejected the intent");
    }
    if (decision.verdict === "requires-review") {
      throw new ExecutionRejectedError("policy-review-required", "policy engine requires human review before execution");
    }
    if (decision.executionMode !== "simulation") {
      throw new ExecutionRejectedError("policy-error", `policy decision carries unsupported execution mode '${decision.executionMode}'`);
    }
  }

  /** Liquidity guard: observable TVL for the output token must clear the floor. */
  private async checkLiquidity(intent: TradeIntent): Promise<void> {
    const provider = this.deps.liquidity;
    if (!provider) {
      throw new ExecutionRejectedError("liquidity-insufficient", "no liquidity source is configured; failing closed");
    }
    const chainRecord = getChain(intent.chain === "base" || intent.chain === "ethereum" ? intent.chain : intent.chain === "solana-devnet" ? "solana-devnet" : "solana-mainnet");
    const token = chainRecord.kind === "evm"
      ? evmToken(chainRecord, intent.tokenOut)
      : solanaToken(chainRecord, intent.tokenOut);
    const page = await provider.getLiquidity(chainRecord, token);
    const tvlUsdCents = Math.round(page.items.reduce((sum, pool) => sum + pool.tvlUsd, 0) * 100);
    if (page.items.length === 0 || tvlUsdCents < this.deps.minPoolTvlUsdCents) {
      throw new ExecutionRejectedError(
        "liquidity-insufficient",
        `observed liquidity ${tvlUsdCents}c is below the required floor ${this.deps.minPoolTvlUsdCents}c`,
      );
    }
  }

  private validateTransaction(intent: TradeIntent): void {
    if (intent.chain === "base" || intent.chain === "ethereum") {
      const draft = buildEvmPaperDraft({
        chain: intent.chain,
        amountInRaw: intent.amountInRaw,
        tokenIn: intent.tokenIn,
        tokenOut: intent.tokenOut,
        minAmountOutRaw: intent.minAmountOutRaw,
      });
      const result = this.evmAdapter.validateTransaction(draft);
      if (!result.ok) {
        throw new ExecutionRejectedError("adapter-validation-failed", result.problems.map((p) => p.message).join("; "));
      }
      return;
    }
    if (intent.chain === "solana" || intent.chain === "solana-mainnet" || intent.chain === "solana-devnet") {
      const draft = buildSolanaPaperDraft({
        cluster: chainRegistryIdToCluster(intent.chain),
        amountInRaw: intent.amountInRaw,
        tokenIn: intent.tokenIn,
        tokenOut: intent.tokenOut,
        minAmountOutRaw: intent.minAmountOutRaw,
      });
      const result = this.solanaAdapter.validateTransaction(draft);
      if (!result.ok) {
        throw new ExecutionRejectedError("adapter-validation-failed", result.problems.map((p) => p.message).join("; "));
      }
      return;
    }
    throw new ExecutionRejectedError("adapter-validation-failed", `no transaction validator registered for chain '${intent.chain}'`);
  }

  private async reject(
    intent: TradeIntent,
    authorization: TradeAuthorization | undefined,
    code: RejectionCode,
    detail: string,
    decidedAt: string,
  ): Promise<ExecutionReceipt> {
    const receipt: ExecutionReceipt = {
      schemaVersion: 1,
      receiptId: randomUUID(),
      intentId: intent.intentId,
      authorizationId: authorization?.authorizationId ?? null,
      status: "rejected",
      executionMode: "paper",
      rejectionCode: code,
      rejectionDetail: detail,
      decidedAt,
      guardPipelineVersion: GUARD_PIPELINE_VERSION,
    };
    this.deps.ledger.record(receipt);
    this.deps.logger.warn({ intentId: intent.intentId, code }, "execution_rejected");
    // SECURITY (audit 2026-10-19): rejection receipts are journaled too, so
    // the restored ledger keeps the complete audit trail after a restart.
    if (this.deps.journal) {
      await this.deps.journal.recordRejection(receipt);
    }
    return receipt;
  }
}

/**
 * Factory for the dev environment: wires the deterministic mock stack.
 * Nothing here accepts keys or network credentials.
 */
export function createPaperExecutor(
  deps: Omit<GuardedExecutorDeps, "simulator" | "signer"> & { simulator?: TransactionSimulationPort; signer?: IsolatedSignerPort },
): GuardedExecutionService {
  return new GuardedExecutionService({
    ...deps,
    simulator: deps.simulator ?? new DeterministicPaperSimulator(),
    signer: deps.signer ?? new DeterministicMockSigner(),
  });
}
