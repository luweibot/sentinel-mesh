import { privateKeyToAccount } from "viem/accounts";

import type { IsolatedSignerPort } from "./signing.js";

/**
 * LIVE signer for the EVM execution path. Signs the canonical execution
 * payload with a real secp256k1 key (ECDSA over keccak) via viem.
 *
 * Security shape (docs/EXECUTION.md prerequisites):
 *  - The raw private key is handed to the constructor, validated once, and
 *    retained only inside the viem account handle. It is never stored on
 *    the instance as a plain field, never logged, never exported.
 *  - The signer produces signatures ONLY. Broadcasting is a separate,
 *    explicitly-gated step; nothing in this module can send a transaction.
 *  - The key must be injected from the orchestrator runtime environment
 *    (EVM_PRIVATE_KEY) at boot — never from git, config files, or the API
 *    surface.
 */
export interface LiveEvmSignerDeps {
  /** Raw secp256k1 key as 0x + 64 hex chars. */
  privateKey: `0x${string}`;
  /** Stable identifier for receipts/audit. Defaults to live-evm-<address prefix>. */
  signerId?: string;
}

export class LiveEvmSigner implements IsolatedSignerPort {
  readonly signerId: string;
  readonly mode = "live" as const;
  /** Public address of the signing key — safe to expose. */
  readonly address: `0x${string}`;
  private readonly sign: (message: string) => Promise<`0x${string}`>;

  constructor(deps: LiveEvmSignerDeps) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(deps.privateKey)) {
      throw new Error("LiveEvmSigner: privateKey must be 0x + 64 hex characters");
    }
    const account = privateKeyToAccount(deps.privateKey);
    this.address = account.address;
    this.signerId = deps.signerId ?? `live-evm-${account.address.slice(0, 12)}`;
    this.sign = async (message: string) => account.signMessage({ message });
  }

  async signExecution(
    canonical: string,
  ): Promise<{ signature: string; signerId: string; mode: "live" }> {
    if (canonical.length === 0) {
      throw new Error("LiveEvmSigner: canonical execution payload is empty");
    }
    const signature = await this.sign(canonical);
    return { signature, signerId: this.signerId, mode: "live" };
  }
}
