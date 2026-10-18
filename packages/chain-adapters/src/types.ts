import type { ChainId } from "@sentinel-mesh/contracts";

/**
 * Chain adapter interfaces.
 *
 * Phase 0 scope: read-only observation of chain state plus SIMULATED trade
 * artifacts. Adapters never submit transactions. The `mode` field makes the
 * adapter's capability explicit at the type level:
 *   - "mock": deterministic in-process fixtures (the only mode enabled in phase 0)
 *   - "readonly": live RPC reads (interface defined; a future phase will provide
 *     implementations behind feature flags)
 *
 * There is deliberately NO interface for broadcasting transactions in this
 * package. Adding one is a phase decision, not a code detail.
 */

export interface TokenMetadata {
  chain: ChainId;
  address: string;
  symbol: string;
  name: string;
  decimals: number;
}

export interface TokenMovement {
  direction: "in" | "out";
  token: TokenMetadata;
  /** Whole-string amount in the token's base unit (no floating point). */
  amountRaw: string;
  txHash: string;
  blockNumber?: number;
  slot?: number;
}

export interface WalletActivity {
  chain: ChainId;
  walletAddress: string;
  observedAt: string;
  movements: TokenMovement[];
}

/** Common read surface for all chains. */
export interface ReadOnlyChainAdapter {
  readonly chain: ChainId;
  readonly mode: "mock" | "readonly";
  getTokenMetadata(address: string): Promise<TokenMetadata>;
  getWalletActivity(address: string): Promise<WalletActivity>;
  getBlockHeight(): Promise<number>;
}

/** EVM-specific adapter surface (Base, Ethereum). */
export interface EvmChainAdapter extends ReadOnlyChainAdapter {
  readonly chain: "base" | "ethereum";
  getWalletActivity(address: string, options?: { fromBlock?: number; toBlock?: number }): Promise<WalletActivity>;
}

/** Solana-specific adapter surface. */
export interface SolanaChainAdapter extends ReadOnlyChainAdapter {
  readonly chain: "solana";
  getWalletActivity(address: string, options?: { beforeSlot?: number }): Promise<WalletActivity>;
}

// ---------------------------------------------------------------------------
// Signer (mock only in phase 0)
// ---------------------------------------------------------------------------

export interface SignedMessage {
  /** Prefixed "mock-sig-". Never a cryptographic signature. */
  signature: string;
  signerAddress: string;
  mode: "mock";
}

/**
 * Signer interface. Phase 0 has exactly one implementation: MockSigner, which
 * is deterministic and cryptographically meaningless. A future "live" signer
 * is intentionally NOT an interface here yet; introducing real signing is an
 * architecture decision with its own ADR, review and secret-management story.
 */
export interface MockSignerLike {
  readonly address: string;
  readonly mode: "mock";
  signMessage(message: string): Promise<SignedMessage>;
}

// ---------------------------------------------------------------------------
// Simulated trade artifacts
// ---------------------------------------------------------------------------

export interface TradeSimulationRequest {
  chain: ChainId;
  tokenIn: string;
  tokenOut: string;
  amountInRaw: string;
  slippageBps: number;
}

export interface SimulatedTrade {
  simulatedTxHash: string;
  simulatedAt: string;
  /** Human-readable guarantee shown in API responses and logs. */
  note: string;
}

/**
 * Produces a simulated trade artifact for an allowed signal. Implementations
 * MUST NOT contact any network and MUST NOT produce anything broadcastable.
 */
export interface TradeSimulator {
  simulate(request: TradeSimulationRequest): Promise<SimulatedTrade>;
}
