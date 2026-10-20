import type { ChainId, TradeIntent } from "@sentinel-mesh/contracts";
import { MockSigner } from "@sentinel-mesh/chain-adapters";
import { createHash } from "node:crypto";

/**
 * ISOLATED SIGNER PORT.
 *
 * The signer is deliberately a narrow, outbound-only port that ONLY the
 * guarded executor obtains. Strategy agents get an ExecutionPort
 * (submitIntent) and can never reach this interface, a key store, or any
 * credential. There is no "broadcast" method on this port in this phase.
 *
 * The default implementation is the deterministic, cryptographically
 * meaningless MockSigner: signatures are sha256 hashes prefixed
 * "mock-sig-" and cannot be mistaken for real signatures. No private keys
 * exist anywhere in this repository (phase invariant; enforced by tests
 * grepping the codebase in CI).
 */

export interface IsolatedSignerPort {
  /** Identification only; carries no capability. */
  readonly signerId: string;
  readonly mode: "mock" | "live";
  /**
   * Produce a signature over the canonical execution payload. Mock mode is
   * deterministic and cryptographically meaningless. Live mode signs with a
   * real secp256k1 key held inside the signer module (see live-signing.ts);
   * in a hardened phase this port would talk to an isolated KMS/HSM signer
   * instead — the port shape stays the same so agents remain unable to
   * reach the key.
   */
  signExecution(canonical: string, context?: { chain: ChainId }): Promise<{ signature: string; signerId: string; mode: "mock" | "live" }>;
}

export class DeterministicMockSigner implements IsolatedSignerPort {
  readonly signerId: string;
  readonly mode = "mock" as const;
  private readonly delegate: MockSigner;

  constructor(signerId = "mock-signer-1") {
    this.signerId = signerId;
    this.delegate = new MockSigner();
  }

  async signExecution(canonical: string, _context?: { chain: ChainId }): Promise<{ signature: string; signerId: string; mode: "mock" }> {
    const signed = await this.delegate.signMessage(canonical);
    return { signature: signed.signature, signerId: this.signerId, mode: "mock" };
  }
}

// ---------------------------------------------------------------------------
// Transaction simulation port
// ---------------------------------------------------------------------------

/**
 * Transaction simulation port. The executor treats the simulator as the
 * source of truth for outcomes and fails CLOSED on anything that is not a
 * clean success: "failed" and "uncertain" (RPC doubt, timeout, ambiguity)
 * both reject the intent.
 */
export interface TransactionSimulationPort {
  simulate(intent: TradeIntent): Promise<SimulationResult>;
}

export interface SimulationResult {
  status: "succeeded" | "failed" | "uncertain";
  /** Simulated base-unit output for a successful swap. */
  simulatedOutRaw: string;
  /** Simulated total fee in USD cents. */
  feeUsdCents: number;
  /** Simulated price impact in basis points. */
  priceImpactBps: number;
  detail: string;
}

/**
 * Deterministic paper simulator: outputs are a pure function of the intent
 * (sha256-derived), so tests are hermetic. Test harnesses can override the
 * outcome for a specific intentId to drive adversarial scenarios
 * (simulation-failed, simulation-uncertain).
 */
export class DeterministicPaperSimulator implements TransactionSimulationPort {
  private readonly overrides = new Map<string, { status: "failed" | "uncertain"; detail: string }>();

  /** Test/ops hook: force a non-success outcome for one intent. */
  overrideOutcome(intentId: string, outcome: { status: "failed" | "uncertain"; detail: string }): void {
    this.overrides.set(intentId, outcome);
  }

  async simulate(intent: TradeIntent): Promise<SimulationResult> {
    const override = this.overrides.get(intent.intentId);
    if (override) {
      return {
        status: override.status,
        simulatedOutRaw: "0",
        feeUsdCents: 0,
        priceImpactBps: 0,
        detail: override.detail,
      };
    }
    const seed = createHash("sha256")
      .update(`${intent.chain}:${intent.tokenIn.toLowerCase()}:${intent.tokenOut.toLowerCase()}:${intent.amountInRaw}`)
      .digest("hex");
    // Mock AMM: out = amountIn * (0.95..0.999) determined by the seed.
    const ratioNumerator = 950 + (parseInt(seed.slice(0, 8), 16) % 50);
    const amountIn = BigInt(intent.amountInRaw);
    const simulatedOutRaw = (amountIn * BigInt(ratioNumerator)) / 1000n;
    const feeUsdCents = 1 + (parseInt(seed.slice(8, 12), 16) % 40); // 1..40 cents
    const priceImpactBps = 1 + (parseInt(seed.slice(12, 16), 16) % 60); // 1..60 bps
    return {
      status: "succeeded",
      simulatedOutRaw: simulatedOutRaw.toString(),
      feeUsdCents,
      priceImpactBps,
      detail: `deterministic paper simulation for ${intent.chain}`,
    };
  }
}
