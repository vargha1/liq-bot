// reserveState.ts — authoritative, in-memory mirror of Aave's reserve-side state.
//
// This exists so health factors can be recomputed for the WHOLE watchlist from
// memory, with zero RPC, the instant a price moves. It holds everything about a
// reserve that HF depends on:
//
//   liquidationThreshold / liquidationBonus / decimals   (from the config bitmap)
//   liquidityIndex / variableBorrowIndex + rates         (to turn a user's SCALED
//                                                         balances into real ones)
//   reserve id                                           (to test e-mode bitmaps)
//
// Why scaled balances matter: Aave stores user positions as index-normalised
// "scaled" amounts. A user's scaled balance does NOT change as interest accrues —
// it changes only when that user transacts. So once the model is built, interest
// accrual is handled entirely by advancing these per-reserve indices, and a user's
// entry stays valid until an event touches them. That is what makes steady-state
// RPC usage go to ~zero.
//
// Everything here is refreshed by ONE multicall over Pool.getReserveData, plus
// ReserveDataUpdated events for between-refresh index updates.

import { ethers } from "ethers";
import { logger } from "./logger";
import { AAVE_POOL, MULTICALL3, MULTICALL3_ABI, ADDRESS_TO_SYMBOL } from "./config";

export const RAY = 10n ** 27n;
const SECONDS_PER_YEAR = 31_536_000n;   // Aave's constant

// Pool.getReserveData returns the full ReserveData struct. The configuration
// bitmap inside it carries LT/bonus/decimals/flags, so this single call replaces
// a separate getReserveConfigurationData round-trip per asset.
const POOL_RESERVE_ABI = [
  "function getReservesList() external view returns (address[] memory)",
  `function getReserveData(address asset) external view returns (
     tuple(
       tuple(uint256 data) configuration,
       uint128 liquidityIndex,
       uint128 currentLiquidityRate,
       uint128 variableBorrowIndex,
       uint128 currentVariableBorrowRate,
       uint128 currentStableBorrowRate,
       uint40  lastUpdateTimestamp,
       uint16  id,
       address aTokenAddress,
       address stableDebtTokenAddress,
       address variableDebtTokenAddress,
       address interestRateStrategyAddress,
       uint128 accruedToTreasury,
       uint128 unbacked,
       uint128 isolationModeTotalDebt
     )
   )`,
  // Aave 3.2+ e-mode: a category defines shared risk params, and a bitmap of
  // which reserve ids may act as collateral under it. Assets outside the bitmap
  // give NO collateral credit to a user in that category.
  "function getEModeCategoryCollateralConfig(uint8 id) external view returns (tuple(uint16 ltv, uint16 liquidationThreshold, uint16 liquidationBonus))",
  "function getEModeCategoryCollateralBitmap(uint8 id) external view returns (uint128)",
];

const POOL_IFACE = new ethers.Interface(POOL_RESERVE_ABI);

// ReserveDataUpdated fires on every state-changing interaction with a reserve and
// carries the fresh indices — the cheapest possible way to stay current.
export const RESERVE_DATA_UPDATED_IFACE = new ethers.Interface([
  "event ReserveDataUpdated(address indexed reserve, uint256 liquidityRate, uint256 stableBorrowRate, uint256 variableBorrowRate, uint256 liquidityIndex, uint256 variableBorrowIndex)",
]);
export const TOPIC_RESERVE_DATA_UPDATED =
  RESERVE_DATA_UPDATED_IFACE.getEvent("ReserveDataUpdated")!.topicHash;

export interface ReserveState {
  address:              string;   // lowercase
  symbol:               string;
  id:                   number;   // index into the reserves list; used for e-mode bitmaps
  decimals:             number;
  liquidationThreshold: number;   // bps
  liquidationBonus:     number;   // bps
  active:               boolean;
  frozen:               boolean;
  liquidityIndex:       bigint;   // RAY
  variableBorrowIndex:  bigint;   // RAY
  liquidityRate:        bigint;   // RAY per year
  variableBorrowRate:   bigint;   // RAY per year
  lastUpdateTimestamp:  number;   // unix seconds
}

export interface EModeCategory {
  id:                   number;
  ltv:                  number;
  liquidationThreshold: number;
  liquidationBonus:     number;
  collateralBitmap:     bigint;
}

// Aave V3 reserve configuration bitmap layout. Stable across V3 releases.
const BITS_16 = (1n << 16n) - 1n;
function decodeConfig(data: bigint) {
  return {
    ltv:                  Number(data & BITS_16),
    liquidationThreshold: Number((data >> 16n) & BITS_16),
    liquidationBonus:     Number((data >> 32n) & BITS_16),
    decimals:             Number((data >> 48n) & 0xffn),
    active:               ((data >> 56n) & 1n) === 1n,
    frozen:               ((data >> 57n) & 1n) === 1n,
  };
}

export class ReserveRegistry {
  private byAddress = new Map<string, ReserveState>();
  private byId      = new Map<number, ReserveState>();
  private emodes    = new Map<number, EModeCategory>();
  private _loadedAt = 0;

  constructor(private getProvider: () => ethers.Provider) {}

  get loaded(): boolean { return this.byAddress.size > 0; }
  get size(): number { return this.byAddress.size; }
  get(address: string): ReserveState | undefined { return this.byAddress.get(address.toLowerCase()); }
  getById(id: number): ReserveState | undefined { return this.byId.get(id); }
  all(): ReserveState[] { return [...this.byAddress.values()]; }
  addresses(): string[] { return [...this.byAddress.keys()]; }

  // Full refresh: reserves list + every reserve's data, in two multicalls.
  // Cheap enough to run on an interval; ReserveDataUpdated keeps indices fresh
  // in between.
  async refreshAll(): Promise<void> {
    const provider = this.getProvider();
    const pool = new ethers.Contract(AAVE_POOL, POOL_RESERVE_ABI, provider);
    const mc   = new ethers.Contract(MULTICALL3, MULTICALL3_ABI, provider);

    const list: string[] = await pool.getReservesList();
    if (!list.length) throw new Error("getReservesList returned empty");

    const results: Array<{ success: boolean; returnData: string }> = await mc.tryAggregate(
      false,
      list.map(a => ({ target: AAVE_POOL, callData: POOL_IFACE.encodeFunctionData("getReserveData", [a]) })),
    );

    let ok = 0;
    for (let i = 0; i < list.length; i++) {
      const r = results[i];
      if (!r?.success || r.returnData === "0x") continue;
      try {
        const d = POOL_IFACE.decodeFunctionResult("getReserveData", r.returnData)[0] as any;
        const cfg = decodeConfig(d.configuration.data as bigint);
        const address = list[i]!.toLowerCase();
        const state: ReserveState = {
          address,
          symbol:               ADDRESS_TO_SYMBOL[address] ?? address.slice(0, 8),
          id:                   Number(d.id),
          decimals:             cfg.decimals,
          liquidationThreshold: cfg.liquidationThreshold,
          liquidationBonus:     cfg.liquidationBonus,
          active:               cfg.active,
          frozen:               cfg.frozen,
          liquidityIndex:       d.liquidityIndex as bigint,
          variableBorrowIndex:  d.variableBorrowIndex as bigint,
          liquidityRate:        d.currentLiquidityRate as bigint,
          variableBorrowRate:   d.currentVariableBorrowRate as bigint,
          lastUpdateTimestamp:  Number(d.lastUpdateTimestamp),
        };
        this.byAddress.set(address, state);
        this.byId.set(state.id, state);
        ok++;
      } catch (e: any) {
        logger.debug(`ReserveRegistry: decode failed for ${list[i]}: ${e.message}`);
      }
    }
    this._loadedAt = Date.now();
    logger.info(`ReserveRegistry: ${ok}/${list.length} reserves loaded`);
  }

  // Apply a ReserveDataUpdated log — keeps indices current between full refreshes
  // for free (no RPC at all).
  applyReserveDataUpdated(log: ethers.Log, blockTimestamp?: number): void {
    try {
      const parsed = RESERVE_DATA_UPDATED_IFACE.parseLog({ topics: log.topics as string[], data: log.data });
      if (!parsed) return;
      const state = this.byAddress.get((parsed.args[0] as string).toLowerCase());
      if (!state) return;
      state.liquidityRate       = parsed.args[1] as bigint;
      state.variableBorrowRate  = parsed.args[3] as bigint;
      state.liquidityIndex      = parsed.args[4] as bigint;
      state.variableBorrowIndex = parsed.args[5] as bigint;
      state.lastUpdateTimestamp = blockTimestamp ?? Math.floor(Date.now() / 1000);
    } catch { /* not our event */ }
  }

  // ── Scaled → actual ────────────────────────────────────────────────────────
  // Mirrors Pool.getReserveNormalizedIncome / getReserveNormalizedVariableDebt.
  // Aave uses linear interest for supply and binomially-approximated compound
  // interest for variable debt; we use linear for both. Over the seconds-to-
  // minutes gap between index refreshes the difference is ~1e-9 relative, far
  // below the margin of the 1.01 trigger ceiling — and it very slightly
  // UNDERSTATES debt, so it errs toward not firing rather than firing wrongly.
  normalizedIncome(state: ReserveState, nowSec: number): bigint {
    const dt = BigInt(Math.max(0, nowSec - state.lastUpdateTimestamp));
    if (dt === 0n) return state.liquidityIndex;
    const linear = RAY + (state.liquidityRate * dt) / SECONDS_PER_YEAR;
    return (linear * state.liquidityIndex) / RAY;
  }

  normalizedVariableDebt(state: ReserveState, nowSec: number): bigint {
    const dt = BigInt(Math.max(0, nowSec - state.lastUpdateTimestamp));
    if (dt === 0n) return state.variableBorrowIndex;
    const linear = RAY + (state.variableBorrowRate * dt) / SECONDS_PER_YEAR;
    return (linear * state.variableBorrowIndex) / RAY;
  }

  // ── E-mode ─────────────────────────────────────────────────────────────────
  emode(id: number): EModeCategory | undefined { return this.emodes.get(id); }

  // Is this reserve part of the e-mode category's collateral set (Aave 3.2+)?
  // Being outside the set does NOT disqualify the asset as collateral — see
  // effectiveLiquidationThreshold.
  isEModeCollateral(catId: number, reserveId: number): boolean {
    const cat = this.emodes.get(catId);
    if (!cat) return false;
    return ((cat.collateralBitmap >> BigInt(reserveId)) & 1n) === 1n;
  }

  // Fetch and cache any e-mode categories we've seen users in. Categories change
  // only by governance action, so this is effectively a one-time cost per id.
  async ensureEModes(ids: Iterable<number>): Promise<void> {
    const missing = [...new Set(ids)].filter(id => id > 0 && !this.emodes.has(id));
    if (missing.length === 0) return;

    const mc = new ethers.Contract(MULTICALL3, MULTICALL3_ABI, this.getProvider());
    const calls = missing.flatMap(id => [
      { target: AAVE_POOL, callData: POOL_IFACE.encodeFunctionData("getEModeCategoryCollateralConfig", [id]) },
      { target: AAVE_POOL, callData: POOL_IFACE.encodeFunctionData("getEModeCategoryCollateralBitmap", [id]) },
    ]);
    const results: Array<{ success: boolean; returnData: string }> = await mc.tryAggregate(false, calls);

    for (let i = 0; i < missing.length; i++) {
      const id  = missing[i]!;
      const rc  = results[i * 2];
      const rb  = results[i * 2 + 1];
      if (!rc?.success || rc.returnData === "0x" || !rb?.success || rb.returnData === "0x") continue;
      try {
        const cfg    = POOL_IFACE.decodeFunctionResult("getEModeCategoryCollateralConfig", rc.returnData)[0] as any;
        const bitmap = POOL_IFACE.decodeFunctionResult("getEModeCategoryCollateralBitmap", rb.returnData)[0] as bigint;
        if (Number(cfg.liquidationThreshold) === 0) continue;  // unused category
        this.emodes.set(id, {
          id,
          ltv:                  Number(cfg.ltv),
          liquidationThreshold: Number(cfg.liquidationThreshold),
          liquidationBonus:     Number(cfg.liquidationBonus),
          collateralBitmap:     bitmap,
        });
        logger.info(
          `E-mode category ${id}: LT=${Number(cfg.liquidationThreshold)} ` +
          `bonus=${Number(cfg.liquidationBonus)} collateralBitmap=0x${bitmap.toString(16)}`
        );
      } catch (e: any) {
        logger.debug(`ensureEModes: decode failed for category ${id}: ${e.message}`);
      }
    }
  }

  // Effective liquidation threshold (bps) for a user's collateral in a reserve.
  //
  // Aave 3.2+ rule, verified against live positions: a collateral asset inside
  // the user's e-mode collateral bitmap uses the CATEGORY threshold; an asset
  // outside it keeps its OWN reserve threshold and still counts as collateral.
  //
  // Getting this wrong is not a rounding error. Treating out-of-category assets
  // as worthless (LT 0) computed HF 0.27 for a position whose real HF was 1.84 —
  // the bot would have hammered healthy positions with reverting liquidations.
  // Earlier still, ignoring e-mode entirely understated the threshold on
  // in-category collateral (a stablecoin e-mode position is LT 9500, not 7800),
  // which silently hid real opportunities.
  effectiveLiquidationThreshold(reserve: ReserveState, userEmodeId: number): number {
    if (userEmodeId > 0) {
      const cat = this.emodes.get(userEmodeId);
      if (cat && this.isEModeCollateral(userEmodeId, reserve.id)) return cat.liquidationThreshold;
      // Category not loaded yet, or asset not in it: the reserve's own threshold
      // is what Aave applies.
    }
    return reserve.liquidationThreshold;
  }

  effectiveLiquidationBonus(reserve: ReserveState, userEmodeId: number): number {
    if (userEmodeId > 0) {
      const cat = this.emodes.get(userEmodeId);
      if (cat && this.isEModeCollateral(userEmodeId, reserve.id)) return cat.liquidationBonus;
    }
    return reserve.liquidationBonus;
  }
}
