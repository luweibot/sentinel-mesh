/**
 * Pure gas top-up planning: how much received USDC revenue should be
 * converted into ETH (Base) and SOL (Solana) gas — and NO more than the
 * deficits require ("just needed amount gas costs").
 *
 * Unit conventions (never assumed onchain, but pinned here for math):
 *   USDC raw = 6 decimals, ETH wei = 18, SOL lamports = 9.
 */

export interface GasTopUpTargets {
  ethTargetWei: bigint;
  solTargetLamports: bigint;
}

export interface GasTopUpConfig extends GasTopUpTargets {
  /** USDC raw kept liquid for operations — never swapped for gas. */
  usdcReserveRaw: bigint;
  /** ETH: don't bother swapping below this USDC value (gas would eat it). */
  ethTopUpMinUsdcRaw: bigint;
  /** SOL: Mayan's minimum bridged output (~5 USDC) — fail below it. */
  mayanMinUsdcRaw: bigint;
  /** ETH gas buffer above the pure deficit (covers the swap tx itself). */
  ethBufferBps: number;
  /** USDC raw per 1 ETH, from a live quote (Aero getAmountsOut). */
  usdcPerEthRaw: bigint;
  /** USDC raw per 1 SOL, from a live quote source. null = SOL leg skipped. */
  usdcPerSolRaw: bigint | null;
}

export interface GasTopUpBalances {
  ethBalanceWei: bigint;
  solBalanceLamports: bigint;
  usdcBalanceRaw: bigint;
}

export type GasTopUpAction =
  | { kind: "swapUsdcToEthOnBase"; usdcRaw: bigint }
  | { kind: "bridgeUsdcToSolanaForGas"; usdcRaw: bigint; gasDropSol: number };

export interface GasTopUpPlan {
  actions: GasTopUpAction[];
  notes: string[];
}

export const MAX_MAYAN_GAS_DROP_SOL = 0.2;

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

/** Plan ONLY deficit-funded conversions. Pure, deterministic, fail-closed. */
export function computeGasTopUpPlan(
  cfg: GasTopUpConfig,
  balances: GasTopUpBalances,
): GasTopUpPlan {
  const notes: string[] = [];
  const actions: GasTopUpAction[] = [];

  if (cfg.ethTargetWei <= 0n) throw new Error("ethTargetWei must be positive");
  if (cfg.solTargetLamports <= 0n) throw new Error("solTargetLamports must be positive");
  if (cfg.usdcReserveRaw < 0n) throw new Error("usdcReserveRaw must be >= 0");
  if (cfg.ethBufferBps < 0 || cfg.ethBufferBps > 1000) throw new Error("ethBufferBps outside 0..1000");

  const usdcAvailable = balances.usdcBalanceRaw - cfg.usdcReserveRaw;

  // ---- ETH leg (Base): fund the deficit only ----
  let remaining = usdcAvailable;
  if (balances.ethBalanceWei >= cfg.ethTargetWei) {
    notes.push(`ETH gas at target (${balances.ethBalanceWei}/${cfg.ethTargetWei} wei) — no swap`);
  } else {
    const ethDeficitWei = cfg.ethTargetWei - balances.ethBalanceWei;
    const usdcNeeded = ceilDiv(
      (ethDeficitWei * cfg.usdcPerEthRaw * (10_000n + BigInt(cfg.ethBufferBps))) / 10_000n,
      10n ** 18n,
    );
    if (usdcNeeded <= cfg.ethTopUpMinUsdcRaw) {
      notes.push(`ETH deficit tiny (${usdcNeeded} USDC raw) — below swap minimum, skipping`);
    } else if (remaining < cfg.ethTopUpMinUsdcRaw) {
      notes.push(`USDC available (${remaining} raw) below ETH top-up minimum — accumulating revenue first`);
    } else {
      const spend = usdcNeeded < remaining ? usdcNeeded : remaining;
      actions.push({ kind: "swapUsdcToEthOnBase", usdcRaw: spend });
      remaining -= spend;
      notes.push(`swap ${spend} USDC raw → ETH gas (deficit ${ethDeficitWei} wei)`);
    }
  }

  // ---- SOL leg (Solana via bridge): fund the deficit only ----
  if (balances.solBalanceLamports >= cfg.solTargetLamports) {
    notes.push(`SOL gas at target (${balances.solBalanceLamports}/${cfg.solTargetLamports} lamports) — no bridge`);
  } else if (cfg.usdcPerSolRaw === null || cfg.usdcPerSolRaw <= 0n) {
    notes.push("SOL leg needs a usdcPerSol quote — not configured, skipping");
  } else {
    const solDeficitLamports = cfg.solTargetLamports - balances.solBalanceLamports;
    const usdcNeeded = ceilDiv(solDeficitLamports * cfg.usdcPerSolRaw, 10n ** 9n);
    const bridgeAmount = usdcNeeded > cfg.mayanMinUsdcRaw ? usdcNeeded : cfg.mayanMinUsdcRaw;
    if (remaining < cfg.mayanMinUsdcRaw) {
      notes.push(
        `USDC available (${remaining} raw) below bridge minimum (${cfg.mayanMinUsdcRaw}) — accumulating revenue first`,
      );
    } else {
      const spend = bridgeAmount > remaining ? remaining : bridgeAmount;
      // deficit lamports fit comfortably in a JS number at treasury scales
      const gasDropSol = Math.min(Number(solDeficitLamports) / 1e9, MAX_MAYAN_GAS_DROP_SOL);
      actions.push({ kind: "bridgeUsdcToSolanaForGas", usdcRaw: spend, gasDropSol });
      remaining -= spend;
      notes.push(`bridge ${spend} USDC raw → USDC on Solana + ${gasDropSol} SOL gas drop (deficit ${solDeficitLamports} lamports)`);
    }
  }

  return { actions, notes };
}
