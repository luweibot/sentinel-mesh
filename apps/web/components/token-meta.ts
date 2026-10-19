/**
 * Sentinel Mesh token ($MESH) public metadata.
 *
 * Launched on Base via the Bankr launchpad (Doppler). Update TOKEN_ADDRESS
 * here after launch; both the Ecosystem overview and the token docs page
 * read from this module.
 */

export const TOKEN = {
  name: "Sentinel Mesh",
  symbol: "MESH",
  chain: "Base",
  chainId: 8453,
  /** Contract address — published at launch. */
  address: "" as string,
  /** Uniswap V4 pool (MESH/WETH) address — published at launch. */
  poolAddress: "" as string,
  logoUrl:
    "https://media.base44.com/images/public/6a6e415774ed6f04724d8024/6e2175eb3_generated_image.png",
  website: "https://luweibot.github.io/sentinel-mesh",
  launchpad: "Bankr (https://bankr.bot)",
  standard: "ERC-20, fixed supply, non-mintable",
  supply: "100,000,000,000 (100 billion, fixed)",
  allocation: [
    { label: "Liquidity pool (Uniswap V4)", share: "85%", detail: "Seeded at launch — immediately tradeable" },
    { label: "Creator vesting", share: "15%", detail: "1-year schedule, 30-day cliff, funds project development" },
  ],
  /** Total swap fee per trade on the MESH/WETH pool (Doppler hook schedule). */
  feeSchedule: [
    { recipient: "Creator (Sentinel Mesh project)", share: "0.665%", detail: "95% of the 0.7% pool fee — claimable anytime, funds compute & development" },
    { recipient: "LP fee (auto-compounding)", share: "0.285%", detail: "Compounds as permanently locked liquidity in the MESH/WETH pool" },
    { recipient: "Bankr protocol", share: "0.475%", detail: "Launchpad infrastructure" },
    { recipient: "BNKR buyback", share: "0.2375%", detail: "Buybacks + protocol-owned BNKR liquidity" },
    { recipient: "Doppler protocol", share: "~0.0875%", detail: "Launch infrastructure" },
  ],
  utility: [
    "Pay trading fees on the upcoming Sentinex terminal at a discount",
    "Accepted asset for x402 machine payments on the Sentinel Mesh API",
    "Instant cashback asset for Base trades (BasedBot-style, 30% of fees back)",
    "Roadmap signal votes on which markets and features ship next",
  ],
} as const;
