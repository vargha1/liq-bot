import { ethers } from "ethers";
import { logger } from "./logger";
import { CONFIG, RESERVES } from "./config";
import { AaveOracle } from "./oracle";
import { uniswapSwap } from "./uniswap";
import type { BorrowerPosition, LiquidationOpportunity, AssetPosition } from "./types";

// Aave V3 close factor rules
const CLOSE_FACTOR_HF_THRESHOLD = 95n * 10n ** 16n;  // 0.95
const DEFAULT_CLOSE_FACTOR      = 5000n;               // 50% in bps
const MAX_CLOSE_FACTOR          = 10000n;              // 100% in bps

// ── Fixed gas constants ────────────────────────────────────────────────────────
// PERF: Avoids an estimateGas RPC round-trip on the hot path.
// These are measured values from real Arbitrum liquidation txs + 20% safety buffer.
//   BASE_GAS_UNITS: flashloan setup + liquidationCall alone (~220k observed on Arbitrum)
//   PER_HOP_GAS:    Uniswap V3 gas per pool hop (~100k per hop observed on Arbitrum)
//   SAME_ASSET_GAS: collateral == debt, no swap needed (~220k)
// NOTE: Arbitrum L2 gas units are comparable to L1 but gas PRICE is 0.01–0.1 gwei,
// making actual ETH cost ~100–1000x cheaper than mainnet for the same gas units.
// The executor uses these same constants and skips estimateGas entirely.
export const BASE_GAS_UNITS  = 265_000n;
export const PER_HOP_GAS     = 120_000n;
export const SAME_ASSET_GAS  = 265_000n;

export function estimateGasUnits(hops: number): bigint {
  if (hops === 0) return SAME_ASSET_GAS;
  return BASE_GAS_UNITS + PER_HOP_GAS * BigInt(hops);
}

// Count hops from an encoded Uniswap V3 path.
// Path: 20-byte token + (3-byte fee + 20-byte token) * N  =>  hops = (bytes-20)/23
function countHopsFromPath(swapPath: string): number {
  if (!swapPath || swapPath === "0x") return 0;
  const bytes = (swapPath.length - 2) / 2;
  return Math.max(1, Math.round((bytes - 20) / 23));
}

// Pre-screen: skip positions with HF >= 0.9995.
const HF_EVAL_THRESHOLD = 9995n * 10n ** 14n; // 0.9995

export class Evaluator {
  constructor(
    private oracle:       AaveOracle,
    private _getProvider: () => ethers.Provider,
  ) {}

  // evaluate() now does everything in one shot:
  //   1. Oracle prices (cycle-level prefetch, zero extra RPC calls)
  //   2. Picks the best collateral/debt pair by estimated profit
  //   3. Runs the Uniswap V3 quote for that pair (MOVED FROM executor.ts)
  //   4. Re-checks profitability with real route gas cost
  //   5. Returns a fully-quoted LiquidationOpportunity — executor submits immediately
  //
  // This removes the estimateGas + uniswapSwap round-trips from the executor
  // hot path, cutting ~2 RPC calls (~200-400ms) between "opportunity found"
  // and "tx submitted".
  async evaluate(
    position:     BorrowerPosition,
    collaterals:  AssetPosition[],
    debts:        AssetPosition[],
    gasPrice:     bigint,
    priceMap?:    Map<string, bigint>,
    ethPriceUsd?: number,
  ): Promise<LiquidationOpportunity | null | "EVICT"> {
    if (!collaterals.length || !debts.length) return null;

    // ── Bad-debt check ────────────────────────────────────────────────────────
    const resolvedPrices = priceMap ?? await this.oracle.getPrices(
      [...collaterals.map(c => c.address), ...debts.map(d => d.address)]
    );

    const totalColUsd8 = collaterals.reduce((s, c) => {
      const price = resolvedPrices.get(c.address.toLowerCase()) ?? 0n;
      return s + (price * c.balance) / BigInt(10 ** c.decimals);
    }, 0n);
    const MIN_COL_USD8 = 100_000_000n; // $1
    if (totalColUsd8 < MIN_COL_USD8) {
      logger.warn(`  eval EVICT ${position.address.slice(0,10)}: collateral=$${(Number(totalColUsd8)/1e8).toFixed(4)} below $1 minimum — bad debt`);
      return "EVICT";
    }

    if (position.healthFactor >= HF_EVAL_THRESHOLD) {
      logger.debug(`  ${position.address.slice(0,10)}… HF=${position.healthFactorNum.toFixed(4)} >= 0.9995 — skip`);
      return null;
    }

    // ── Prices ────────────────────────────────────────────────────────────────
    const prices = resolvedPrices;
    for (const c of collaterals) {
      const p = prices.get(c.address.toLowerCase()) ?? 0n;
      c.balanceUsd = this.toUsd(p, c.balance, c.decimals);
    }
    for (const d of debts) {
      const p = prices.get(d.address.toLowerCase()) ?? 0n;
      d.balanceUsd = this.toUsd(p, d.balance, d.decimals);
    }

    const closeFactor = position.healthFactor <= CLOSE_FACTOR_HF_THRESHOLD
      ? MAX_CLOSE_FACTOR : DEFAULT_CLOSE_FACTOR;

    const ethPrice = ethPriceUsd ?? await this.getEthPrice();

    // ── Sanity-check gasPrice — Arbitrum L2 should be 0.01–0.5 gwei ──────────
    // If gasPrice > 2 gwei it's likely an L1-equivalent estimate and will make
    // every opportunity appear unprofitable. Cap at 2 gwei (2e9 wei) defensively.
    const MAX_REASONABLE_GAS_WEI = 2_000_000_000n; // 2 gwei
    const effectiveGasPrice = gasPrice > MAX_REASONABLE_GAS_WEI
      ? (() => {
          logger.warn(`  eval gasPrice=${Number(gasPrice)/1e9}gwei seems high for Arbitrum — capping at 2 gwei`);
          return MAX_REASONABLE_GAS_WEI;
        })()
      : gasPrice;
    const gweiStr = (Number(effectiveGasPrice) / 1e9).toFixed(4);
    logger.debug(`  eval gasPrice=${gweiStr}gwei ethPrice=$${ethPrice.toFixed(0)}`);

    // ── Pick best pair + OPT 4: partial liquidation size optimization ────────
    // Try multiple debtToCover sizes (25%, 50%, 75%, 100% of close factor max).
    // Smaller liquidations have lower Uniswap price impact — sometimes a 50%
    // liquidation is more profitable than a 100% one. We pick the best at the
    // oracle-estimate stage, then confirm with a real quote for the winner.
    const SIZE_FRACTIONS = [10000n, 7500n, 5000n, 2500n]; // bps: 100%, 75%, 50%, 25%
    let best: LiquidationOpportunity | null = null;

    for (const debt of debts) {
      const debtPrice = prices.get(debt.address.toLowerCase()) ?? 0n;
      if (debtPrice === 0n) { logger.warn(`  eval SKIP: debt ${debt.symbol} price=0`); continue; }

      const maxDebtToCover = (debt.balance * closeFactor) / 10000n;
      if (maxDebtToCover === 0n) continue;

      for (const collateral of collaterals) {
        const reserve = RESERVES[collateral.symbol];
        if (!reserve) {
          logger.warn(`  eval SKIP: collateral "${collateral.symbol}" not in RESERVES`);
          continue;
        }
        const collateralPrice = prices.get(collateral.address.toLowerCase()) ?? 0n;
        if (collateralPrice === 0n) { logger.warn(`  eval SKIP: collateral ${collateral.symbol} price=0`); continue; }

        const bonusFactor = BigInt(reserve.liquidationBonus);
        const collDec     = BigInt(10 ** collateral.decimals);
        const debtDec     = BigInt(10 ** debt.decimals);
        const isSameAsset_ = collateral.address.toLowerCase() === debt.address.toLowerCase();

        for (const fraction of SIZE_FRACTIONS) {
          let debtToCover = (maxDebtToCover * fraction) / 10000n;
          if (debtToCover === 0n) continue;

          let expectedCollateral =
            (debtToCover * debtPrice * bonusFactor * collDec)
            / (collateralPrice * 10000n * debtDec);
          if (expectedCollateral === 0n) continue;

          let actualDebtToCover = debtToCover;
          if (expectedCollateral > collateral.balance) {
            expectedCollateral = collateral.balance;
            actualDebtToCover  = (expectedCollateral * collateralPrice * 10000n * debtDec)
              / (debtPrice * bonusFactor * collDec);
            if (actualDebtToCover === 0n) continue;
          }

          const collValueUsd8 = (expectedCollateral * collateralPrice) / collDec;
          const debtValueUsd8 = (actualDebtToCover  * debtPrice)       / debtDec;
          if (collValueUsd8 <= debtValueUsd8) continue;

          const grossBonusUsd = this.oracle.toUsdNumber(collValueUsd8 - debtValueUsd8);
          const debtUsdNum    = this.oracle.toUsdNumber(debtValueUsd8);

          // OPT 4: price impact scales with size — smaller liquidations have lower impact
          const impactPct = debtUsdNum > 100_000 ? 0.02
            : debtUsdNum > 10_000 ? 0.01
            : debtUsdNum > 1_000  ? 0.005
            : 0.002;  // < $1k: virtually zero impact
          const bonusUsd = grossBonusUsd * (1 - impactPct);

          const preScreenGasUnits = isSameAsset_ ? SAME_ASSET_GAS : estimateGasUnits(1);
          const gasCostUsd        = Number(preScreenGasUnits * effectiveGasPrice) / 1e18 * ethPrice;
          const netProfitUsd      = bonusUsd - gasCostUsd;

          if (netProfitUsd > (best?.netProfitUsd ?? -Infinity)) {
            best = {
              borrower:           position.address,
              healthFactor:       position.healthFactorNum,
              collateralAsset:    collateral.address,
              collateralSymbol:   collateral.symbol,
              debtAsset:          debt.address,
              debtSymbol:         debt.symbol,
              debtToCover:        actualDebtToCover,
              debtToCoverUsd:     debtUsdNum,
              expectedCollateral,
              expectedBonusUsd:   bonusUsd,
              gasCostUsd,
              netProfitUsd,
              useFlashloan:       true,
            };
          }
        }
      }
    }

    if (!best) {
      logger.warn(
        `  eval NULL for ${position.address.slice(0,10)}: ` +
        `HF=${position.healthFactorNum.toFixed(4)} ` +
        `collaterals=[${collaterals.map(c => `${c.symbol}=$${c.balanceUsd.toFixed(2)}`).join(",")}] ` +
        `debts=[${debts.map(d => `${d.symbol}=$${d.balanceUsd.toFixed(2)}`).join(",")}] — no viable pair`
      );
      return null;
    }

    // ── Uniswap V3 quote for the winning pair ─────────────────────────────────
    const isSameAsset = best.collateralAsset.toLowerCase() === best.debtAsset.toLowerCase();

    let swapPath         = "0x";
    let amountOutMinimum = 0n;
    let swapOutputAmount = 0n;
    let finalGasCostUsd  = best.gasCostUsd;

    if (!isSameAsset) {
      // OPT 5: Skip the Uniswap quote RPC call for small positions.
      // For debt < minDebtForQuoteUsd, oracle-estimated profitability is accurate
      // enough (price impact is negligible at small sizes) — saves ~100-300ms.
      // We still attempt a fast 800ms-timeout quote; if it times out we proceed
      // with amountOutMinimum=0 (acceptable slippage risk on sub-$50 swaps).
      const flashloanPremium = (best.debtToCover * 5n) / 10_000n; // 0.05%
      const repayNeeded      = best.debtToCover + flashloanPremium;

      const isSmallPosition  = best.debtToCoverUsd < CONFIG.minDebtForQuoteUsd;
      const quoteTimeoutMs   = isSmallPosition ? 800 : 1_500;

      if (isSmallPosition) {
        logger.debug(
          `  eval OPT5: fast-timeout quote for small debt ($${best.debtToCoverUsd.toFixed(2)}) — 800ms limit`
        );
      }

      const swap = await Promise.race([
        uniswapSwap(
          best.collateralAsset,
          best.expectedCollateral,
          best.debtAsset,
          CONFIG.contractAddress,
          CONFIG.slippageBps,
          this._getProvider(),
        ),
        new Promise<null>(res => setTimeout(() => res(null), quoteTimeoutMs)),
      ]);

      if (!swap) {
        if (isSmallPosition) {
          // Timed out on a small position — proceed without a path.
          // The contract will revert if there is no liquidity, but the
          // ETH cost of a failed tx on Arbitrum is ~$0.02 — acceptable.
          amountOutMinimum = 0n;
          finalGasCostUsd  = Number(estimateGasUnits(1) * effectiveGasPrice) / 1e18 * ethPrice;
          logger.debug(`  eval OPT5: quote timed out — proceeding with amountOutMinimum=0`);
        } else {
          logger.warn(`  eval NULL: no Uniswap route ${best.collateralSymbol}->>${best.debtSymbol}`);
          return null;
        }
      } else if (swap.outputAmount < repayNeeded) {
        logger.warn(
          `  eval NULL: Uni output ${swap.outputAmount} < repayNeeded ${repayNeeded} ` +
          `(${best.collateralSymbol}->>${best.debtSymbol}) — slippage too high`
        );
        return null;
      } else {
        swapPath         = swap.swapPath;
        amountOutMinimum = swap.amountOutMinimum;
        swapOutputAmount = swap.outputAmount;
        // FIX: Use QuoterV2's actual gasEstimate instead of the fixed hop-count
        // estimate. QuoterV2 simulates the full swap and returns real gas usage,
        // which is more accurate than estimateGasUnits(hops) especially for
        // multi-hop routes with tick crossings. Apply the same 20% safety buffer
        // used in estimateGasUnits, plus the flashloan + liquidationCall overhead.
        const quoterGas     = BigInt(Math.ceil(swap.gasEstimate * 1.2));
        const swapGasUnits  = quoterGas > 50_000n ? quoterGas : estimateGasUnits(countHopsFromPath(swap.swapPath));
        finalGasCostUsd  = Number((BASE_GAS_UNITS + swapGasUnits) * effectiveGasPrice) / 1e18 * ethPrice;
      }
    } else {
      finalGasCostUsd = Number(SAME_ASSET_GAS * effectiveGasPrice) / 1e18 * ethPrice;
    }

    // Final profitability check with refined gas
    const finalNetProfit = best.expectedBonusUsd - finalGasCostUsd;

    const logFn = finalNetProfit >= CONFIG.minProfitUsd ? logger.info.bind(logger) : logger.warn.bind(logger);
    logFn(
      `  eval ${best.collateralSymbol}/${best.debtSymbol} | ` +
      `HF=${position.healthFactorNum.toFixed(4)} debt=$${best.debtToCoverUsd.toFixed(2)} ` +
      `bonus=$${best.expectedBonusUsd.toFixed(2)} gas=$${finalGasCostUsd.toFixed(2)} ` +
      `net=$${finalNetProfit.toFixed(2)} ` +
      `${finalNetProfit >= CONFIG.minProfitUsd ? "PROFITABLE" : "below min"}`
    );

    if (finalNetProfit < CONFIG.minProfitUsd) {
      logger.warn(
        `  eval NULL for ${position.address.slice(0,10)}: best=$${finalNetProfit.toFixed(2)} minProfit=$${CONFIG.minProfitUsd}`
      );
      return null;
    }

    return {
      ...best,
      gasCostUsd:      finalGasCostUsd,
      netProfitUsd:    finalNetProfit,
      swapPath,
      amountOutMinimum,
      swapOutputAmount,
    };
  }

  private toUsd(price8: bigint, rawAmount: bigint, decimals: number): number {
    return this.oracle.toUsdNumber((price8 * rawAmount) / BigInt(10 ** decimals));
  }

  private _ethPrice   = 0;
  private _ethPriceTs = 0;

  async getEthPrice(): Promise<number> {
    // Always return cached value if available — avoids RPC call on dead provider
    if (this._ethPrice && Date.now() - this._ethPriceTs < 30_000) return this._ethPrice;
    const WETH = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";
    try {
      const p    = await this.oracle.getPrice(WETH);
      this._ethPrice   = Number(p) / 1e8;
      this._ethPriceTs = Date.now();
    } catch { /* serve stale on error */ }
    return this._ethPrice;
  }
}
