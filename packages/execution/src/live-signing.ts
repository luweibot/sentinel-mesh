import { privateKeyToAccount } from "viem/accounts";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
import type { ChainId } from "@sentinel-mesh/contracts";
import type { IsolatedSignerPort } from "./signing.js";

/**
 * LIVE signers behind the existing IsolatedSignerPort (checklist item:
 * "real EVM + Solana signers behind the existing signer port").
 *
 * The port shape is unchanged: signExecution(canonical) signs the
 * canonical execution payload for the audit trail. Agents still see only
 * the ExecutionPort and can never reach a key; the key material lives
 * in these modules, constructed ONLY from the orchestrator runtime env
 * (EVM_PRIVATE_KEY / SOLANA_PRIVATE_KEY) in live mode.
 *
 * The actual transaction signatures for live swaps are produced inside
 * the live trade executors (viem walletClient / Solana Keypair); these
 * signers produce the canonical-payload signature that the receipt's
 * audit trail is derived from.
 */

export class LiveEvmSigner implements IsolatedSignerPort {
  readonly mode = "live" as const;
  readonly signerId: string;
  private readonly account: ReturnType<typeof privateKeyToAccount>;

  constructor({ privateKey, signerId = "live-evm-signer-1" }: { privateKey: `0x${string}`; signerId?: string }) {
    this.account = privateKeyToAccount(privateKey);
    this.signerId = signerId;
  }

  /** Public address of the live EVM key (identification only). */
  get address(): string {
    return this.account.address;
  }

  async signExecution(canonical: string, _context?: { chain: ChainId }): Promise<{ signature: string; signerId: string; mode: "live" }> {
    if (!canonical || !canonical.trim()) throw new Error("cannot sign an empty canonical payload");
    const signature = await this.account.signMessage({ message: canonical });
    return { signature, signerId: this.signerId, mode: "live" };
  }
}

export class LiveSolanaSigner implements IsolatedSignerPort {
  readonly mode = "live" as const;
  readonly signerId: string;
  private readonly keypair: Keypair;

  constructor({ base58SecretKey, signerId = "live-solana-signer-1" }: { base58SecretKey: string; signerId?: string }) {
    const secret = bs58.decode(base58SecretKey);
    if (secret.length !== 64) {
      throw new Error(`solana secret key decoded to ${secret.length} bytes (expected 64); refusing to sign`);
    }
    this.keypair = Keypair.fromSecretKey(secret);
    this.signerId = signerId;
  }

  /** Public key of the live Solana wallet (identification only). */
  get address(): string {
    return this.keypair.publicKey.toBase58();
  }

  async signExecution(canonical: string, _context?: { chain: ChainId }): Promise<{ signature: string; signerId: string; mode: "live" }> {
    if (!canonical || !canonical.trim()) throw new Error("cannot sign an empty canonical payload");
    // ed25519 detached signature over the canonical payload (this
    // web3.js Keypair exposes no signMessage; sign via nacl).
    const signature = bs58.encode(nacl.sign.detached(Buffer.from(canonical, "utf8"), this.keypair.secretKey));
    return { signature, signerId: this.signerId, mode: "live" };
  }
}

/**
 * Chain-dispatching live signer: EVM intents are signed with the EVM key,
 * Solana intents with the Solana key. A chain with no wired key fails
 * closed. The port shape stays identical — agents still never see a key.
 */
export class DispatchingLiveSigner implements IsolatedSignerPort {
  readonly mode = "live" as const;
  readonly signerId = "live-dispatching-signer-1";

  constructor(
    private readonly evm: LiveEvmSigner | undefined,
    private readonly solana: LiveSolanaSigner | undefined,
  ) {}

  async signExecution(canonical: string, context?: { chain: ChainId }): Promise<{ signature: string; signerId: string; mode: "live" }> {
    const chain = context?.chain;
    if (chain === "solana" || chain === "solana-mainnet" || chain === "solana-devnet") {
      if (!this.solana) throw new Error("no live solana signer is wired; failing closed");
      return await this.solana.signExecution(canonical, context);
    }
    if (chain === "base" || chain === "ethereum") {
      if (!this.evm) throw new Error(`no live evm signer is wired for chain '${chain}'; failing closed`);
      return await this.evm.signExecution(canonical, context);
    }
    throw new Error(`live signing is not wired for chain '${String(chain)}'; failing closed`);
  }
}
