import { z } from "zod";
import { ChainId } from "@sentinel-mesh/contracts";
import type { MockSignerLike, SimulatedTrade, TradeSimulator, TradeSimulationRequest } from "./types.js";
import { sha256Hex } from "./mock-fixtures.js";

export const TradeSimulationRequestSchema = z
  .object({
    chain: ChainId,
    tokenIn: z.string().min(1),
    tokenOut: z.string().min(1),
    amountInRaw: z.string().regex(/^\d+$/, "must be a whole-number string in base units"),
    slippageBps: z.number().int().min(0).max(10_000),
  })
  .strict()
  .refine((request) => request.tokenIn !== request.tokenOut, {
    message: "tokenIn and tokenOut must differ",
    path: ["tokenOut"],
  });

/**
 * Produces simulated trade artifacts. The "simulation" is a signed canonical
 * description of the requested trade, stamped with a deterministic simulated
 * hash. Nothing is computed, broadcast, or signed cryptographically. The
 * artifact exists so downstream consumers (UI, reports) have a stable object
 * shape for a future real execution phase to replace.
 */
export class MockTradeSimulator implements TradeSimulator {
  constructor(private readonly signer: MockSignerLike) {}

  async simulate(request: TradeSimulationRequest): Promise<SimulatedTrade> {
    const parsed = TradeSimulationRequestSchema.parse(request);
    const canonical = JSON.stringify({
      chain: parsed.chain,
      tokenIn: parsed.tokenIn,
      tokenOut: parsed.tokenOut,
      amountInRaw: parsed.amountInRaw,
      slippageBps: parsed.slippageBps,
    });
    const signed = await this.signer.signMessage(canonical);
    return {
      simulatedTxHash: `sim-${sha256Hex(canonical).slice(0, 40)}`,
      simulatedAt: new Date().toISOString(),
      note: `Simulated only via ${signed.signerAddress}. No transaction was signed with real keys, computed, or broadcast.`,
    };
  }
}
