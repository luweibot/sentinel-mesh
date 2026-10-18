import type { X402Settlement } from "@sentinel-mesh/contracts";

/**
 * Facilitator adapters. Only allowlisted facilitator ids may produce
 * settlement evidence the guard accepts. THIS PHASE ships only the
 * deterministic mock facilitator (no network, no keys). Adding a live
 * facilitator requires: documented protocol version compatibility, a new
 * ADR, a config flag, and code review — never a runtime download.
 */
export interface FacilitatorAdapter {
  readonly facilitatorId: string;
  /** Verify a payment payload against a requirement and (mock) settle it. */
  verifyAndSettle(request: { requirement: unknown; payment: unknown }): Promise<X402Settlement>;
}

export class MockFacilitator implements FacilitatorAdapter {
  readonly facilitatorId = "mock-facilitator";
  private readonly settled = new Set<string>();

  constructor(private readonly clock: { now(): Date }) {}

  async verifyAndSettle(request: {
    requirement: { network?: number; payTo?: string; maxAmountRequired?: string };
    payment: { payload?: { nonce?: string; to?: string; value?: string } };
  }): Promise<X402Settlement> {
    const requirement = request.requirement ?? {};
    const payload = request.payment.payload ?? {};
    const nonce = payload.nonce ?? "(none)";
    if (this.settled.has(nonce)) {
      return this.evidence(false, { code: "nonce-replay", message: `nonce ${nonce} already settled` });
    }
    if (payload.to !== requirement.payTo || payload.value !== requirement.maxAmountRequired) {
      return this.evidence(false, { code: "payment-mismatch", message: "payment does not match requirement" });
    }
    this.settled.add(nonce);
    return {
      scheme: "exactInEvm",
      network: requirement.network ?? 8453,
      payload: { success: true, transactionHash: `mock-tx-${nonce.slice(0, 8)}` },
      facilitatorId: this.facilitatorId,
      settledAt: this.clock.now().toISOString(),
    };
  }

  private evidence(success: boolean, error?: { code: string; message: string }): X402Settlement {
    return {
      scheme: "exactInEvm",
      network: 8453,
      payload: success
        ? { success: true, transactionHash: "mock-tx" }
        : { success: false, error: error ?? { code: "unknown", message: "settlement failed" } },
      facilitatorId: this.facilitatorId,
      settledAt: this.clock.now().toISOString(),
    };
  }
}
