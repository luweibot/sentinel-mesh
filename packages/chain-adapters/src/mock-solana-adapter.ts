import { SolanaAddress } from "@sentinel-mesh/contracts";
import type { SolanaChainAdapter, TokenMetadata, WalletActivity } from "./types.js";
import { AdapterValidationError, MOCK_OBSERVED_AT } from "./mock-evm-adapter.js";
import {
  deriveAmountRaw,
  deriveBase58Hash,
  deriveTokenName,
  deriveTokenSymbol,
} from "./mock-fixtures.js";

/** Fixed slot so dev data is reproducible. */
export const MOCK_SOLANA_SLOT = 285_000_000;

/** Fixture program-derived addresses used by the mock Solana adapter. */
export const MOCK_SOLANA_TOKEN_A = "MckSo1anaTkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1";
export const MOCK_SOLANA_TOKEN_B = "MckSo1anaTkBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB2";

/**
 * Deterministic in-process Solana adapter. Same input, same output, no
 * network, no state.
 */
export class MockSolanaAdapter implements SolanaChainAdapter {
  readonly chain = "solana" as const;
  readonly mode = "mock" as const;

  private assertAddress(address: string): void {
    const parsed = SolanaAddress.safeParse(address);
    if (!parsed.success) {
      throw new AdapterValidationError(`'${address}' is not a valid Solana address`);
    }
  }

  async getTokenMetadata(address: string): Promise<TokenMetadata> {
    this.assertAddress(address);
    return {
      chain: this.chain,
      address,
      symbol: deriveTokenSymbol(address),
      name: deriveTokenName(address),
      decimals: 9,
    };
  }

  async getWalletActivity(address: string): Promise<WalletActivity> {
    this.assertAddress(address);
    return {
      chain: this.chain,
      walletAddress: address,
      observedAt: MOCK_OBSERVED_AT,
      movements: [
        {
          direction: "out",
          token: await this.getTokenMetadata(MOCK_SOLANA_TOKEN_A),
          amountRaw: deriveAmountRaw(`sol-out:${address}`),
          txHash: deriveBase58Hash(`sol-out:${address}`),
          slot: MOCK_SOLANA_SLOT - 150,
        },
        {
          direction: "in",
          token: await this.getTokenMetadata(MOCK_SOLANA_TOKEN_B),
          amountRaw: deriveAmountRaw(`sol-in:${address}`),
          txHash: deriveBase58Hash(`sol-in:${address}`),
          slot: MOCK_SOLANA_SLOT - 42,
        },
      ],
    };
  }

  async getBlockHeight(): Promise<number> {
    return MOCK_SOLANA_SLOT;
  }
}
