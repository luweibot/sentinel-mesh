import { createHash } from "node:crypto";
import {
  PaymentGuardVerdict,
  RecipientAllowlistEntry,
  AssetAllowlistEntry,
  X402_CHAIN_IDS,
  X402PaymentPayload,
  X402PaymentRequirement,
  X402Settlement,
  type PaymentRecord as PaymentRecordType,
  type X402PaymentRequirement as RequirementType,
} from "@sentinel-mesh/contracts";
import type { Logger } from "@sentinel-mesh/logger";
import { SpendCapLedger } from "./spend-caps.js";
import { PaymentRecordStore } from "./records.js";

/**
 * x402 v1 payment guard.
 *
 * VERIFIES: requirement shape (version/scheme/chain/asset/amount/recipient),
 * expiry windows, replay resistance (EIP-3009 nonces + idempotent records),
 * per-agent spend caps, and settlement evidence from allowlisted
 * facilitators. A settled payment grants CONTENT ACCESS only —
 * `grants.trading` is the literal `false`; there is no API from a payment
 * to a trade authorization (the execution package has no dependency here).
 */

export interface X402GuardDeps {
  assets: AssetAllowlistEntry[];
  recipients: RecipientAllowlistEntry[];
  /** Per-agent daily caps, USD cents. */
  caps: SpendCapLedger;
  records: PaymentRecordStore;
  facilitatorIds: string[];
  clock: { now(): Date };
  logger: Logger;
  /** Optional bound on a single payment (atomic units per asset). */
  maxSinglePayment?: bigint;
}

export function requirementHash(requirement: RequirementType, payload: X402PaymentPayload): string {
  return createHash("sha256")
    .update([requirement.network, requirement.asset, requirement.maxAmountRequired, requirement.payTo, payload.payload.nonce].join(":"))
    .digest("hex");
}

export class X402PaymentGuard {
  constructor(private readonly deps: X402GuardDeps) {}

  private reject(record: PaymentRecordType, code: PaymentRecordType["rejectionCode"], message: string): PaymentGuardVerdict {
    // A rejected payment grants nothing.
    const rejected: PaymentRecordType = { ...record, status: "rejected", rejectionCode: code, grants: { contentAccess: false, trading: false } };
    this.deps.records.save(rejected);
    this.deps.logger.warn({ paymentId: rejected.paymentId, code }, "payment_rejected");
    return { ok: false, code, message, record: rejected };
  }

  /**
   * Process one x402 payment attempt end to end:
   * requirement + payload verification, replay check, cap accounting,
   * idempotent record. Settlement evidence is verified separately (most
   * facilitators settle asynchronously).
   */
  async process(request: { agentId: string; requirement: unknown; payment: unknown; paymentId: string }): Promise<PaymentGuardVerdict> {
    const now = this.deps.clock.now();
    let requirement: RequirementType;
    try {
      requirement = X402PaymentRequirement.parse(request.requirement);
    } catch (error) {
      return this.fail(request, "unsupported-x402-version", `requirement failed schema validation: ${error instanceof Error ? error.message : "invalid"}`);
    }
    let payment: X402PaymentPayload;
    try {
      payment = X402PaymentPayload.parse(request.payment);
    } catch (error) {
      return this.fail(request, "unsupported-scheme", `payment payload failed schema validation: ${error instanceof Error ? error.message : "invalid"}`);
    }
    // Idempotency: the same paymentId must never double-count.
    const existing = this.deps.records.find(request.paymentId);
    const hash = requirementHash(requirement, payment);
    const chain = X402_CHAIN_IDS[requirement.network];
    const base: PaymentRecordType = {
      paymentId: request.paymentId,
      agentId: request.agentId,
      requirementHash: hash,
      chain: chain ?? String(requirement.network),
      asset: requirement.asset,
      payTo: requirement.payTo,
      amount: requirement.maxAmountRequired,
      status: "recorded",
      nonce: payment.payload.nonce,
      grants: { contentAccess: true, trading: false },
      recordedAt: now.toISOString(),
    };
    if (existing) {
      if (existing.status === "settled" || existing.status === "recorded") {
        return { ok: true, message: "idempotent replay of a known paymentId; no second record", record: existing };
      }
    }

    // Requirement checks: chain, asset, recipient, amount.
    if (!chain) return this.reject(base, "unsupported-chain", `network ${requirement.network} is not supported`);
    const asset = this.deps.assets.find((entry) => entry.chain === chain && entry.address.toLowerCase() === requirement.asset.toLowerCase());
    if (!asset) return this.reject(base, "asset-not-allowed", `asset ${requirement.asset} is not allowlisted on ${chain}`);
    const recipient = this.deps.recipients.find((entry) => entry.address.toLowerCase() === requirement.payTo.toLowerCase());
    if (!recipient) return this.reject(base, "recipient-not-allowed", `payTo ${requirement.payTo} is not in the recipient allowlist`);
    if (BigInt(requirement.maxAmountRequired) === 0n) return this.reject(base, "invalid-amount", "amount must be positive");
    if (this.deps.maxSinglePayment && BigInt(requirement.maxAmountRequired) > this.deps.maxSinglePayment) {
      return this.reject(base, "invalid-amount", `single-payment cap exceeded (${requirement.maxAmountRequired} > ${this.deps.maxSinglePayment})`);
    }

    // Payload binding: the payment must pay EXACTLY the requirement.
    if (payment.payload.value !== requirement.maxAmountRequired) {
      return this.reject(base, "amount-mismatch", `payload value ${payment.payload.value} != required ${requirement.maxAmountRequired}`);
    }
    if (payment.payload.to.toLowerCase() !== requirement.payTo.toLowerCase()) {
      return this.reject(base, "settlement-mismatch", `payload recipient does not match payTo`);
    }

    // Expiry: EIP-3009 window.
    const validBefore = Date.parse(payment.payload.validBefore);
    const validAfter = Date.parse(payment.payload.validAfter);
    if (validBefore <= validAfter) return this.reject(base, "payment-window-invalid", "validBefore must be after validAfter");
    if (now.getTime() >= validBefore) return this.reject(base, "requirement-expired", `validBefore ${payment.payload.validBefore} has passed`);
    if (now.getTime() < validAfter) return this.reject(base, "payment-window-invalid", `validAfter ${payment.payload.validAfter} is in the future`);

    // Replay resistance: the nonce must be globally unique (per payer).
    if (this.deps.records.findByNonce(payment.payload.nonce)) {
      return this.reject(base, "payment-replay", `nonce ${payment.payload.nonce} was already used`);
    }

    // Per-agent spend caps (atomic -> USD cents via decimals).
    const amountUsdCents = (BigInt(requirement.maxAmountRequired) * 100n) / 10n ** BigInt(asset.decimals);
    const capVerdict = this.deps.caps.tryReserve(request.agentId, amountUsdCents, now);
    if (!capVerdict.ok) {
      return this.reject(base, "spend-cap-exceeded", `agent '${request.agentId}' daily cap exceeded (utilized ${capVerdict.utilizedUsdCents}c)`);
    }

    this.deps.records.save(base);
    this.deps.logger.info({ paymentId: base.paymentId, agentId: base.agentId, amount: base.amount }, "payment_recorded");
    return { ok: true, record: base };
  }

  /**
   * Verify settlement evidence. Only allowlisted facilitators count, and
   * the evidence must match the recorded requirement (amount/asset/payTo
   * via the requirement hash, plus network and success).
   */
  async verifySettlement(paymentId: string, settlement: unknown): Promise<PaymentGuardVerdict> {
    const record = this.deps.records.find(paymentId);
    if (!record) return { ok: false, code: "settlement-invalid", message: "unknown paymentId" };
    let evidence: X402Settlement;
    try {
      evidence = X402Settlement.parse(settlement);
    } catch (error) {
      return { ok: false, code: "settlement-invalid", message: `settlement failed schema validation: ${error instanceof Error ? error.message : "invalid"}` };
    }
    if (!this.deps.facilitatorIds.includes(evidence.facilitatorId)) {
      return { ok: false, code: "settlement-facilitator-not-allowed", message: `facilitator '${evidence.facilitatorId}' is not allowlisted` };
    }
    if (!evidence.payload.success) {
      return { ok: false, code: "facilitator-error", message: evidence.payload.error?.message ?? "facilitator reported failure" };
    }
    const requirementChain = X402_CHAIN_IDS[evidence.network];
    if (!requirementChain || requirementChain !== record.chain) {
      return { ok: false, code: "settlement-mismatch", message: `settlement network ${evidence.network} does not match recorded chain ${record.chain}` };
    }
    if (!evidence.payload.transactionHash) {
      return { ok: false, code: "settlement-mismatch", message: "settlement evidence lacks a transaction hash" };
    }
    const settled: PaymentRecordType = {
      ...record,
      status: "settled",
      facilitatorId: evidence.facilitatorId,
      transactionHash: evidence.payload.transactionHash,
      settledAt: this.deps.clock.now().toISOString(),
    };
    this.deps.records.save(settled);
    // Settled payments commit the reserved spend.
    this.deps.caps.commit(record.agentId);
    this.deps.logger.info({ paymentId }, "payment_settled");
    return { ok: true, record: settled };
  }

  /** Records list + reconciliation. */
  list(): PaymentRecordType[] {
    return this.deps.records.list();
  }

  reconcile(): { ranAt: string; recordsChecked: number; settledWithoutEvidence: string[]; duplicateNonces: string[]; consistent: boolean } {
    const records = this.deps.records.list();
    const settledWithoutEvidence = records.filter((record) => record.status === "settled" && !record.transactionHash).map((record) => record.paymentId);
    const seen = new Set<string>();
    const duplicateNonces: string[] = [];
    for (const record of records) {
      if (seen.has(record.nonce)) duplicateNonces.push(record.nonce);
      seen.add(record.nonce);
    }
    return {
      ranAt: this.deps.clock.now().toISOString(),
      recordsChecked: records.length,
      settledWithoutEvidence,
      duplicateNonces,
      consistent: settledWithoutEvidence.length === 0 && duplicateNonces.length === 0,
    };
  }

  private fail(request: { agentId: string; paymentId: string }, code: PaymentRecordType["rejectionCode"], message: string): PaymentGuardVerdict {
    const now = this.deps.clock.now();
    const rejected: PaymentRecordType = {
      paymentId: request.paymentId,
      agentId: request.agentId,
      requirementHash: "(unparsable)",
      chain: "(unknown)",
      asset: "0x0000000000000000000000000000000000000000",
      payTo: "0x0000000000000000000000000000000000000000",
      amount: "0",
      status: "rejected",
      rejectionCode: code,
      nonce: "00000000-0000-4000-8000-000000000000",
      grants: { contentAccess: false, trading: false },
      recordedAt: now.toISOString(),
    };
    this.deps.records.save(rejected);
    return { ok: false, code, message, record: rejected };
  }
}
