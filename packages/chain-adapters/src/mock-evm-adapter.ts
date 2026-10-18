import { EvmAddress } from "@sentinel-mesh/contracts";
import type { EvmChainAdapter, TokenMetadata, WalletActivity } from "./types.js";
import {
  deriveAmountRaw,
  deriveEvmTxHash,
  deriveTokenName,
  deriveTokenSymbol,
} from "./mock-fixtures.js";

export class AdapterValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdapterValidationError";
  }
}

/** Fixed block height so dev data is reproducible. */
export const MOCK_EVM_BLOCK_HEIGHT = 21_000_000;

/** Fixed observation time so dev data is reproducible. */
export const MOCK_OBSERVED_AT = "2026-01-01T00:00:00.000Z";

/**
 * Deterministic in-process EVM adapter. Implements EvmChainAdapter for the
 * Base chain. Same input, same output, no network, no state.
 */
export class MockEvmAdapter implements EvmChainAdapter {
  readonly chain = "base" as const;
  readonly mode = "mock" as const;

  private assertAddress(address: string): void {
    const parsed = EvmAddress.safeParse(address);
    if (!parsed.success) {
      throw new AdapterValidationError(`'${address}' is not a valid EVM address`);
    }
  }

  async getTokenMetadata(address: string): Promise<TokenMetadata> {
    this.assertAddress(address);
    return {
      chain: this.chain,
      address,
      symbol: deriveTokenSymbol(address),
      name: deriveTokenName(address),
      decimals: 18,
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
          token: await this.getTokenMetadata(address),
          amountRaw: deriveAmountRaw(`out:${address}`),
          txHash: deriveEvmTxHash(`out:${address}`),
          blockNumber: MOCK_EVM_BLOCK_HEIGHT - 12,
        },
        {
          direction: "in",
          token: await this.getTokenMetadata(`0x${"1".repeat(40)}`),
          amountRaw: deriveAmountRaw(`in:${address}`),
          txHash: deriveEvmTxHash(`in:${address}`),
          blockNumber: MOCK_EVM_BLOCK_HEIGHT - 7,
        },
      ],
    };
  }

  async getBlockHeight(): Promise<number> {
    return MOCK_EVM_BLOCK_HEIGHT;
  }
}
