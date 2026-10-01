import { ethers } from "ethers";
import { logger } from "./logger";
import { CONFIG, RESERVES } from "./config";
import type { ReserveRegistry } from "./reserveState";
import { AaveOracle } from "./oracle";
import {
  encodeHeuristicPath, getCachedRoute, scheduleRouteRefresh, routeNeedsRefresh,
} from "./uniswap";
import type { BorrowerPosition, LiquidationOpportunity, AssetPosition } from "./types";

// Aave V3.3+ liquidation sizing (LiquidationLogic.executeLiquidationCall; the
// Arbitrum pool is revision 11). Per debt reserve:
//   * the whole reserve debt is liquidatable, EXCEPT when HF > 0.95 and both the
//     collateral reserve and the debt reserve are worth >= $2000: then the repay
//     is capped at 50% of the borrower's TOTAL debt (in base currency);
//   * a partial repay must leave >= $1000 of debt in that reserve AND >= $1000 of
//     collateral in the collateral reserve, unless it clears the whole debt or
//     seizes all the collateral; anything else reverts with MustNotLeaveDust.
const CLOSE_FACTOR_HF_THRESHOLD = 95n * 10n ** 16n;  // 0.95
const DEFAULT_CLOSE_FACTOR      = 5000n;               // 50% in bps
const MIN_BASE_MAX_CLOSE_FACTOR_THRESHOLD = 2000n * 10n ** 8n;   // $2000, 8-dec base
const MIN_LEFTOVER_BASE = MIN_BASE_MAX_CLOSE_FACTOR_THRESHOLD / 2n;
// Safety margins against model drift (interest accrual, price estimate error).
const LEFTOVER_MARGIN_BPS  = 50n;  // keep leftovers 0.5% above the $1000 line
const FULL_CLOSE_BUFFER_BPS = 5n;  // ask for 0.05% more than a full close / collateral sweep
const CAP_SHAVE_BPS        = 1n;   // ask for 0.01% less than the 50% cap

function ceilDiv(a: bigint, b: bigint): bigint { return (a + b - 1n) / b; }

// Bug #3 fix, refined: Arbitrum L1 data fee estimate.
// On Arbitrum, transactions have an L1 data fee (calldata posting cost) that is NOT
// included in gasPrice * gasUsed. This fee scales with (a) actual calldata bytes and
// (b) the current L1 base fee, which can swing 5-10x with Ethereum L1 congestion. A
// single flat constant applied to every tx — same-asset or 3-hop swap, calm L1 or
// congested — either overprices cheap txs (rejecting profitable ones) or underprices
// expensive ones (submitting trades that lose money after the real fee lands). At
// MIN_PROFIT_USD as low as $0.07, that mispricing is the whole decision.
//
// Fix: read the real L1 base fee from the ArbGasInfo precompile (cached, refreshed
// off the hot path — see Evaluator.refreshL1BaseFee) and scale by the ACTUAL
// calldata size for the liquidate() call being priced.
const ARB_GAS_INFO_ADDRESS = "0x000000000000000000000000000000000000006C";
const ARB_GAS_INFO_ABI = ["function getL1BaseFeeEstimate() external view returns (uint256)"];
// Standard Ethereum calldata cost: 16 gas per byte. Arbitrum's L1 pricer applies a
// compression discount in practice, so this flat per-byte rate is conservative
// (slightly overestimates fee) rather than risking underestimation.
const L1_CALLDATA_GAS_PER_BYTE = 16n;
// Buffer on top of the raw base-fee*bytes estimate for the L1 pricer's dynamic
// backlog adjustment (can push effective cost above the raw base fee briefly).
const L1_FEE_SAFETY_MARGIN_BPS = 11_500n; // +15%
const L1_BASE_FEE_FALLBACK_WEI = 500_000_000n; // ~0.5 gwei — used until first refresh succeeds
const L1_BASE_FEE_REFRESH_MS   = 20_000;

// Calldata bytes for liquidate(address,address,address,uint256,bytes,uint256,uint256):
// 4-byte selector + 6 fixed 32-byte words (3 addr + debtToCover + bytes-offset +
// amountOutMinimum... deadline is a 7th word) + the dynamic `bytes swapPath` encoding
// (32-byte length word + path data padded to a 32-byte boundary).
const LIQUIDATE_FIXED_CALLDATA_BYTES = 4 + 7 * 32; // 228
function estimateCalldataBytes(swapPathBytes: number): number {
  const pathWords = Math.ceil(swapPathBytes / 32);
  return LIQUIDATE_FIXED_CALLDATA_BYTES + 32 /* length word */ + pathWords * 32;
}
// Hop-based path-byte estimate for the pre-screen, before an actual route is chosen.
// Mirrors estimateGasUnits' hop model: path = 20-byte token + (3+20)-byte hops.
function estimatePathBytes(hops: number): number {
  return hops === 0 ? 0 : 20 + hops * 23;
}
function l1FeeUsdFor(pathBytes: number, l1BaseFeeWei: bigint, ethPrice: number): number {
  const calldataBytes = estimateCalldataBytes(pathBytes);
  const gasUnits = BigInt(calldataBytes) * L1_CALLDATA_GAS_PER_BYTE;
  const feeWei = (gasUnits * l1BaseFeeWei * L1_FEE_SAFETY_MARGIN_BPS) / 10_000n;
  return Number(feeWei) / 1e18 * ethPrice;
}

// ── Fixed gas constants ────────────────────────────────────────────────────────
// PERF: Avoids an estimateGas RPC round-trip on the hot path.
// These are measured values from real Arbitrum liquidation txs + 20% safety buffer.
//   BASE_GAS_UNITS: flashloan setup + liquidationCall alone (~220k observed on Arbitrum)
//   PER_HOP_GAS:    Uniswap V3 gas per pool hop (~100k per hop observed on Arbitrum)
//   SAME_ASSET_GAS: collateral == debt, no swap needed (~220k)
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

// Extra allowance, on top of the pool fees, for price impact when no quoted
// route is cached yet and the output can only be estimated from oracle prices.
const UNQUOTED_IMPACT_BPS = 10;

const MAX_REASONABLE_GAS_WEI = 2_000_000_000n; // 2 gwei

// Arbitrum L2 should be 0.01–0.5 gwei. If gasPrice > cap it's likely an
// L1-equivalent estimate that would make every opportunity look unprofitable.
export function sanitizeGasPrice(gasPrice: bigint): bigint {
  if (gasPrice > MAX_REASONABLE_GAS_WEI) {
    logger.warn(`  eval gasPrice=${Number(gasPrice)/1e9}gwei seems high for Arbitrum — capping at 2 gwei`);
    return MAX_REASONABLE_GAS_WEI;
  }
  return gasPrice;
}

interface PairPickContext {
  position:         BorrowerPosition;
  collaterals:      AssetPosition[];
  debts:            AssetPosition[];
  prices:           Map<string, bigint>;
  effectiveGasPrice: bigint;
  ethPrice:         number;
  l1BaseFeeWei:     bigint;
  registry:         ReserveRegistry;
  emodeId:          number;
}

// Aave's liquidationProtocolFee applies to the BONUS portion of the seized
// collateral. Used only when the reserve registry has no value for the asset.
const DEFAULT_PROTOCOL_FEE_BPS = 1000n;

// USD cost of a transaction: L2 execution plus the L1 data fee for its calldata.
function txCostUsd(
  gasUnits: bigint, pathBytes: number, effectiveGasPrice: bigint,
  ethPrice: number, l1BaseFeeWei: bigint,
): number {
  return Number(gasUnits * effectiveGasPrice) / 1e18 * ethPrice
    + l1FeeUsdFor(pathBytes, l1BaseFeeWei, ethPrice);
}

// Sum of the pool fees along an encoded Uniswap V3 path, in basis points.
// Path: token(20) ++ [fee(3) ++ token(20)]*N; fee is in hundredths of a bp.
function pathFeeBps(swapPath: string): number {
  if (!swapPath || swapPath === "0x") return 0;
  let bps = 0;
  for (let pos = 2 + 40; pos + 6 + 40 <= swapPath.length; pos += 6 + 40) {
    bps += parseInt(swapPath.slice(pos, pos + 6), 16) / 100;
  }
  return bps;
}

// Shared candidate-pair selection used by BOTH the polling cycle (evaluate)
// and the event-driven trigger (buildFromLocal). Pure computation — no RPC.
function pickBestPair(ctx: PairPickContext): LiquidationOpportunity | null {
  const { position, collaterals, debts, prices, effectiveGasPrice, ethPrice, l1BaseFeeWei } = ctx;

  // The repay Aave accepts depends on the pair (collateral and debt reserve
  // values) and on the borrower's total debt, so it is derived inside the loop.
  // Asking for more than Aave allows is not an error: Aave silently repays less,
  // and a swap floor computed for the larger amount then reverts the whole tx.
  // Asking for a partial repay that leaves dust IS an error (MustNotLeaveDust).
  let best: LiquidationOpportunity | null = null;

  let totalDebtBase = 0n;
  for (const d of debts) {
    const p = prices.get(d.address.toLowerCase()) ?? 0n;
    if (p === 0n) continue;
    totalDebtBase += ceilDiv(d.balance * p, BigInt(10 ** d.decimals));
  }
  const leftoverMinBase = (MIN_LEFTOVER_BASE * (10000n + LEFTOVER_MARGIN_BPS)) / 10000n;

  // Gas cost depends only on whether a swap is needed — not on the pair or size.
  const gasUsdSame = txCostUsd(SAME_ASSET_GAS,       0,                     effectiveGasPrice, ethPrice, l1BaseFeeWei);
  const gasUsdSwap = txCostUsd(estimateGasUnits(1),  estimatePathBytes(1),  effectiveGasPrice, ethPrice, l1BaseFeeWei);
  const premiumBps = BigInt(CONFIG.flashloanPremiumBps);

  for (const debt of debts) {
    const debtPrice = prices.get(debt.address.toLowerCase()) ?? 0n;
    if (debtPrice === 0n) { logger.debug(`  eval SKIP: debt ${debt.symbol} price=0`); continue; }

    const debtDecimals  = BigInt(10 ** debt.decimals);
    const reserveDebt   = debt.balance;
    if (reserveDebt === 0n) continue;
    const debtBase      = ceilDiv(reserveDebt * debtPrice, debtDecimals);

    for (const collateral of collaterals) {
      const reserve = RESERVES[collateral.symbol];
      if (!reserve) {
        logger.warn(`  eval SKIP: collateral "${collateral.symbol}" not in RESERVES`);
        continue;
      }
      const collateralPrice = prices.get(collateral.address.toLowerCase()) ?? 0n;
      if (collateralPrice === 0n) { logger.debug(`  eval SKIP: collateral ${collateral.symbol} price=0`); continue; }

      // E-mode aware, straight from the reserve registry. A position in an
      // e-mode category earns that category's bonus for in-category collateral
      // (e.g. 10100 for stablecoins), not the reserve's own 10500.
      const rs = ctx.registry.get(collateral.address);
      const bonusFactor = BigInt(
        rs ? ctx.registry.effectiveLiquidationBonus(rs, ctx.emodeId) : reserve.liquidationBonus
      );
      const protocolFeeBps = rs ? BigInt(rs.liquidationProtocolFee) : DEFAULT_PROTOCOL_FEE_BPS;
      const collDec     = BigInt(10 ** collateral.decimals);
      const debtDec     = BigInt(10 ** debt.decimals);
      const isSameAsset = collateral.address.toLowerCase() === debt.address.toLowerCase();
      const gasCostUsd  = isSameAsset ? gasUsdSame : gasUsdSwap;

      // Most Aave will let us repay in this reserve (see the constants above).
      const collBase = (collateral.balance * collateralPrice) / collDec;
      let maxLiquidatable = reserveDebt;
      if (
        position.healthFactor > CLOSE_FACTOR_HF_THRESHOLD &&
        collBase >= MIN_BASE_MAX_CLOSE_FACTOR_THRESHOLD &&
        debtBase >= MIN_BASE_MAX_CLOSE_FACTOR_THRESHOLD
      ) {
        const cap = (totalDebtBase * DEFAULT_CLOSE_FACTOR) / 10000n;
        if (debtBase > cap) maxLiquidatable = (cap * debtDec) / debtPrice;
      }
      if (maxLiquidatable === 0n) continue;

      // Sizes worth pricing: the most allowed, the most allowed that still leaves
      // the $1000 debt leftover (matters when the 50% cap lands just short of a
      // full close), and half the most allowed for the price-impact tier edges.
      const sizes = new Set<bigint>([maxLiquidatable, maxLiquidatable / 2n]);
      const leftoverUnits = ceilDiv(leftoverMinBase * debtDec, debtPrice) + 1n;
      if (reserveDebt > leftoverUnits && reserveDebt - leftoverUnits < maxLiquidatable) {
        sizes.add(reserveDebt - leftoverUnits);
      }

      for (const debtToCover of sizes) {
        if (debtToCover === 0n) continue;

        // Collateral Aave would seize for this repayment, bonus included.
        let grossCollateral =
          (debtToCover * debtPrice * bonusFactor * collDec)
          / (collateralPrice * 10000n * debtDec);
        if (grossCollateral === 0n) continue;

        let actualDebtToCover = debtToCover;
        let sweepsCollateral  = false;
        if (grossCollateral >= collateral.balance) {
          sweepsCollateral = true;
          grossCollateral = collateral.balance;
          actualDebtToCover = (grossCollateral * collateralPrice * 10000n * debtDec)
            / (debtPrice * bonusFactor * collDec);
          if (actualDebtToCover === 0n) continue;
        }
        const clearsDebt = actualDebtToCover >= reserveDebt;

        // Aave rejects a partial repay that strands dust on either side.
        if (!clearsDebt && !sweepsCollateral) {
          const debtLeftBase = ceilDiv((reserveDebt - actualDebtToCover) * debtPrice, debtDec);
          const collLeftBase = ((collateral.balance - grossCollateral) * collateralPrice) / collDec;
          if (debtLeftBase < leftoverMinBase || collLeftBase < leftoverMinBase) continue;
        }

        // What we ask Aave for. Clearing the debt or sweeping the collateral only
        // works if we ask for slightly more than our estimate says is needed (the
        // balance may have accrued since); Aave takes just what it needs and the
        // unused part of the flashloan stays in the contract. Under the 50% cap we
        // ask for slightly less, so rounding can never push the request above it.
        let requested = actualDebtToCover;
        if (clearsDebt) {
          requested = (reserveDebt * (10000n + FULL_CLOSE_BUFFER_BPS)) / 10000n;
        } else if (sweepsCollateral) {
          requested = (actualDebtToCover * (10000n + FULL_CLOSE_BUFFER_BPS)) / 10000n;
          if (requested > maxLiquidatable) requested = maxLiquidatable;
        } else if (debtToCover === maxLiquidatable && maxLiquidatable < reserveDebt) {
          requested = debtToCover - (debtToCover * CAP_SHAVE_BPS) / 10000n;
        }

        // Aave keeps a share of the BONUS as protocol fee; we receive the rest.
        const bonusPart      = grossCollateral - (grossCollateral * 10000n) / bonusFactor;
        const expectedCollateral = grossCollateral - (bonusPart * protocolFeeBps) / 10000n;

        const collValueUsd8 = (expectedCollateral * collateralPrice) / collDec;
        const debtValueUsd8 = (actualDebtToCover  * debtPrice)       / debtDec;
        if (collValueUsd8 <= debtValueUsd8) continue;

        const grossBonusUsd = toUsdNumberStatic(collValueUsd8 - debtValueUsd8);
        const debtUsdNum    = toUsdNumberStatic(debtValueUsd8);

        // Price impact scales with size — smaller liquidations have lower impact.
        const impactPct = debtUsdNum > 100_000 ? 0.02
          : debtUsdNum > 10_000 ? 0.01
          : debtUsdNum > 1_000  ? 0.005
          : 0.002;  // < $1k: virtually zero impact
        const premiumUsd = debtUsdNum * Number(premiumBps) / 10_000;
        const bonusUsd   = grossBonusUsd * (1 - impactPct) - premiumUsd;
        const netProfitUsd = bonusUsd - gasCostUsd;

        if (netProfitUsd > (best?.netProfitUsd ?? -Infinity)) {
          best = {
            borrower:           position.address,
            healthFactor:       position.healthFactorNum,
            collateralAsset:    collateral.address,
            collateralSymbol:   collateral.symbol,
            debtAsset:          debt.address,
            debtSymbol:         debt.symbol,
            debtToCover:        requested,
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
  return best;
}

function toUsdNumberStatic(usd8: bigint): number {
  return Number(usd8) / 1e8;
}

export class Evaluator {
  // Cached Arbitrum L1 base fee (wei) — see l1FeeUsdFor(). Refreshed off the
  // hot path; a hot-path caller always reads the last cached value synchronously.
  private _l1BaseFeeWei     = L1_BASE_FEE_FALLBACK_WEI;
  private _lastL1FeeRefreshTs = 0;

  constructor(
    private oracle:       AaveOracle,
    private _getProvider: () => ethers.Provider,
    private registry:     ReserveRegistry,
  ) {}

  // Refresh the cached L1 base fee from the ArbGasInfo precompile. Throttled;
  // call on an interval (see index.ts) — never from the hot path. Falls back
  // silently to the last known value (or the flat fallback) on any RPC failure.
  async refreshL1BaseFee(): Promise<void> {
    const now = Date.now();
    if (now - this._lastL1FeeRefreshTs < L1_BASE_FEE_REFRESH_MS) return;
    this._lastL1FeeRefreshTs = now;
    try {
      const gasInfo = new ethers.Contract(ARB_GAS_INFO_ADDRESS, ARB_GAS_INFO_ABI, this._getProvider());
      const fee: bigint = await gasInfo.getL1BaseFeeEstimate();
      if (fee > 0n) this._l1BaseFeeWei = fee;
    } catch (e: any) {
      logger.debug(`refreshL1BaseFee failed, keeping cached value: ${e?.message ?? e}`);
    }
  }

  // Polling-cycle entry point. Everything runs in one shot with ZERO RPC calls
  // beyond the optional price prefetch the caller already did:
  //   1. Oracle prices (cycle-level prefetch, passed in via priceMap)
  //   2. Picks the best collateral/debt pair by estimated profit (pure CPU)
  //   3. Route from the background cache (or deterministic heuristic) — NO QuoterV2 call
  //   4. amountOutMinimum derived from Aave oracle prices (contract enforces on-chain)
  //   5. Returns a ready-to-submit LiquidationOpportunity
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

    const ethPrice = ethPriceUsd ?? await this.getEthPrice();
    const gweiStr = (Number(gasPrice) / 1e9).toFixed(4);
    logger.debug(`  eval gasPrice=${gweiStr}gwei ethPrice=$${ethPrice.toFixed(0)}`);

    const best = pickBestPair({
      position, collaterals, debts, prices,
      effectiveGasPrice: sanitizeGasPrice(gasPrice),
      ethPrice,
      l1BaseFeeWei: this._l1BaseFeeWei,
      registry: this.registry,
      emodeId:  position.userEmodeCategoryId ?? 0,
    });

    if (!best) {
      logger.warn(
        `  eval NULL for ${position.address.slice(0,10)}: ` +
        `HF=${position.healthFactorNum.toFixed(4)} ` +
        `collaterals=[${collaterals.map(c => `${c.symbol}=$${c.balanceUsd.toFixed(2)}`).join(",")}] ` +
        `debts=[${debts.map(d => `${d.symbol}=$${d.balanceUsd.toFixed(2)}`).join(",")}] — no viable pair`
      );
      return null;
    }

    return this.finalize(best, prices, gasPrice, ethPrice);
  }

  // Event-driven trigger entry point. Caller has already decided (via local HF
  // recomputation) that this position is at/near liquidatable — skips the EVICT
  // and HF-threshold pre-screens so nothing blocks the hot path. Pure CPU.
  buildFromLocal(
    position:     BorrowerPosition,
    collaterals:  AssetPosition[],
    debts:        AssetPosition[],
    priceMap:     Map<string, bigint>,
    gasPrice:     bigint,
    ethPriceUsd:  number,
    // Hypothetical evaluation (an SVR preview or probe): nothing here is on-chain,
    // so the result must not be announced at info level as a live opportunity.
    quiet = false,
  ): LiquidationOpportunity | null {
    if (!collaterals.length || !debts.length) return null;
    for (const c of collaterals) {
      const p = priceMap.get(c.address.toLowerCase()) ?? 0n;
      if (p === 0n) return null;
      c.balanceUsd = this.toUsd(p, c.balance, c.decimals);
    }
    for (const d of debts) {
      const p = priceMap.get(d.address.toLowerCase()) ?? 0n;
      if (p === 0n) return null;
      d.balanceUsd = this.toUsd(p, d.balance, d.decimals);
    }

    const best = pickBestPair({
      position, collaterals, debts, prices: priceMap,
      effectiveGasPrice: sanitizeGasPrice(gasPrice),
      ethPrice: ethPriceUsd,
      l1BaseFeeWei: this._l1BaseFeeWei,
      registry: this.registry,
      emodeId:  position.userEmodeCategoryId ?? 0,
    });
    if (!best) return null;
    return this.finalize(best, priceMap, gasPrice, ethPriceUsd, this._l1BaseFeeWei, quiet);
  }

  // Attach swap route + on-chain floor + final profitability gate.
  // HOT-PATH RULE: no RPC here. The route comes from the background cache or a
  // deterministic heuristic; a background refresh is scheduled either way.
  //
  // Expected swap output — the number every decision below rests on — is
  //   * the cached QuoterV2 result scaled to this size, capped by the oracle
  //     value (optimistic: real impact grows super-linearly), when a route is
  //     cached; otherwise
  //   * the oracle value of the collateral net of the path's pool fees.
  // Both already exclude Aave's protocol fee (expectedCollateral is net of it).
  //
  // The on-chain amountOutMinimum is the BREAK-EVEN output: flashloan repayment
  // plus this transaction's own gas, expressed in debt tokens. It used to be
  // "repayment + 99% of the projected bonus", which left 1% of the bonus (~0.05%
  // of the trade) to cover pool fees, impact and the protocol fee — less than a
  // 0.05% pool's own fee, so any swap through a normal pool reverted. There is
  // no public mempool on Arbitrum (the sequencer orders first-come-first-served),
  // so sandwiching is not the threat a tight floor guards against; the profit
  // decision is made off-chain, and the floor only has to keep a losing swap
  // from executing.
  private finalize(
    best:      LiquidationOpportunity,
    prices:    Map<string, bigint>,
    gasPrice:  bigint,
    ethPrice:  number,
    l1BaseFeeWei: bigint = this._l1BaseFeeWei,
    quiet = false,
  ): LiquidationOpportunity | null {
    const effectiveGasPrice = sanitizeGasPrice(gasPrice);
    const isSameAsset = best.collateralAsset.toLowerCase() === best.debtAsset.toLowerCase();

    const collReserve = RESERVES[best.collateralSymbol];
    const debtReserve = RESERVES[best.debtSymbol];
    const collPrice = prices.get(best.collateralAsset.toLowerCase()) ?? 0n;
    const debtPrice = prices.get(best.debtAsset.toLowerCase()) ?? 0n;
    if (!collReserve || !debtReserve || collPrice <= 0n || debtPrice <= 0n) return null;
    const collDec = BigInt(10 ** collReserve.decimals);
    const debtDec = BigInt(10 ** debtReserve.decimals);

    const premium     = (best.debtToCover * BigInt(CONFIG.flashloanPremiumBps)) / 10_000n;
    const repayNeeded = best.debtToCover + premium;

    let swapPath        = "0x";
    let gasCostUsd:       number;
    let expectedOut:      bigint;   // debt tokens we expect to end up holding
    let quoteBased      = false;

    if (isSameAsset) {
      gasCostUsd  = txCostUsd(SAME_ASSET_GAS, 0, effectiveGasPrice, ethPrice, l1BaseFeeWei);
      expectedOut = best.expectedCollateral;
    } else {
      // ── Route: cached best-path, else deterministic heuristic ──────────────
      const route = getCachedRoute(best.collateralAsset, best.debtAsset);
      if (!route) {
        scheduleRouteRefresh(best.collateralAsset, best.debtAsset, best.expectedCollateral, this._getProvider(), true);
      } else if (routeNeedsRefresh(best.collateralAsset, best.debtAsset)) {
        scheduleRouteRefresh(best.collateralAsset, best.debtAsset, best.expectedCollateral, this._getProvider());
      }
      swapPath = route?.path ?? encodeHeuristicPath(best.collateralAsset, best.debtAsset);

      // Actual swapPath bytes now known — price the real calldata, not an estimate.
      // estimateGasUnits already returns BASE_GAS_UNITS + PER_HOP_GAS × hops.
      gasCostUsd = txCostUsd(
        estimateGasUnits(countHopsFromPath(swapPath)), (swapPath.length - 2) / 2,
        effectiveGasPrice, ethPrice, l1BaseFeeWei,
      );

      // Oracle value of the collateral we will sell, in debt-token units.
      const oracleOut = (best.expectedCollateral * collPrice * debtDec) / (collDec * debtPrice);
      if (route && route.amountIn > 0n && route.out > 0n) {
        const scaled = (route.out * best.expectedCollateral) / route.amountIn;
        expectedOut  = scaled < oracleOut ? scaled : oracleOut;
        quoteBased   = true;
      } else {
        const feeBps = BigInt(Math.ceil(pathFeeBps(swapPath) + UNQUOTED_IMPACT_BPS));
        expectedOut  = (oracleOut * (10_000n - feeBps)) / 10_000n;
      }
    }

    // Gas expressed in debt tokens (rounded up) — the on-chain floor's margin.
    const debtPriceUsd = Number(debtPrice) / 1e8;
    const gasDebtUnits = BigInt(Math.ceil(gasCostUsd / debtPriceUsd * Number(debtDec)));
    const breakEven    = repayNeeded + gasDebtUnits;

    // Profit decision runs on a haircut output: SLIPPAGE_BPS is the allowance for
    // the estimate being optimistic. Same-asset has no swap, so no haircut.
    const decisionOut = isSameAsset
      ? expectedOut
      : (expectedOut * BigInt(10_000 - CONFIG.slippageBps)) / 10_000n;

    if (decisionOut <= repayNeeded) {
      logger.debug(
        `  eval SKIP ${best.borrower.slice(0,10)}: ${best.collateralSymbol}→${best.debtSymbol} ` +
        `swap yields ${decisionOut} < repayment ${repayNeeded} (${quoteBased ? "quote" : "oracle-estimated"})`
      );
      return null;
    }

    const profitUsd = Number(((decisionOut - repayNeeded) * debtPrice) / debtDec) / 1e8;
    const finalNetProfit = profitUsd - gasCostUsd;

    // An opportunity below the profit floor is routine, not a warning — during a
    // crash there can be hundreds per second. Keep the profitable ones at info.
    //
    // "Profitable" is not the same as "actionable". Candidate generation reaches
    // above 1.0 on purpose, so most of what arrives here sits just over Aave's
    // threshold and cannot be liquidated at all. Only a genuinely liquidatable,
    // genuinely profitable opportunity earns info.
    const liquidatable = best.healthFactor < 1;
    const profitable   = finalNetProfit >= CONFIG.minProfitUsd;
    const logFn = (profitable && liquidatable && !quiet) ? logger.info.bind(logger) : logger.debug.bind(logger);
    logFn(
      `  eval ${best.collateralSymbol}/${best.debtSymbol} | ` +
      `HF=${best.healthFactor.toFixed(4)} debt=$${best.debtToCoverUsd.toFixed(2)} ` +
      `bonus=$${profitUsd.toFixed(2)} gas=$${gasCostUsd.toFixed(2)} ` +
      `net=$${finalNetProfit.toFixed(2)} ` +
      `${!profitable ? "below min" : liquidatable ? "PROFITABLE" : "profitable but HF>=1 — needs confirmation"}`
    );

    if (!profitable) {
      logger.debug(
        `  eval NULL for ${best.borrower.slice(0,10)}: best=$${finalNetProfit.toFixed(2)} minProfit=$${CONFIG.minProfitUsd}`
      );
      return null;
    }

    return {
      ...best,
      expectedBonusUsd: profitUsd,
      gasCostUsd,
      netProfitUsd:    finalNetProfit,
      swapPath,
      amountOutMinimum: isSameAsset ? 0n : breakEven,
      swapOutputAmount: 0n,  // unknown without a live quote — contract enforces minOut on-chain
    };
  }

  private toUsd(price8: bigint, rawAmount: bigint, decimals: number): number {
    return this.oracle.toUsdNumber((price8 * rawAmount) / BigInt(10 ** decimals));
  }

  private _ethPrice   = 0;
  private _ethPriceTs = 0;

  // Last cached ETH price without RPC — used by the trigger hot path.
  ethPriceCached(): number { return this._ethPrice; }

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
