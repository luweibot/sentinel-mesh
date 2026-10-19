import { createPublicClient, createWalletClient, http, erc20Abi } from "viem";
import type { HttpTransport, PrivateKeyAccount, PublicClient, WalletClient } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { LiveAeroBroadcaster, AERO_POOL_FACTORY_BASE, BASE_WETH } from "./live-evm-broadcaster.js";

/**
 * Single place where viem clients for Base mainnet are constructed, so
 * consumers never instantiate (or duplicate) viem types themselves.
 * All exported shapes carry explicit annotations: viem client types are
 * enormous, and inferred ones break declaration emit (TS2742/TS7056).
 */

export interface BaseViemClients {
  account: PrivateKeyAccount;
  publicClient: PublicClient<HttpTransport, typeof base>;
  walletClient: WalletClient<HttpTransport, typeof base, PrivateKeyAccount>;
}

export function createBaseViemClients(opts: { rpcUrl: string; privateKey: `0x${string}` }): BaseViemClients {
  const account = privateKeyToAccount(opts.privateKey);
  const transport = http(opts.rpcUrl);
  return {
    account,
    publicClient: createPublicClient({ chain: base, transport }),
    walletClient: createWalletClient({ account, chain: base, transport }),
  };
}

/** Structural port over plain types only — no viem types in the surface. */
export interface LiveAeroEthLegPort {
  swapUsdcToEth(params: { amountInRaw: bigint; slippageBps: number }): Promise<{
    txHash: `0x${string}`;
    status: "success" | "reverted";
    gasUsed: bigint;
    minOutRaw: bigint;
  }>;
  getEthBalanceWei(address: `0x${string}`): Promise<bigint>;
  getUsdcBalanceRaw(address: `0x${string}`): Promise<bigint>;
  getUsdcPerEthRaw(): Promise<bigint>;
}

export function createLiveAeroEthLeg(opts: {
  rpcUrl: string;
  privateKey: `0x${string}`;
  usdcAddress: `0x${string}`;
  recipient: `0x${string}`;
}): { broadcaster: LiveAeroBroadcaster; port: LiveAeroEthLegPort } {
  const { publicClient, walletClient } = createBaseViemClients(opts);
  // The concrete generic parameters (HttpTransport, typeof base) are
  // runtime-identical to the broadcaster's generic PublicClient /
  // WalletClient deps — proven by the 2026-10-19 live trades — but TS
  // treats the narrowed generics as a different type identity. A
  // types-only cast bridges the variance; nothing runtime changes.
  const broadcaster = new LiveAeroBroadcaster({
    publicClient: publicClient as PublicClient,
    walletClient: walletClient as WalletClient,
    recipient: opts.recipient,
  });
  const usdc = opts.usdcAddress;
  return {
    broadcaster,
    port: {
      swapUsdcToEth: (params) => broadcaster.swapExactTokensForETH({ tokenIn: usdc, ...params }),
      getEthBalanceWei: (address) => publicClient.getBalance({ address }),
      getUsdcBalanceRaw: async (address) => {
        // Load-balanced RPC nodes lag a few seconds behind receipts:
        // bounded retry so a just-settled payment is not read as 0.
        for (let attempt = 0; attempt < 3; attempt++) {
          const balance = (await publicClient.readContract({
            address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [address],
          })) as bigint;
          if (balance > 0n) return balance;
          await new Promise((r) => setTimeout(r, 5_000));
        }
        return 0n;
      },
      getUsdcPerEthRaw: () =>
        broadcaster.quote(10n ** 18n, {
          from: BASE_WETH, to: usdc, stable: false, factory: AERO_POOL_FACTORY_BASE,
        }),
    },
  };
}
