import { EvmAddress } from "@sentinel-mesh/contracts";
import { sha256Hex } from "./mock-fixtures.js";
import type { MockSignerLike, SignedMessage } from "./types.js";

/**
 * MockSigner: a deterministic, cryptographically MEANINGLESS stand-in for a
 * transaction signer. Its purpose is to let the platform's guarded-trading
 * data flow be exercised end to end without any possibility of real signing.
 *
 * Explicit non-goals in phase 0:
 *  - No private keys are accepted, generated, or stored.
 *  - No cryptographic signature is produced; "signature" strings are hashes
 *    prefixed "mock-sig-" so they can never be mistaken for real ones.
 *  - No network interaction of any kind.
 */
export class MockSigner implements MockSignerLike {
  readonly mode = "mock" as const;

  constructor(readonly address: string = `0x${"0".repeat(40)}`) {
    const parsed = EvmAddress.safeParse(address);
    if (!parsed.success) {
      throw new Error("MockSigner address must be a valid EVM address");
    }
  }

  async signMessage(message: string): Promise<SignedMessage> {
    return {
      signature: `mock-sig-${sha256Hex(message)}`,
      signerAddress: this.address,
      mode: "mock",
    };
  }
}
