import { ethers } from "ethers";
import axios from "axios";
import * as fs from "fs";
import * as path from "path";
import { logger } from "./logger";
import {
  AAVE_POOL, AAVE_DATA_PROVIDER, UI_POOL_DATA_PROVIDER, POOL_ADDRESSES_PROVIDER,
  MULTICALL3, AAVE_SUBGRAPH_URL,
  AAVE_POOL_ABI, DATA_PROVIDER_ABI, UI_POOL_DATA_PROVIDER_ABI, MULTICALL3_ABI, RESERVES,
  CONFIG,
} from "./config";
import type { BorrowerPosition, AssetPosition } from "./types";
import { ReserveRegistry, RAY, TOPIC_RESERVE_DATA_UPDATED, rayMul, healthFactorExact } from "./reserveState";

// ── Constants ──────────────────────────────────────────────────────────────────
const HF_ONE   = 10n ** 18n;
const HF_WATCH = 109n * 10n ** 16n;   // 1.09 — prune threshold (delete if HF > this)
// HF_PREWARM: pre-warm breakdown cache for positions approaching liquidation.
// A position at HF=1.05 needs only a ~5% price drop to become liquidatable.
// By pre-fetching its breakdown now, we skip that RPC call when it actually crosses 1.0.
const HF_PREWARM = 105n * 10n ** 16n;  // 1.05 — pre-warm breakdown cache threshold
// Raised from 1.05: a position at HF=1.10 needs only a 9% price drop to liquidate.
// On volatile assets (ARB, weETH, LINK) this happens in under an hour during crashes.
// Watching up to HF=1.30 costs almost nothing with Multicall3 batching.
const HF_SEED  = 110n * 10n ** 16n;   // 1.10 — initial HF for unseen positions
// HF_SEED > HF_WATCH means freshly upserted addresses start in the rotation tier,
// not the danger tier. They get their real HF on first rotation check. Without this,
// every position seeded from the subgraph starts at exactly HF_WATCH and immediately
// falls into danger (< HF_WATCH is false, == is not danger either, but after one real
// check returning e.g. 1.04 they stay in danger forever and starve rotation).
// FIX: Reduced from 50 000 to 2 000 — most RPC providers reject ranges > 10 000 blocks.
// 2 000 is conservative and works on Alchemy, QuickNode, Infura, etc.
const SCAN_CHUNK        = 3_000n;
// Gap-fill queries every monitored Aave topic at once, so a chunk yields far
// more logs than the Borrow-only historical scan. Keep it small enough to stay
// under provider result-count caps.
const GAP_FILL_CHUNK    = 2_000n;
const AAVE_DEPLOY_BLOCK = 7742429n;

const MIN_DEBT_USD8             = 1_000_000_000n;     // $10 — eviction threshold (matches cycle MIN_DEBT_USD)
                                                        // Positions below this can never cover flashloan premium + gas
const MIN_DEBT_FOR_BREAKDOWN_USD8 = 1_000_000_000n;   // $10 — skip cheap breakdown

// Breakdown cache TTL — tiered by position risk level.
// Danger positions (HF < 1.05) need fresh data every 5 blocks (~6s).
// Other positions change slowly — 50 blocks (~60s) avoids redundant RPC calls.
// Both are invalidated immediately on any Aave event for the address.
const BREAKDOWN_CACHE_BLOCKS_DANGER = 5n;   // HF < HF_PREWARM
const BREAKDOWN_CACHE_BLOCKS_NORMAL = 50n;  // all others

// ── Borrower cache ─────────────────────────────────────────────────────────────
//
// TWO separate cache files:
//
//   borrowers-cache.json  (FULL_CACHE_FILE) — the complete set of all known
//     borrowers discovered by scan/subgraph/events.  Never pruned — grows
//     monotonically.  Used on restart to seed all known addresses so that
//     positions which are healthy today but dangerous after a crash are still
//     watched.  Updated only by seed() (scan + incremental events) and
//     appendToFullCache() (live Borrow events).
//
//   active-cache.json     (CACHE_FILE) — the post-prune active watchlist written
//     mid-prune and at prune completion.  Used only to quickly restore the
//     last-known active set after a crash/restart between full cache rebuilds.
//     Overwritten freely during prune; its shrinkage MUST NOT affect FULL_CACHE.
//
// On restart:
//   1. Load active-cache for fast startup (already pruned set from last run).
//   2. Merge FULL_CACHE on top, upserting any addresses not already present.
//      These arrive at HF_SEED (1.10) and get a real HF on first rotation check.
//   3. Incremental scan to pick up new borrows since last full-cache block.
//   This ensures no historically-known borrower is permanently lost after a prune.
const CACHE_FILE      = path.resolve(process.cwd(), "active-cache.json");
const FULL_CACHE_FILE = path.resolve(process.cwd(), "borrowers-cache.json");
// Persisted bad-debt denylist — survives restarts so known bad-debt positions are never
// re-evaluated. Without this, every restart re-seeds 0x04511e… and 0xf740382c from the
// full cache, detects them as liquidatable (HF=0), runs breakdown+evaluate, then evicts —
// wasting a cycle and logging a false "liquidatable=1" indefinitely.
const DENYLIST_FILE    = path.resolve(process.cwd(), "bad-debt-denylist.json");
// A dormant position remembers which reserve addresses it actually touches, so a
// price drop on an unrelated asset doesn't wake it. Populated from the breakdown
// cache at park time; absent when the position was parked without a breakdown
// (e.g. during the startup prune), in which case wake logic falls back to HF.
interface DormantEntry {
  lastHF:       bigint;
  dormantSince: number;
  assets?:      string[];   // lowercase reserve addresses (collateral + debt)
}

interface BorrowerCache {
  scannedUpToBlock: number;
  borrowers: string[];
  // Dormant positions survive restarts so the recheck window isn't reset.
  // Stored as [address, lastHF (hex string), dormantSince (ms), assets?] tuples.
  // Older caches stored a single topCollateral string in slot 3 — loadCache
  // normalises that shape.
  dormant?: Array<[string, string, number, (string[] | string)?]>;
}

function loadDenylist(): Set<string> {
  try {
    if (!fs.existsSync(DENYLIST_FILE)) return new Set();
    const data = JSON.parse(fs.readFileSync(DENYLIST_FILE, "utf8")) as string[];
    if (!Array.isArray(data)) return new Set();
    logger.info(`Denylist: loaded ${data.length} bad-debt addresses`);
    return new Set(data);
  } catch (e: any) { logger.warn(`Denylist read failed: ${e.message}`); return new Set(); }
}

function saveDenylist(denylist: Set<string>): void {
  // Bug #13 fix: use async write to avoid blocking the event loop.
  // With a large denylist, sync writes could block for 100ms+ and miss block events.
  const data = JSON.stringify([...denylist]);
  fs.promises.writeFile(DENYLIST_FILE, data, "utf8")
    .catch((e: any) => logger.warn(`Denylist save failed: ${e.message}`));
}

function loadCache(): BorrowerCache | null {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")) as BorrowerCache;
    if (!data.scannedUpToBlock || !Array.isArray(data.borrowers)) return null;
    logger.info(`Active cache: ${data.borrowers.length} borrowers, last block ${data.scannedUpToBlock}` +
      (data.dormant?.length ? ` + ${data.dormant.length} dormant` : ""));
    return data;
  } catch (e: any) { logger.warn(`Active cache read failed: ${e.message}`); return null; }
}

function saveCache(scannedUpToBlock: bigint, borrowers: string[], dormant?: Map<string, DormantEntry>): void {
  // Bug #13 fix: use async write to avoid blocking the event loop.
  const dormantArr: Array<[string, string, number, string[]?]> = dormant
    ? [...dormant.entries()].map(([addr, e]) => [addr, e.lastHF.toString(16), e.dormantSince, e.assets])
    : [];
  const data = JSON.stringify({
    scannedUpToBlock: Number(scannedUpToBlock),
    borrowers,
    dormant: dormantArr,
  });
  fs.promises.writeFile(CACHE_FILE, data, "utf8")
    .then(() => logger.info(`Active cache saved: ${borrowers.length} borrowers + ${dormantArr.length} dormant at block ${scannedUpToBlock}`))
    .catch((e: any) => logger.warn(`Active cache write failed: ${e.message}`));
}

function loadFullCache(): BorrowerCache | null {
  try {
    if (!fs.existsSync(FULL_CACHE_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(FULL_CACHE_FILE, "utf8")) as BorrowerCache;
    if (!data.scannedUpToBlock || !Array.isArray(data.borrowers)) return null;
    logger.info(`Full cache: ${data.borrowers.length} borrowers, last block ${data.scannedUpToBlock}`);
    return data;
  } catch (e: any) { logger.warn(`Full cache read failed: ${e.message}`); return null; }
}

function saveFullCache(scannedUpToBlock: bigint, borrowers: string[]): void {
  // Bug #13 fix: use async write to avoid blocking the event loop.
  const data = JSON.stringify({ scannedUpToBlock: Number(scannedUpToBlock), borrowers });
  fs.promises.writeFile(FULL_CACHE_FILE, data, "utf8")
    .then(() => logger.info(`Full cache saved: ${borrowers.length} borrowers at block ${scannedUpToBlock}`))
    .catch((e: any) => logger.warn(`Full cache write failed: ${e.message}`));
}


// ── Topic hashes ───────────────────────────────────────────────────────────────
const IFACE                  = new ethers.Interface(AAVE_POOL_ABI);
const DATA_PROVIDER_IFACE    = new ethers.Interface(DATA_PROVIDER_ABI);
const UI_IFACE               = new ethers.Interface(UI_POOL_DATA_PROVIDER_ABI);

// Lowercase address → reserve config. Replaces the repeated
// Object.values(RESERVES).find(...) linear scan that ran once per active asset
// per address inside the breakdown hot path.
const RESERVE_BY_ADDRESS: Record<string, (typeof RESERVES)[string]> = {};
for (const r of Object.values(RESERVES)) RESERVE_BY_ADDRESS[r.address.toLowerCase()] = r;
const TOPIC_BORROW           = IFACE.getEvent("Borrow")!.topicHash;
const TOPIC_SUPPLY           = IFACE.getEvent("Supply")!.topicHash;
const TOPIC_REPAY            = IFACE.getEvent("Repay")!.topicHash;
const TOPIC_WITHDRAW         = IFACE.getEvent("Withdraw")!.topicHash;
const TOPIC_LIQUIDATION_CALL = IFACE.getEvent("LiquidationCall")!.topicHash;
const TOPIC_COLLATERAL_ON    = IFACE.getEvent("ReserveUsedAsCollateralEnabled")!.topicHash;
const TOPIC_COLLATERAL_OFF   = IFACE.getEvent("ReserveUsedAsCollateralDisabled")!.topicHash;
export const MONITORED_TOPICS = [
  TOPIC_BORROW, TOPIC_SUPPLY, TOPIC_REPAY, TOPIC_WITHDRAW, TOPIC_LIQUIDATION_CALL,
  TOPIC_COLLATERAL_ON, TOPIC_COLLATERAL_OFF,
];

// ── Breakdown cache entry ──────────────────────────────────────────────────────
interface BreakdownEntry {
  collaterals: AssetPosition[];
  debts:       AssetPosition[];
  expiresAt:   bigint;  // block number after which the entry is stale
}

// ── In-memory user position model ─────────────────────────────────────────────
// One entry per borrower, holding Aave's SCALED balances rather than actual
// ones. Scaled balances are index-normalised: they do not move as interest
// accrues, only when the user transacts. So an entry stays valid until an Aave
// event touches that address, and interest is applied at read time from the
// reserve indices in ReserveRegistry.
//
// This is what lets the trigger engine recompute health factors for the entire
// watchlist, from memory, on every price tick — with no RPC and no dependence on
// a per-position breakdown having been pre-warmed.
export interface UserReserveSnapshot {
  asset:               string;   // lowercase
  scaledATokenBalance: bigint;
  usageAsCollateral:   boolean;
  scaledVariableDebt:  bigint;
}

export interface UserState {
  reserves:  UserReserveSnapshot[];  // only reserves the user actually touches
  emodeId:   number;
  fetchedAt: number;                 // ms — for staleness reporting only
}

export class PositionTracker {
  private positions      = new Map<string, BorrowerPosition>();
  private priorityQueue  = new Set<string>();
  // Set by index.ts — notified when a competitor liquidates a borrower we watch.
  // The executor uses this to distinguish "beaten to it" from "our tx failed".
  onExternalLiquidation: ((borrower: string) => void) | null = null;
  // Our own liquidator contract (lowercase). LiquidationCall fires for our own
  // successful txs too; without this the executor books every win as "beaten by
  // a competitor" and applies the external cooldown on top of the success one.
  ownLiquidator: string | null = null;
  // Permanently evicted bad-debt addresses — persisted to disk so restarts don't
  // re-evaluate known-bad positions. Only a new Borrow event can re-admit an address.
  private badDebtDenylist: Set<string> = loadDenylist();
  private rotationCursor = 0;
  private lastEventBlock = 0n;
  private currentBlock   = 0n;

  // ── Stable rotation list ───────────────────────────────────────────────────
  // Rebuilt only when positions are added or removed, NOT on every cycle.
  // This ensures rotationCursor advances monotonically through the full list
  // instead of re-indexing into a fresh array each cycle (which caused the
  // cursor to drift back to the start after any deletion).
  private rotationList: string[] = [];
  private rotationDirty          = false;

  // Maintained sorted danger list — sorted ascending by HF (lowest = most at risk first).
  // Updated incrementally on every processAccountData result instead of rebuilding
  // from scratch every cycle. Eliminates the O(N) spread + O(D log D) sort per cycle.
  // N=3384 positions × 1.7 cycles/sec = ~5700 full array copies/min avoided.
  private dangerList: BorrowerPosition[] = [];
  private dangerDirty = false;

  // ── Dormant tier ───────────────────────────────────────────────────────────
  // Positions that were checked and found healthy (HF > HF_WATCH = 1.30) are
  // moved here instead of being permanently deleted. Every DORMANT_RECHECK_MS
  // they are woken back into the active rotation — catching positions that became
  // dangerous due to price moves.
  // Shortened from 6h to 1h: crypto prices can move >10% in under an hour, and
  // a position parked at HF=1.35 could be liquidatable after a 5% ETH drop.
  // Bug #11 fix: store the position's reserve set in the dormant map so
  // wakeByCollateralAssets can filter by asset instead of waking ALL
  // vulnerable positions.
  private dormant = new Map<string, DormantEntry>();
  private static readonly DORMANT_RECHECK_MS = 1 * 60 * 60 * 1000; // 1 hour (was 6h)
  // Tracks last-known HF for danger positions. If HF is identical across consecutive
  // cycles, the position can be skipped for DANGER_SKIP_BLOCKS cycles to free slots.
  // CRITICAL: a stability skip must never become permanent. checkedAtBlock records
  // when the position was last actually fetched; once it ages past
  // DANGER_FORCE_RECHECK_BLOCKS it is force-included in the next batch regardless
  // of stability. (The old implementation skipped stable positions forever — a
  // price crash that cratered their HF without any borrower-side event was
  // invisible until the borrower transacted.)
  private lastDangerHF = new Map<string, { hf: bigint; stableFor: number; checkedAtBlock: bigint }>();
  private static readonly DANGER_SKIP_BLOCKS = 1;          // skip only 1 cycle of unchanged HF
  private static readonly DANGER_FORCE_RECHECK_BLOCKS = 40; // ~10s on Arbitrum — max blind window for any danger position

  private rebuildDangerList(): void {
    this.dangerList = [...this.positions.values()]
      .filter(p => p.healthFactor > 0n && p.healthFactor < HF_WATCH)
      .sort((a, b) => (a.healthFactor < b.healthFactor ? -1 : 1));
    this.dangerDirty = false;
  }

  private markDangerDirty(): void { this.dangerDirty = true; }

  // FIX: max positions to wake per 5-min interval — prevents thundering-herd
  // when thousands of positions were parked simultaneously (e.g. after prune).
  // This is now the FLOOR of an adaptive budget, not a hard cap — see
  // wakeBudget(). As a hard cap it silently broke the recheck window it was
  // supposed to serve as soon as the dormant tier passed ~6 000 entries.
  private static readonly MAX_DORMANT_WAKE_PER_INTERVAL = 500;
  // Upper bound on the adaptive budget — see wakeBudget(). Large enough that a
  // 100k-position watchlist still meets its recheck window, small enough that a
  // single tick can't dump the entire dormant set into the active rotation.
  private static readonly MAX_DORMANT_WAKE_CEILING = 5_000;

  // Move a healthy position (HF > HF_WATCH) from active to dormant.
  // It will be re-activated either by a live event or after DORMANT_RECHECK_MS.
  // FIX: Add random jitter (0–15 min) to dormantSince so positions parked at
  // the same time (e.g. during a full prune) don't all expire simultaneously.
  // The positive offset delays the wake deadline by up to 15 minutes, spreading
  // the load across the following recheck window instead of a single 5-min spike.
  private parkAsDormant(addr: string, hf: bigint): void {
    this.positions.delete(addr);
    this.markRotationDirty();
    this.markDangerDirty();
    this.lastDangerHF.delete(addr);
    // Opt #27 fix: use symmetric jitter (-5 to +5 min) instead of positive-only (0–15 min).
    // Positive-only offset delays wake unnecessarily by up to 15 minutes.
    const jitterMs = Math.floor(Math.random() * 10 * 60_000) - 5 * 60 * 1000; // -5 to +5 min
    this.dormant.set(addr, { lastHF: hf, dormantSince: Date.now() + jitterMs, assets: this.assetsOf(addr) });
  }

  // Reserve addresses (collateral + debt) this position is known to touch, from
  // the breakdown cache. Undefined when no breakdown was ever fetched — callers
  // must then treat the position as potentially affected by any asset.
  private assetsOf(addr: string): string[] | undefined {
    const state = this.userStates.get(addr);
    if (state) return state.reserves.length > 0 ? state.reserves.map(r => r.asset) : undefined;
    const cached = this.breakdownCache.get(addr);
    if (!cached) return undefined;
    const set = new Set<string>();
    for (const c of cached.collaterals) set.add(c.address.toLowerCase());
    for (const d of cached.debts)       set.add(d.address.toLowerCase());
    return set.size > 0 ? [...set] : undefined;
  }

  // Wake dormant positions that hold a specific collateral asset, moving them
  // from `dormant` back into the active set. SAFE to call from the trigger
  // engine's hot path (no breakdownCache mutation) — unlike wakeByCollateralAssets
  // below, which also evicts breakdownCache for active positions and would
  // blind findLocalCandidates() if called synchronously right before it.
  // Newly-woken addresses go into the priority queue so the very next
  // refreshBatch (or, if their breakdown is still cached, this same trigger
  // dispatch) picks them up immediately instead of waiting for the rotation cursor.
  wakeDormantByAssets(droppedAssetAddrs: Set<string>): number {
    if (droppedAssetAddrs.size === 0) return 0;
    // Bug #11 fix: if the position's reserve set is known, only wake it when one
    // of those reserves moved. Fall back to waking all vulnerable positions when
    // the set is unknown (parked before any breakdown was fetched).
    const HF_VULNERABLE = 140n * 10n ** 16n; // 1.40 — conservative safety margin
    const droppedLower = new Set([...droppedAssetAddrs].map(a => a.toLowerCase()));
    let woke = 0;
    for (const [addr, entry] of this.dormant) {
      if (entry.lastHF >= HF_VULNERABLE || this.badDebtDenylist.has(addr)) continue;
      // If the reserve set is known and disjoint from the dropped set, skip.
      if (entry.assets && !entry.assets.some(a => droppedLower.has(a))) continue;
      this.positions.set(addr, {
        address: addr,
        healthFactor: entry.lastHF,
        healthFactorNum: Number(entry.lastHF) / 1e18,
        totalCollateralBase: 0n,
        totalDebtBase: 0n,
      });
      this.markRotationDirty();
      if (entry.lastHF < HF_WATCH) this.markDangerDirty();
      this.dormant.delete(addr);
      this.priorityQueue.add(addr);
      woke++;
    }
    if (woke > 0) {
      logger.info(`⚡ Price-drop wake: ${woke} dormant positions re-activated (${this.dormant.size} still dormant, ${this.positions.size} active)`);
    }
    return woke;
  }

  // Wake dormant positions that hold a specific collateral asset.
  // Called when a price drop is detected for that asset — these positions may
  // now be liquidatable even though they were healthy when last checked.
  //
  // Also re-activates ACTIVE danger positions holding the dropped asset: their
  // stability-skip state (lastDangerHF) was computed at the old price, so they
  // must be re-checked immediately. They go into the priority queue so the very
  // next refreshBatch fetches them first.
  //
  // NOT safe to call from the trigger engine's synchronous hot path — the
  // second loop below evicts breakdownCache for active positions, which would
  // blind a findLocalCandidates() call made right after it in the same tick.
  // The trigger engine uses wakeDormantByAssets() instead (first half only).
  wakeByCollateralAssets(droppedAssetAddrs: Set<string>): void {
    if (droppedAssetAddrs.size === 0) return;
    const droppedLower = new Set([...droppedAssetAddrs].map(a => a.toLowerCase()));
    this.wakeDormantByAssets(droppedAssetAddrs);

    // Active danger-tier holders of a dropped asset: force immediate recheck.
    // Uses the model's asset index rather than the breakdown cache, so it covers
    // every modelled position instead of only those with a warmed breakdown.
    let prioBoosted = 0;
    const holders = new Set<string>();
    for (const asset of droppedLower) {
      const set = this.assetIndex.get(asset);
      if (set) for (const a of set) holders.add(a);
    }
    for (const address of holders) {
      const pos = this.positions.get(address);
      if (!pos || pos.healthFactor >= HF_WATCH || this.badDebtDenylist.has(address)) continue;
      this.lastDangerHF.delete(address);   // clear stability skip
      this.priorityQueue.add(address);
      prioBoosted++;
    }

    if (prioBoosted > 0) {
      logger.info(`⚡ Price-drop wake: ${prioBoosted} active danger positions prioritized for recheck`);
    }
  }
  // Called periodically by index.ts. Re-inserts them into the active rotation
  // at their last known HF so the rotation tier picks them up naturally.
  // FIX: Capped at MAX_DORMANT_WAKE_PER_INTERVAL per call to prevent thundering
  // herds when thousands of positions all expire at the same time (e.g. post-prune).
  // Remaining expired entries are processed in the next interval(s).
  // `intervalMs` is how often the caller invokes this. The cap must be derived
  // from it, not fixed: with 16 081 dormant positions and a flat 500 per 5-minute
  // tick, only 6 000 could be rechecked per hour against a DORMANT_RECHECK_MS of
  // one hour, so the effective blind window was ~2.7 hours — nearly three times
  // what the constant claims, and permanently growing with the dormant set. The
  // log said "woke 500 … 15 581 still dormant" on every single tick, which is the
  // cap binding forever rather than a burst being smoothed.
  //
  // Waking more is cheap: a wake is a map move, and the sweep that follows is
  // already bounded by positionsPerCycle. The cap's real job is absorbing a
  // post-prune spike, so keep a ceiling — just one high enough to satisfy the
  // window it advertises.
  private wakeBudget(intervalMs: number): number {
    const ticksPerWindow = Math.max(1, Math.floor(PositionTracker.DORMANT_RECHECK_MS / intervalMs));
    const needed = Math.ceil(this.dormant.size / ticksPerWindow);
    return Math.min(
      Math.max(PositionTracker.MAX_DORMANT_WAKE_PER_INTERVAL, needed),
      PositionTracker.MAX_DORMANT_WAKE_CEILING,
    );
  }

  wakeExpiredDormant(intervalMs = 5 * 60_000): void {
    const now = Date.now();
    const budget = this.wakeBudget(intervalMs);
    let woke = 0;
    let overdue = 0;
    for (const entry of this.dormant.values()) {
      if (now - entry.dormantSince >= PositionTracker.DORMANT_RECHECK_MS) overdue++;
    }
    for (const [addr, entry] of this.dormant) {
      if (woke >= budget) break;
      if (now - entry.dormantSince >= PositionTracker.DORMANT_RECHECK_MS) {
        if (!this.badDebtDenylist.has(addr)) {
          this.positions.set(addr, {
            address: addr,
            // Re-insert at last known HF. If it was 2.5 before, it might be 1.8 now —
            // the rotation check will get the real value within the next sweep.
            healthFactor: entry.lastHF,
            healthFactorNum: Number(entry.lastHF) / 1e18,
            totalCollateralBase: 0n,
            totalDebtBase: 0n,
          });
          this.markRotationDirty();
          if (entry.lastHF < HF_WATCH) this.markDangerDirty();
        }
        this.dormant.delete(addr);
        woke++;
      }
    }
    if (woke > 0) {
      const stalled = overdue > woke ? ` — ${overdue - woke} still overdue` : "";
      logger.info(
        `dormant: woke ${woke}/${budget} positions for recheck ` +
        `(${this.dormant.size} still dormant, ${this.positions.size} active)${stalled}`
      );
    }
  }

  private getDangerList(): BorrowerPosition[] {
    if (this.dangerDirty) this.rebuildDangerList();
    return this.dangerList;
  }

  private getRotationList(): string[] {
    if (this.rotationDirty || this.rotationList.length !== this.positions.size) {
      this.rotationList = [...this.positions.keys()];
      this.rotationDirty = false;
      // Clamp cursor so it stays in bounds after shrinkage
      if (this.rotationCursor >= this.rotationList.length) {
        this.rotationCursor = 0;
      }
    }
    return this.rotationList;
  }

  private markRotationDirty(): void {
    this.rotationDirty = true;
  }

  // FIX 4.2: Breakdown result cache — keyed by lowercase address.
  // Populated by getAssetBreakdown, invalidated by handleRawLog for that address.
  private breakdownCache = new Map<string, BreakdownEntry>();
  // Bounded — breakdownCache previously had no eviction at all and grew for the
  // life of the process.
  private static readonly BREAKDOWN_CACHE_MAX = 20_000;

  // ── In-memory model ────────────────────────────────────────────────────────
  private userStates = new Map<string, UserState>();
  // assetLower → borrowers touching it. Lets a price move scan only the
  // positions that asset can possibly affect instead of the whole watchlist.
  private assetIndex = new Map<string, Set<string>>();

  private getProvider(): ethers.Provider { return this._getProvider(); }

  constructor(
    private _getProvider: () => ethers.Provider,
    public  readonly reserves: ReserveRegistry,
  ) {}

  // ── Model maintenance ──────────────────────────────────────────────────────

  private setUserState(address: string, state: UserState): void {
    this.clearAssetIndex(address);
    // Balances changed, so any cached health factor for this address describes a
    // position that no longer exists. The skip bound must never be applied to it.
    this.localHfCache.delete(address);
    this.userStates.set(address, state);
    for (const r of state.reserves) {
      let set = this.assetIndex.get(r.asset);
      if (!set) { set = new Set(); this.assetIndex.set(r.asset, set); }
      set.add(address);
    }
  }

  private clearAssetIndex(address: string): void {
    const prev = this.userStates.get(address);
    if (!prev) return;
    for (const r of prev.reserves) {
      const set = this.assetIndex.get(r.asset);
      if (set) { set.delete(address); if (set.size === 0) this.assetIndex.delete(r.asset); }
    }
  }

  private dropUserState(address: string): void {
    this.clearAssetIndex(address);
    this.userStates.delete(address);
    this.localHfCache.delete(address);
  }

  // Bounded write path for the legacy breakdown cache. It previously had no
  // eviction whatsoever and grew for the life of the process; entries are only
  // ever removed on an event for that address. Evicts oldest-inserted first
  // (Map preserves insertion order).
  private setBreakdownCache(address: string, entry: BreakdownEntry): void {
    if (this.breakdownCache.size >= PositionTracker.BREAKDOWN_CACHE_MAX && !this.breakdownCache.has(address)) {
      const overflow = this.breakdownCache.size - PositionTracker.BREAKDOWN_CACHE_MAX + 1;
      let removed = 0;
      for (const key of this.breakdownCache.keys()) {
        this.breakdownCache.delete(key);
        if (++removed >= overflow) break;
      }
    }
    this.breakdownCache.set(address, entry);
  }

  hasUserState(address: string): boolean { return this.userStates.has(address.toLowerCase()); }
  get modelSize(): number { return this.userStates.size; }

  // Fetch scaled balances for a set of borrowers and load them into the model.
  // One multicall per MODEL_USERS_PER_MC addresses; nothing else is needed to
  // make those positions fully evaluable in memory from then on.
  private static readonly MODEL_USERS_PER_MC = 20;

  async refreshUserStates(addresses: string[]): Promise<number> {
    const targets = [...new Set(addresses.map(a => a.toLowerCase()))]
      .filter(a => !this.badDebtDenylist.has(a));
    if (targets.length === 0) return 0;

    const chunks: string[][] = [];
    for (let i = 0; i < targets.length; i += PositionTracker.MODEL_USERS_PER_MC) {
      chunks.push(targets.slice(i, i + PositionTracker.MODEL_USERS_PER_MC));
    }

    let loaded = 0;
    const emodeIds = new Set<number>();

    const settled = await Promise.allSettled(chunks.map(async chunk => {
      const results: Array<{ success: boolean; returnData: string }> = await this.multicall.tryAggregate(
        false,
        chunk.map(user => ({
          target:   UI_POOL_DATA_PROVIDER,
          callData: UI_IFACE.encodeFunctionData("getUserReservesData", [POOL_ADDRESSES_PROVIDER, user]),
        })),
      );
      return { chunk, results };
    }));

    for (const s of settled) {
      if (s.status !== "fulfilled") continue;
      const { chunk, results } = s.value;
      for (let i = 0; i < chunk.length; i++) {
        const address = chunk[i]!;
        const r = results[i];
        if (!r?.success || r.returnData === "0x") continue;
        try {
          const decoded = UI_IFACE.decodeFunctionResult("getUserReservesData", r.returnData);
          const rows = decoded[0] as Array<{
            underlyingAsset: string; scaledATokenBalance: bigint;
            usageAsCollateralEnabledOnUser: boolean; scaledVariableDebt: bigint;
          }>;
          const emodeId = Number(decoded[1]);
          const snapshots: UserReserveSnapshot[] = [];
          for (const row of rows) {
            if (row.scaledATokenBalance === 0n && row.scaledVariableDebt === 0n) continue;
            snapshots.push({
              asset:               row.underlyingAsset.toLowerCase(),
              scaledATokenBalance: row.scaledATokenBalance,
              usageAsCollateral:   row.usageAsCollateralEnabledOnUser,
              scaledVariableDebt:  row.scaledVariableDebt,
            });
          }
          this.setUserState(address, { reserves: snapshots, emodeId, fetchedAt: Date.now() });
          const pos = this.positions.get(address);
          if (pos) pos.userEmodeCategoryId = emodeId;
          if (emodeId > 0) emodeIds.add(emodeId);
          loaded++;
        } catch (e: any) {
          logger.debug(`refreshUserStates decode ${address}: ${e.message}`);
        }
      }
    }

    // E-mode categories are needed before those users' HFs can be computed
    // correctly; they are cached permanently after the first fetch.
    if (emodeIds.size > 0) {
      await this.reserves.ensureEModes(emodeIds).catch((e: any) =>
        logger.debug(`ensureEModes failed: ${e?.message ?? e}`)
      );
    }
    return loaded;
  }

  // Background model fill — brings watched positions that have no model entry
  // into the model, at a bounded rate. Because entries are invalidated only by
  // events, this is a one-time cost per position: after the initial fill the
  // model is maintained for free and steady-state RPC goes to ~zero.
  private _fillInProgress = false;

  async fillModel(maxAddresses: number): Promise<number> {
    if (this._fillInProgress) return 0;
    this._fillInProgress = true;
    try {
      const todo: string[] = [];
      const want = (addr: string) => !this.userStates.has(addr) && !this.badDebtDenylist.has(addr);

      // Active positions first — they are closest to liquidation.
      for (const addr of this.positions.keys()) {
        if (!want(addr)) continue;
        todo.push(addr);
        if (todo.length >= maxAddresses) break;
      }

      // Then DORMANT positions. These were the blind spot: the startup prune
      // parks everything above HF_WATCH before the model ever sees it, so ~16k
      // positions had no model entry and were therefore invisible to
      // findLocalCandidates — the trigger engine could only ever fire on the few
      // hundred active ones. They were reachable solely via wakeExpiredDormant,
      // which at 500 per 5 minutes takes hours to cycle a list that size.
      //
      // Modelling them costs one multicall per 20 addresses, ONCE: scaled
      // balances only change when the borrower transacts, and an Aave event
      // drops the entry. After that the whole watchlist is evaluated in memory
      // on every price tick, which is the entire point of the model — and
      // dormant positions are exactly the ones a crash converts into
      // opportunities.
      if (todo.length < maxAddresses) {
        for (const addr of this.dormant.keys()) {
          if (!want(addr)) continue;
          todo.push(addr);
          if (todo.length >= maxAddresses) break;
        }
      }

      if (todo.length === 0) return 0;
      const loaded = await this.refreshUserStates(todo);
      logger.debug(
        `model fill: +${loaded} (model=${this.userStates.size}/${this.positions.size + this.dormant.size})`
      );
      return loaded;
    } finally {
      this._fillInProgress = false;
    }
  }

  // Model coverage, for the heartbeat. Detection only reaches positions that
  // have a model entry, so this is the number that says how much of the
  // watchlist the trigger engine can actually see.
  modelCoverage(): { modelled: number; total: number } {
    return { modelled: this.userStates.size, total: this.positions.size + this.dormant.size };
  }

  // Live index updates, free of charge — see ReserveRegistry.
  handleReserveDataUpdated(log: ethers.Log): void {
    this.reserves.applyReserveDataUpdated(log);
  }

  // ── Cached contract instances ─────────────────────────────────────────────
  // Contracts are created once and cached. When the provider changes (reconnect),
  // the cache is invalidated and rebuilt on next access.
  // Previously: `get multicall()` etc. created new ethers.Contract on every call.
  // At 1.7 cycles/sec that was ~7 Contract allocations/sec with ABI parsing each time.
  private _contractProvider: ethers.Provider | null = null;
  private _pool!:           ethers.Contract;
  private _dataProvider!:   ethers.Contract;
  private _uiDataProvider!: ethers.Contract;
  private _multicall!:      ethers.Contract;

  private ensureContracts(): void {
    const p = this.getProvider();
    if (p === this._contractProvider) return;  // provider unchanged — reuse cached instances
    this._contractProvider = p;
    this._pool           = new ethers.Contract(AAVE_POOL,             AAVE_POOL_ABI,             p);
    this._dataProvider   = new ethers.Contract(AAVE_DATA_PROVIDER,    DATA_PROVIDER_ABI,         p);
    this._uiDataProvider = new ethers.Contract(UI_POOL_DATA_PROVIDER, UI_POOL_DATA_PROVIDER_ABI, p);
    this._multicall      = new ethers.Contract(MULTICALL3,            MULTICALL3_ABI,            p);
  }

  private get pool():           ethers.Contract { this.ensureContracts(); return this._pool;           }
  private get dataProvider():   ethers.Contract { this.ensureContracts(); return this._dataProvider;   }
  private get uiDataProvider(): ethers.Contract { this.ensureContracts(); return this._uiDataProvider; }
  private get multicall():      ethers.Contract { this.ensureContracts(); return this._multicall;      }

  // ── Upsert ─────────────────────────────────────────────────────────────────
  private upsert(addr: string, type?: string, priority = false): void {
    const key = addr.toLowerCase();
    if (this.badDebtDenylist.has(key)) {
      // Only allow re-entry on a Borrow event (new debt = possibly new collateral)
      if (type && type.includes("Borrow")) {
        this.badDebtDenylist.delete(key);
        logger.info(`Bad-debt denylist: ${key} re-admitted on Borrow event`);
      } else {
        logger.debug(`Bad-debt denylist: blocked re-insertion of ${key} via "${type ?? "unknown"}"`);
        return;
      }
    }
    if (!this.positions.has(key)) {
      // If the address was dormant (parked as healthy), wake it immediately —
      // a live event means its position just changed and HF may have moved.
      if (this.dormant.has(key)) {
        const entry = this.dormant.get(key)!;
        this.dormant.delete(key);
        this.positions.set(key, {
          address: key, healthFactor: entry.lastHF, healthFactorNum: Number(entry.lastHF) / 1e18,
          totalCollateralBase: 0n, totalDebtBase: 0n,
        });
        logger.debug(`dormant woke (event): ${key}`);
      } else {
        this.positions.set(key, {
          address: key, healthFactor: HF_SEED, healthFactorNum: 1.10,
          totalCollateralBase: 0n, totalDebtBase: 0n,
        });
      }
      this.markRotationDirty();
      logger.debug(`${type ?? "new"}: ${key}`);
    }
    if (priority) this.priorityQueue.add(key);
  }

  // ── Raw log handler ────────────────────────────────────────────────────────
  handleRawLog(rawLog: any, source = "ws"): void {
    const topic = Array.isArray(rawLog.topics) ? rawLog.topics[0] : undefined;
    if (!topic) return;
    try {
      const parsed = IFACE.parseLog({ topics: rawLog.topics as string[], data: rawLog.data as string });
      if (!parsed) return;
      let addr: string | undefined;
      switch (topic) {
        case TOPIC_BORROW:           addr = parsed.args[2]; break;
        case TOPIC_SUPPLY:           addr = parsed.args[2]; break;
        case TOPIC_REPAY:            addr = parsed.args[1]; break;
        case TOPIC_WITHDRAW:         addr = parsed.args[1]; break;
        case TOPIC_LIQUIDATION_CALL: addr = parsed.args[2]; break;
        case TOPIC_COLLATERAL_ON:    addr = parsed.args[1]; break;
        case TOPIC_COLLATERAL_OFF:   addr = parsed.args[1]; break;
      }
      if (addr) {
        const key = addr.toLowerCase();
        logger.debug(`${source} ${parsed.name}: ${key}`);
        this.upsert(key, `live:${parsed.name}`, true);
        // FIX 4.2: Invalidate breakdown cache on any event for this address
        // so the next breakdown call gets fresh data immediately.
        this.breakdownCache.delete(key);
        // The model holds SCALED balances, which move only when the user
        // transacts — which is exactly what just happened. Dropping the entry
        // here is the entire invalidation story for the model.
        this.dropUserState(key);
        this.lastDangerHF.delete(key);  // force re-check on next cycle after any event
        if (topic === TOPIC_LIQUIDATION_CALL) {
          // Someone else liquidated this borrower — tell the executor so it can
          // distinguish "beaten by a competitor" from "our own tx failed".
          // args[5] is the non-indexed `liquidator`; skip our own contract.
          const liquidator = (parsed.args[5] as string | undefined)?.toLowerCase();
          if (!this.ownLiquidator || liquidator !== this.ownLiquidator) {
            try { this.onExternalLiquidation?.(key); } catch { /* never throw from log path */ }
          }
        }
      }
    } catch { /* non-matching log */ }
  }

  // ── Subgraph ───────────────────────────────────────────────────────────────
  //
  // Returns { count, clean } where clean=true means every seeded address has
  // confirmed active debt (balance_gt: 0) so the caller can skip pruneStale().
  private async trySubgraph(): Promise<{ count: number; clean: boolean }> {
    if (!AAVE_SUBGRAPH_URL) {
      logger.warn("No THEGRAPH_API_KEY — skipping subgraph");
      return { count: 0, clean: false };
    }
    logger.info(`Subgraph: ${AAVE_SUBGRAPH_URL.replace(/api\/[^/]+\//, "api/***/")}`);
    const probe = await this.probeSubgraphSchema();
    logger.info(`Subgraph schema: using "${probe}" entity`);
    if (probe === "positions") return { count: await this.trySubgraphViaPositions(), clean: true  };
    if (probe === "borrows")   return { count: await this.trySubgraphViaBorrows(),   clean: false };
    if (probe === "accounts")  return { count: await this.trySubgraphViaAccounts(),  clean: false };
    logger.warn("Subgraph: could not identify schema entity — falling back to on-chain scan");
    return { count: 0, clean: false };
  }

  private async probeSubgraphSchema(): Promise<"positions" | "borrows" | "accounts" | "none"> {
    const probes: Array<{ entity: "positions" | "borrows" | "accounts"; query: string }> = [
      // Try the active-positions query first — it returns only addresses with live debt,
      // so a successful seed from this schema needs no follow-up pruneStale().
      { entity: "positions", query: `{ positions(first: 1, where: { side: BORROWER, balance_gt: "0" }) { id account { id } } }` },
      { entity: "borrows",   query: `{ borrows(first: 1) { id account { id } } }` },
      { entity: "accounts",  query: `{ accounts(first: 1, where: { borrowCount_gt: 0 }) { id } }` },
    ];
    for (const { entity, query } of probes) {
      try {
        const resp = await axios.post(AAVE_SUBGRAPH_URL, { query }, { timeout: 10_000 });
        if (!resp.data?.errors?.length && resp.data?.data != null) {
          const key = Object.keys(resp.data.data)[0];
          if (key && Array.isArray(resp.data.data[key])) return entity;
        }
      } catch { /* try next */ }
    }
    return "none";
  }

  // Active-positions query — only returns borrowers with balance_gt: 0, meaning
  // confirmed live debt right now. Benefits vs the old borrows/accounts queries:
  //   1. Zero dead addresses — no need for pruneStale() after this seed
  //   2. One account with N open borrow positions produces N rows but we only
  //      add the account address once (de-duplication via `seen` set)
  //   3. Cursor pagination on position `id` (not account id) is stable even
  //      when new positions are opened mid-pagination
  //   4. Minimal payload — only id + account.id, no market/balance fields we don't use
  private async trySubgraphViaPositions(): Promise<number> {
    const seen = new Set<string>();
    let lastId = "", page = 0;
    while (true) {
      const whereClause = lastId
        ? `where: { side: BORROWER, balance_gt: "0", id_gt: "${lastId}" }`
        : `where: { side: BORROWER, balance_gt: "0" }`;
      const query = `{ positions(first: 1000, ${whereClause}, orderBy: id, orderDirection: asc) { id account { id } } }`;
      try {
        const resp = await axios.post(AAVE_SUBGRAPH_URL, { query }, { timeout: 20_000 });
        if (resp.data?.errors?.length) {
          logger.warn(`positions query error: ${resp.data.errors[0]?.message}`);
          return seen.size;
        }
        const items: { id: string; account: { id: string } }[] = resp.data?.data?.positions ?? [];
        if (!items.length) break;
        for (const item of items) {
          const addr = item.account?.id?.toLowerCase();
          if (addr && !seen.has(addr)) { seen.add(addr); this.upsert(addr, "subgraph"); }
        }
        lastId = items[items.length - 1]!.id;
        page++;
        if (page % 10 === 0) logger.info(`  Subgraph (positions): ${seen.size} active borrowers (page ${page})…`);
        if (items.length < 1000) break;
        await sleep(20);
      } catch (e: any) { logger.warn(`Subgraph positions page failed: ${e.message}`); return seen.size; }
    }
    logger.info(`Subgraph done: ${seen.size} unique active borrowers`);
    return seen.size;
  }

  private async trySubgraphViaAccounts(): Promise<number> {
    const seen = new Set<string>();
    let lastId = "", page = 0;
    while (true) {
      const where = lastId ? `where: { borrowCount_gt: 0, id_gt: "${lastId}" }` : `where: { borrowCount_gt: 0 }`;
      const query = `{ accounts(first: 1000, ${where}, orderBy: id, orderDirection: asc) { id } }`;
      try {
        const resp = await axios.post(AAVE_SUBGRAPH_URL, { query }, { timeout: 20_000 });
        if (resp.data?.errors?.length) { logger.warn(`accounts query error: ${resp.data.errors[0]?.message}`); return seen.size; }
        const items: { id: string }[] = resp.data?.data?.accounts ?? [];
        if (!items.length) break;
        for (const item of items) { const addr = item.id?.toLowerCase(); if (addr) { seen.add(addr); this.upsert(addr, "subgraph"); } }
        lastId = items[items.length - 1]!.id;
        page++;
        if (page % 10 === 0) logger.info(`  Subgraph (accounts): ${seen.size} borrowers (page ${page})…`);
        if (items.length < 1000) break;
        await sleep(80);
      } catch (e: any) { logger.warn(`accounts page failed: ${e.message}`); return seen.size; }
    }
    logger.info(`Subgraph done: ${seen.size} unique borrowers`);
    return seen.size;
  }

  private async trySubgraphViaBorrows(): Promise<number> {
    const seen = new Set<string>();
    let lastId = "", page = 0;
    while (true) {
      const where = lastId ? `where: { id_gt: "${lastId}" }` : "";
      const query = `{ borrows(first: 1000, ${where}, orderBy: id, orderDirection: asc) { id account { id } } }`;
      try {
        const resp = await axios.post(AAVE_SUBGRAPH_URL, { query }, { timeout: 20_000 });
        if (resp.data?.errors?.length) { logger.warn(`borrows query failed: ${resp.data.errors[0]?.message}`); return seen.size; }
        const items: { id: string; account: { id: string } }[] = resp.data?.data?.borrows ?? [];
        if (!items.length) break;
        for (const item of items) { const addr = item.account?.id?.toLowerCase(); if (addr && !seen.has(addr)) { seen.add(addr); this.upsert(addr, "subgraph"); } }
        lastId = items[items.length - 1]!.id;
        page++;
        if (page % 10 === 0) logger.info(`  Subgraph (borrows): ${seen.size} borrowers (page ${page})…`);
        if (items.length < 1000) break;
        await sleep(80);
      } catch (e: any) { logger.warn(`Subgraph borrows failed: ${e.message}`); return seen.size; }
    }
    return seen.size;
  }

  // ── On-chain scan ──────────────────────────────────────────────────────────
  // FIX: SCAN_CHUNK reduced from 50 000 to 2 000 (most RPCs reject > 10 000)
  private async scanEvents(fromBlock: bigint, toBlock: bigint): Promise<number> {
    let loaded = 0, block = fromBlock, chunkSize = SCAN_CHUNK;
    logger.info(`  Scanning ${fromBlock}→${toBlock} (${((toBlock - fromBlock) / 1000n).toLocaleString()}k blocks)`);
    while (block <= toBlock) {
      const to = block + chunkSize - 1n <= toBlock ? block + chunkSize - 1n : toBlock;
      try {
        const logs = await this.getProvider().getLogs({ address: AAVE_POOL, topics: [TOPIC_BORROW], fromBlock: block, toBlock: to });
        for (const log of logs) {
          try { const p = IFACE.parseLog(log); const addr: string = p?.args[2]; if (addr) { this.upsert(addr.toLowerCase(), "scan"); loaded++; } } catch { /* skip */ }
        }
        if (logs.length > 0) logger.debug(`  ${block}→${to}: ${logs.length} borrows (${this.positions.size} unique)`);
        block = to + 1n;
        if (chunkSize < SCAN_CHUNK) chunkSize = SCAN_CHUNK;
        await sleep(80);
      } catch (e: any) {
        // Some RPC plans reject eth_getLogs outright as an "archive" request
        // (Chainstack returns -32002) no matter how narrow the range. Retrying
        // and halving the chunk cannot help, and logs one 403 per chunk for the
        // whole scan — bail out and let live subscriptions carry the load.
        if (isArchiveRestricted(e)) {
          logger.warn(
            `  Scan aborted at block ${block}: this RPC plan does not allow eth_getLogs ` +
            `(historical scan unavailable). Live event subscriptions are unaffected; ` +
            `seed from the subgraph by setting THEGRAPH_API_KEY.`
          );
          return loaded;
        }
        if (chunkSize > 100n) { chunkSize = chunkSize / 2n; }
        else { logger.warn(`  Scan ${block}→${to} failed: ${e.message}`); block = to + 1n; }
      }
    }
    return loaded;
  }

  // ── Prune stale positions ─────────────────────────────────────────────────
  // Called once after the initial seed (subgraph or cache load) to evict all
  // addresses that have zero debt or HF > HF_WATCH. Uses Multicall3 in chunks
  // of 500, dispatched PRUNE_CONCURRENCY at a time so the entire 180k list is
  // swept in ~30-60 RPC calls instead of 360 sequential ones.
  //
  // PERF: Raised chunk size 500→1000 (Tenderly/Alchemy handle it fine) and
  // added PRUNE_CONCURRENCY=8 — 8 concurrent multicalls × 1000 addresses each
  // = 8000 addresses per "wave". At ~100ms per call this cuts 180k prune from
  // ~3 minutes down to ~25 seconds.
  async pruneStale(): Promise<void> {
    const CHUNK       = CONFIG.pruneChunk;        // default 500, override via PRUNE_CHUNK env
    const CONCURRENCY = CONFIG.pruneConcurrency;  // default 8, override via PRUNE_CONCURRENCY env
    // BUG FIX: Snapshot the address list at prune-start.
    // We only prune the positions that existed when pruneStale() was called —
    // new addresses added by live events during the prune are left untouched.
    const addrs = [...this.positions.keys()];
    const total = addrs.length;
    logger.info(`Prune: sweeping ${total} positions — chunks=${CHUNK} concurrency=${CONCURRENCY}…`);

    const poolIface = new ethers.Interface(AAVE_POOL_ABI);
    let pruned    = 0;
    let checked   = 0;

    // Process one chunk — returns number pruned from this chunk.
    // If the multicall fails (e.g. gas limit exceeded), splits the chunk
    // in half and retries recursively down to MIN_CHUNK size.
    const MIN_CHUNK = 25;  // floor for chunk-split retry
    const processChunk = async (chunk: string[], depth = 0): Promise<number> => {
      const calls = chunk.map(addr => ({
        target:   AAVE_POOL,
        callData: poolIface.encodeFunctionData("getUserAccountData", [addr]),
      }));
      try {
        const results: Array<{ success: boolean; returnData: string }> =
          await this.multicall.tryAggregate(false, calls);
        let chunkPruned = 0;
        for (let j = 0; j < chunk.length; j++) {
          const addr   = chunk[j]!;
          const result = results[j];
          if (!result?.success || result.returnData === "0x") continue;
          try {
            const d    = poolIface.decodeFunctionResult("getUserAccountData", result.returnData);
            const debt = d.totalDebtBase as bigint;
            const hf   = d.healthFactor as bigint;
            if (debt < MIN_DEBT_USD8) {
              this.positions.delete(addr);
              this.dropUserState(addr);   // else the model outlives the position
              this.markRotationDirty();
              this.markDangerDirty(); // FIX: addr may be in dangerList
              chunkPruned++;
            } else if (hf > HF_WATCH) {
              this.parkAsDormant(addr, hf);
              chunkPruned++;
            } else {
              const pos = this.positions.get(addr);
              if (pos) {
                pos.healthFactor        = hf;
                pos.healthFactorNum     = Number(hf) / 1e18;
                pos.totalDebtBase       = debt;
                pos.totalCollateralBase = d.totalCollateralBase as bigint;
              }
            }
          } catch { /* leave in place if decode fails */ }
        }
        return chunkPruned;
      } catch (e: any) {
        if (e.code === 'UNSUPPORTED_OPERATION' || /provider destroyed|cancelled request/i.test(e.message)) {
          throw e;  // re-throw so wave loop's provider check catches it cleanly
        }
        // Chunk-split retry: if the multicall itself failed (e.g. gas limit exceeded
        // on Arbitrum), split the chunk in half and retry each sub-chunk. This prevents
        // a single oversized chunk from causing "0 removed" prune runs.
        if (chunk.length > MIN_CHUNK && depth < 3) {
          const mid = Math.ceil(chunk.length / 2);
          logger.warn(`Prune chunk (${chunk.length}) failed at depth ${depth}: ${e.message} — splitting into ${mid}+${chunk.length - mid}`);
          let subPruned = 0;
          for (const sub of [chunk.slice(0, mid), chunk.slice(mid)]) {
            try {
              subPruned += await processChunk(sub, depth + 1);
            } catch {
              // if a sub-chunk also fails, skip it — at least we tried
            }
          }
          return subPruned;
        }
        logger.warn(`Prune chunk failed (depth ${depth}): ${e.message} — skipping ${chunk.length} addresses`);
        return 0;
      }
    };

    // Split into chunks, then dispatch CONCURRENCY chunks at a time
    const chunks: string[][] = [];
    for (let i = 0; i < addrs.length; i += CHUNK) {
      chunks.push(addrs.slice(i, i + CHUNK));
    }

    for (let w = 0; w < chunks.length; w += CONCURRENCY) {
      // Abort if provider was destroyed mid-prune — remaining chunks will be
      // handled by the normal refresh cycle once the new provider is up.
      // getBlockNumber, not getNetwork: providers are constructed with
      // staticNetwork:true, so getNetwork() resolves from a cached value and
      // never touches the RPC — it can't detect a dead connection.
      try { await this.getProvider().getBlockNumber(); } catch {
        logger.warn(`Prune aborted at ${checked}/${total} — provider destroyed, resuming via normal cycle`);
        break;
      }

      const wave = chunks.slice(w, w + CONCURRENCY);
      const results = await Promise.allSettled(wave.map(processChunk));
      for (const r of results) {
        if (r.status === "fulfilled") pruned += r.value;
      }
      checked += wave.reduce((s, c) => s + c.length, 0);

      // Progress + checkpoint every wave
      const pct = ((checked / total) * 100).toFixed(0);
      logger.info(`Prune progress: ${checked}/${total} (${pct}%) checked, ${pruned} removed, ${this.positions.size} active, ${this.dormant.size} dormant`);
      // Checkpoint the active (post-prune) watchlist — NOT the full borrower cache.
      // Saving mid-prune lets a crash restart quickly without re-pruning from scratch,
      // while the full cache (borrowers-cache.json) remains intact with all known borrowers.
      if (this.lastEventBlock > 0n) {
        saveCache(this.lastEventBlock, [...this.positions.keys()], this.dormant);
      }

      // Yield between waves — give the provider breathing room and keep
      // block events responsive. 20ms is enough for rate-limit headroom.
      if (w + CONCURRENCY < chunks.length) await sleep(20);
    }

    logger.info(`Prune complete: removed ${pruned} stale positions, ${this.positions.size} active, ${this.dormant.size} dormant`);

    // Save the final post-prune active watchlist.
    // The full borrower cache (borrowers-cache.json) is intentionally NOT updated here —
    // it must keep every known borrower so restarts can restore positions that are
    // healthy today but may become liquidatable after a market move.
    try {
      const currentBlock = BigInt(await this.getProvider().getBlockNumber());
      this.lastEventBlock = currentBlock;
      saveCache(currentBlock, [...this.positions.keys()], this.dormant);
    } catch {
      if (this.lastEventBlock > 0n) saveCache(this.lastEventBlock, [...this.positions.keys()], this.dormant);
    }
  }

  // ── Seed ───────────────────────────────────────────────────────────────────
  async seed(): Promise<{ skipPrune: boolean }> {
    logger.info("Seeding borrower list…");
    const latest = BigInt(await this.getProvider().getBlockNumber());
    this.lastEventBlock = latest;
    this.currentBlock   = latest;

    const fullCache   = loadFullCache();
    const activeCache = loadCache();

    if (fullCache) {
      // ── Fast restart path ───────────────────────────────────────────────
      // Step 1: restore dormant map from active cache before seeding active positions,
      // so upsert() can correctly wake dormant entries that got live events since last run.
      if (activeCache?.dormant) {
        const now = Date.now();
        for (const entry of activeCache.dormant) {
          const addr = entry[0]!;
          const hfHex = entry[1]!;
          const dormantSince = entry[2]!;
          // Slot 3 is the position's reserve set. Older caches wrote a single
          // topCollateral string here — normalise both shapes.
          const rawAssets = entry[3];
          const assets = Array.isArray(rawAssets)
            ? rawAssets.map(a => a.toLowerCase())
            : (typeof rawAssets === "string" ? [rawAssets.toLowerCase()] : undefined);
          // Drop entries that have already expired (past their recheck window) —
          // they'll be re-seeded from the full cache and checked on first rotation.
          if (now - dormantSince < PositionTracker.DORMANT_RECHECK_MS) {
            this.dormant.set(addr, { lastHF: BigInt("0x" + hfHex), dormantSince, assets });
          }
        }
        if (this.dormant.size > 0) {
          logger.info(`Dormant restored: ${this.dormant.size} positions with remaining recheck window`);
        }
      }

      // Step 2: seed from the active (post-prune) cache first for immediate coverage
      if (activeCache) {
        for (const addr of activeCache.borrowers) this.upsert(addr, "cache");
        logger.info(`Active cache: seeded ${this.positions.size} positions`);
      }

      // Step 3: merge the full borrower list on top.
      // Addresses already in positions are skipped by upsert (no-op).
      // Addresses only in full cache (healthy at last prune) re-enter at HF_SEED
      // and get a real HF on their first rotation check.
      const beforeMerge = this.positions.size;
      for (const addr of fullCache.borrowers) this.upsert(addr, "cache");
      const merged = this.positions.size - beforeMerge;
      if (merged > 0) {
        logger.info(`Full cache merge: +${merged} previously-healthy positions restored (${this.positions.size} total)`);
      }

      // Step 4: incremental scan to catch new borrows since the full cache was saved
      const cacheBlock = BigInt(fullCache.scannedUpToBlock);
      if (latest > cacheBlock) {
        logger.info(`Incremental scan: ${cacheBlock}→${latest} (${((latest - cacheBlock) / 1000n).toLocaleString()}k blocks)`);
        await this.scanEvents(cacheBlock + 1n, latest);
      }

      saveFullCache(latest, [...this.positions.keys()]);
      saveCache(latest, [...this.positions.keys()], this.dormant);
      logger.info(`Ready: ${this.positions.size} borrowers, ${this.dormant.size} dormant`);
      return { skipPrune: false };
    }

    // ── First-run path (no cache on disk) ───────────────────────────────────
    const { count: n, clean } = await this.trySubgraph();
    if (n > 0) {
      saveFullCache(latest, [...this.positions.keys()]);
      saveCache(latest, [...this.positions.keys()], this.dormant);
      if (clean) {
        logger.info(`Ready: ${this.positions.size} active borrowers from subgraph (skipping prune — data is clean)`);
      } else {
        logger.info(`Ready: ${this.positions.size} borrowers from subgraph`);
      }
      return { skipPrune: clean };
    }

    logger.warn("Full on-chain scan (15-25 min, one-time)…");
    await this.scanEvents(AAVE_DEPLOY_BLOCK, latest);
    saveFullCache(latest, [...this.positions.keys()]);
    saveCache(latest, [...this.positions.keys()], this.dormant);
    logger.info(`Ready: ${this.positions.size} borrowers`);
    return { skipPrune: false };
  }

  // ── Live monitoring ────────────────────────────────────────────────────────
  // Called once after seed(), and again after every reconnect.
  // Performs a gap-fill for missed events, then hooks into ethers' own
  // event system for ongoing log delivery.
  //
  // We use wsProvider.on(filter, handler) instead of raw eth_subscribe because:
  //  1. ethers v6 manages the subscription lifecycle internally and re-subscribes
  //     on reconnect automatically.
  //  2. The old raw WS message router (addEventListener) used the browser WebSocket
  //     API which doesn't exist in Node.js — ws.WebSocket uses EventEmitter (.on).
  //  3. Calling removeAllListeners() before adding new ones prevents duplicate
  //     handlers accumulating across reconnects.
  //
  // onSubId kept in signature for backward compat but no longer used.
  private logFilter: ethers.Filter | null = null;
  private reserveFilter: ethers.Filter | null = null;
  private activeWsProvider: ethers.WebSocketProvider | null = null;

  // Ceiling on how many positions a single gap recovery will re-read. The active
  // set is a few hundred in steady state; this only guards the pathological case
  // where a reconnect lands before the startup prune has finished.
  private static readonly GAP_RECOVERY_MAX = 2_000;

  // Called when a gap could not be replayed from logs. Aave events are what
  // invalidate the model and the breakdown cache, so an unreplayed gap leaves
  // both silently stale for any borrower who transacted during it — a wrong
  // health factor computed with total confidence, which is the worst shape of
  // error this bot can hold.
  //
  // The state is REFRESHED rather than dropped. Dropping would blind
  // findLocalCandidates until the background fill caught up, which is a real
  // detection hole; refreshUserStates overwrites in place, so the trigger keeps
  // working throughout and simply becomes correct again once it returns.
  //
  // Only the ACTIVE set is covered. Refreshing the ~16k dormant positions would
  // cost minutes of call budget, and they are healthy by construction — one that
  // turned dangerous during the gap is picked up by the dormant recheck cycle.
  private recoverFromUnrecoveredGap(): void {
    const active = [...this.positions.keys()];
    if (active.length === 0) return;
    if (active.length > PositionTracker.GAP_RECOVERY_MAX) {
      logger.warn(
        `Gap recovery: ${active.length} active positions exceeds the ${PositionTracker.GAP_RECOVERY_MAX} ` +
        `cap — skipping bulk refresh (startup prune has probably not finished; the sweep will re-read them)`
      );
      return;
    }
    for (const addr of active) {
      this.breakdownCache.delete(addr);
      this.priorityQueue.add(addr);
    }
    this.markDangerDirty();
    logger.warn(`Gap recovery: re-reading model state for ${active.length} active positions`);
    // Fire-and-forget: this must not delay re-subscribing to the new socket.
    this.refreshUserStates(active)
      .then(n => logger.info(`Gap recovery: refreshed ${n}/${active.length} model entries`))
      .catch(e => logger.warn(`Gap recovery refresh failed: ${e?.message ?? e}`));
  }

  // `isReconnect` distinguishes a socket coming back from the initial startup
  // call. It matters because the unrecovered-gap recovery below re-reads the
  // active set, and at startup that set is the whole un-pruned seed (76k on this
  // deployment) rather than the few hundred it settles at.
  async startEventMonitoring(
    wsProvider: ethers.WebSocketProvider,
    onSubId: (id: string) => void,
    isReconnect = false,
  ): Promise<void> {
    // ── Gap-fill: catch events missed during disconnect ───────────────────
    // Reads go over the HTTP read provider, not the WebSocket: this is a bulk
    // query, and the whole point of the WS/HTTP split is to keep subscription
    // traffic off the same socket as bulk reads.
    try {
      const readProvider = this.getProvider();
      const current = BigInt(await readProvider.getBlockNumber());
      if (current > this.lastEventBlock) {
        // Bug #14 fix: increased gap-fill window from 2,000 to 10,000 blocks.
        // If WS is disconnected for >2,000 blocks (~55 min), events in the gap
        // were permanently missed. 10,000 blocks (~4.6 hours) is a much safer window.
        const fromBlock = current - this.lastEventBlock > 10_000n
          ? current - 10_000n   // cap — older gaps covered by position cache
          : this.lastEventBlock;
        logger.info(`Gap-filling ${fromBlock}→${current}…`);
        // Chunked: the previous single unchunked request could span the full
        // 10,000 blocks. Providers cap getLogs by block range and by result
        // count (Chainstack rejects wide ranges outright), so one oversized
        // request would fail and silently drop the entire gap.
        let total = 0;
        // Highest block confirmed actually READ, or null if nothing was. Null
        // rather than `fromBlock - 1n`: when the 10k cap moves fromBlock forward,
        // that expression sits ahead of the old watermark, so a total refusal
        // would still advance it and claim coverage of blocks never fetched —
        // the same lie this whole change exists to remove.
        let coveredThrough: bigint | null = null;
        let failedChunks   = 0;
        let archiveBlocked = false;

        for (let from = fromBlock; from <= current; from += GAP_FILL_CHUNK) {
          const to = from + GAP_FILL_CHUNK - 1n <= current ? from + GAP_FILL_CHUNK - 1n : current;
          try {
            const logs = await readProvider.getLogs({
              address: AAVE_POOL,
              topics:  [MONITORED_TOPICS],
              fromBlock: from,
              toBlock:   to,
            });
            for (const log of logs) this.handleRawLog(log, "gap-fill");
            total += logs.length;
            // Only extends the covered watermark while nothing has failed yet;
            // past a hole, later successes do not make the hole covered.
            if (failedChunks === 0) coveredThrough = to;
          } catch (e: any) {
            failedChunks++;
            if (isArchiveRestricted(e)) {
              archiveBlocked = true;
              logger.warn(`  Gap-fill unavailable on this RPC plan (eth_getLogs is archive-gated)`);
              break;
            }
            logger.warn(`  Gap-fill chunk ${from}→${to} failed: ${e.message}`);
          }
        }

        if (failedChunks === 0) {
          logger.info(`  Gap-fill: ${total} events`);
          this.lastEventBlock = current;
        } else {
          // CRITICAL: the watermark used to be set to `current` unconditionally,
          // even when every chunk had been refused. That marked the gap as
          // covered when nothing had been read, so the missed events were lost
          // permanently and the next gap-fill started after them. On a plan
          // without eth_getLogs — this one — that happened on EVERY reconnect,
          // and the only visible trace was a cheerful "Gap-fill: 0 events".
          //
          // Leaving the watermark behind means the next attempt retries the same
          // range, which is the correct behaviour if the block range or the plan
          // later allows it.
          const uncoveredFrom = coveredThrough !== null ? coveredThrough + 1n : fromBlock;
          if (coveredThrough !== null && coveredThrough > this.lastEventBlock) {
            this.lastEventBlock = coveredThrough;
          }
          logger.warn(
            `  Gap-fill INCOMPLETE: ${failedChunks} chunk(s) failed, ${total} events recovered, ` +
            `blocks ${uncoveredFrom}→${current} NOT covered` +
            (archiveBlocked ? " (eth_getLogs unavailable on this RPC plan)" : "")
          );
          // Events in the hole would have invalidated cached model and breakdown
          // state for any borrower who transacted. That state cannot be replayed,
          // so re-read it instead of trusting it.
          if (isReconnect) this.recoverFromUnrecoveredGap();
          else if (archiveBlocked) {
            logger.warn(
              "  New borrowers created while the socket was down cannot be discovered without " +
              "eth_getLogs. Set THEGRAPH_API_KEY to seed from the subgraph, or use an RPC plan " +
              "that permits it."
            );
          }
        }
        this.currentBlock = current;
      }
    } catch (e: any) { logger.warn(`Gap-fill failed: ${e.message}`); }

    // ── Remove stale listeners from previous provider instance ────────────
    // This prevents duplicate handlers when reconnecting.
    if (this.activeWsProvider) {
      // off() is async in ethers v6 and rejects when the old socket is already
      // destroyed — swallow that explicitly instead of leaving an unhandled
      // rejection behind on every reconnect.
      const detach = (filter: ethers.Filter | null, listener: (log: ethers.Log) => void) => {
        if (!filter) return;
        try {
          const r = this.activeWsProvider!.off(filter, listener) as unknown;
          if (r && typeof (r as Promise<void>).catch === "function") (r as Promise<void>).catch(() => {});
        } catch { /* ignore */ }
      };
      detach(this.logFilter, this._onLog);
      detach(this.reserveFilter, this._onReserveLog);
    }
    this.activeWsProvider = wsProvider;

    // ── Subscribe via ethers' event system ───────────────────────────────
    // ethers v6 provider.on(filter, handler) internally calls eth_subscribe
    // and routes matching logs to the handler. It re-subscribes automatically
    // after reconnects managed internally by ethers.
    this.logFilter = {
      address: AAVE_POOL,
      topics:  [MONITORED_TOPICS],
    };
    // provider.on() is async in ethers v6 — it returns a Promise that rejects
    // if eth_subscribe fails. Without awaiting, a failed subscription looks like
    // success here and surfaces later as an unhandled rejection, leaving the bot
    // silently blind to all Aave events.
    try {
      await wsProvider.on(this.logFilter, this._onLog);
      logger.info("Subscribed to Aave logs via ethers provider.on()");
    } catch (e: any) {
      logger.warn(`provider.on(logs) failed: ${e.message}`);
    }

    // ── Reserve index updates ────────────────────────────────────────────────
    // Kept as a SEPARATE subscription, deliberately not part of MONITORED_TOPICS:
    // ReserveDataUpdated fires on every interaction with any reserve, so folding
    // it into the gap-fill getLogs would balloon those result sets for no gain —
    // the periodic registry refresh already resyncs indices after a disconnect.
    this.reserveFilter = { address: AAVE_POOL, topics: [TOPIC_RESERVE_DATA_UPDATED] };
    try {
      await wsProvider.on(this.reserveFilter, this._onReserveLog);
      logger.info("Subscribed to ReserveDataUpdated — indices now update without RPC");
    } catch (e: any) {
      logger.warn(`provider.on(ReserveDataUpdated) failed: ${e.message}`);
    }
  }

  // Arrow function so `this` is bound correctly when passed as a listener
  private _onLog = (log: ethers.Log): void => {
    try {
      if (!log.removed) this.handleRawLog(log, "ws-log");
    } catch { /* ignore */ }
  };

  private _onReserveLog = (log: ethers.Log): void => {
    try {
      if (!log.removed) this.reserves.applyReserveDataUpdated(log);
    } catch { /* ignore */ }
  };

  // ── Update current block (called by index.ts on each newHead) ──────────────
  setCurrentBlock(bn: bigint): void {
    this.currentBlock = bn;
  }

  // ── Batch refresh — FIX 4.5: uses Multicall3 to batch all getUserAccountData ─
  // One multicall aggregate per batch instead of N individual RPC calls.
  //
  // Tier budget (prevents danger from starving rotation when all positions are near HF 1.05):
  //
  //   priority  : up to batchSize slots (event-triggered addresses — always urgent)
  //   danger    : up to DANGER_CAP % of remaining slots after priority
  //   rotation  : guaranteed at least ROTATION_FLOOR % of batchSize, always advances
  //
  // With 932 positions all at HF < 1.05, the old code gave danger 100/100 slots every
  // cycle and rotation 0 — the same 100 positions were re-checked every block while
  // the other 832 were never evaluated. The cap fixes this.
  //
  // At batchSize=100: danger gets ≤70 slots, rotation gets ≥30 slots.
  // Full rotation sweep at 30 slots/cycle: 932÷30 ≈ 32 cycles ≈ 8 seconds on Arbitrum.
  private static readonly DANGER_CAP_PCT    = 0.70;  // danger tier can use at most 70% of remaining slots
  private static readonly ROTATION_FLOOR    = 0.30;  // rotation always gets at least 30% of batchSize

  // `signal` is the owning cycle's abort signal. The cycle safety timeout used
  // to call abort() on a controller that was wired to nothing, so an overrunning
  // sweep kept running — and kept holding rate-limiter slots — long after the
  // cycle that started it had given up and a new one had begun. Honouring it
  // here is what makes "aborting in-flight ops" in that log line true.
  async refreshBatch(batchSize: number, signal?: AbortSignal): Promise<BorrowerPosition[]> {
    const all = this.getRotationList();
    if (all.length === 0) return [];

    // Priority tier — event-triggered addresses, always first, no cap
    const prio = [...this.priorityQueue].slice(0, batchSize);
    this.priorityQueue.clear();
    const prioSet = new Set(prio);

    // Danger tier — capped so rotation always gets guaranteed slots
    const afterPrio        = batchSize - prio.length;
    const rotationFloor    = Math.max(1, Math.ceil(batchSize * PositionTracker.ROTATION_FLOOR));
    const dangerBudget     = Math.max(0, Math.min(
      afterPrio,
      Math.floor(afterPrio * PositionTracker.DANGER_CAP_PCT),
      afterPrio - rotationFloor,          // always leave room for rotation
    ));

    const danger: string[] = [];
    if (dangerBudget > 0) {
      // getDangerList() returns a pre-sorted array maintained incrementally.
      // Positions whose HF has been stable for DANGER_SKIP_BLOCKS consecutive cycles
      // are skipped — they're not going to flip liquidatable without a price move.
      // An Aave event (supply/borrow/repay) on the address resets their skip counter
      // because breakdownCache.delete() also clears lastDangerHF for that address.
      const dangerPositions = this.getDangerList()
        .filter(p => {
          if (prioSet.has(p.address)) return false;
          const entry = this.lastDangerHF.get(p.address);
          if (!entry) return true;  // never seen → always include
          if (entry.stableFor < PositionTracker.DANGER_SKIP_BLOCKS) return true;
          // Starvation guard: HF has been stable, but this position hasn't been
          // fetched in a while — force a recheck. A price move may have moved its
          // real HF without any on-chain event from the borrower.
          if (this.currentBlock - entry.checkedAtBlock >= PositionTracker.DANGER_FORCE_RECHECK_BLOCKS) return true;
          return false;
        })
        .slice(0, dangerBudget);
      for (const p of dangerPositions) danger.push(p.address);
    }
    const dangerSet = new Set(danger);

    // Rotation tier — guaranteed minimum, always advances cursor
    const slots = batchSize - prio.length - danger.length;
    const rotation: string[] = [];
    if (slots > 0) {
      if (this.rotationCursor >= all.length) this.rotationCursor = 0;
      let scanned = 0;
      for (let i = 0; i < all.length && rotation.length < slots; i++) {
        const addr = all[(this.rotationCursor + i) % all.length]!;
        scanned++;
        if (!prioSet.has(addr) && !dangerSet.has(addr)) rotation.push(addr);
      }
      // Advance cursor by how many we SCANNED (not just selected) so we make
      // forward progress even when prio/danger addresses are interleaved.
      // This prevents re-checking the same leading addresses on every cycle.
      this.rotationCursor = (this.rotationCursor + scanned) % all.length;
    }

    const seen = new Set<string>();
    const batch: string[] = [];
    for (const a of [...prio, ...danger, ...rotation]) {
      if (!seen.has(a)) { seen.add(a); batch.push(a); }
    }
    if (!batch.length) return [];

    logger.debug(`refreshBatch ${batch.length}/${all.length}: ${prio.length} prio + ${danger.length}/${dangerBudget} danger + ${rotation.length}/${slots} rotation (cursor=${this.rotationCursor})`);

    // Multicall3 — batch all getUserAccountData into sub-chunked multicall requests.
    // Falls back to individual calls if multicall reverts (e.g. provider doesn't support it).
    // PERF: Uses module-level IFACE constant — avoids new Interface() allocation every cycle.
    // SAFETY: Sub-chunks of 300 to avoid exceeding Arbitrum eth_call gas limits.
    // getUserAccountData is gas-heavy (~200k per call); 1000 calls in one multicall
    // would consume ~200M gas, exceeding most providers' eth_call limits.
    // PERF: All sub-chunks are dispatched CONCURRENTLY — they are independent
    // eth_calls. Sequential dispatch made refreshBatch cost N_chunks × RTT
    // (up to ~12s at 1000 positions on a slow provider), serializing the entire
    // cycle behind it. Concurrent dispatch costs one RTT regardless of chunk count.
    const MC_SUBCHUNK = CONFIG.mcSubchunk;
    const liquidatable: BorrowerPosition[] = [];

    // Single mutation pass, run after all RPC data has arrived so map updates
    // (positions / danger / dormant / rotation dirty flags) stay deterministic.
    const applyResults = (
      pairs: Array<{ addr: string; decoded: ReturnType<ethers.Interface["decodeFunctionResult"]> }>,
    ): void => {
      // Remember what this pass read authoritatively, so sampleModelError can
      // compare a few of them against the model for free.
      this.lastSwept = pairs.map(pr => pr.addr);
      for (const { addr, decoded } of pairs) {
        try {
          const pos = this.processAccountData(addr, decoded);
          if (pos !== null) {
            // Skip re-insertion if this address was evicted as bad debt
            if (this.badDebtDenylist.has(pos.address)) {
              this.positions.delete(pos.address);
              this.dropUserState(pos.address);   // else the model outlives the position
              this.markRotationDirty();
              this.markDangerDirty(); // FIX: addr may still be in dangerList
              this.lastDangerHF.delete(addr);
            } else {
              this.positions.set(pos.address, pos);
              if (pos.healthFactor < HF_ONE) {
                liquidatable.push(pos);
                this.lastDangerHF.delete(addr);  // liquidatable — always re-check
              } else if (pos.healthFactor > HF_WATCH) {
                // Healthy — park in dormant instead of deleting permanently.
                // Will be re-checked after DORMANT_RECHECK_MS or on next live event.
                this.parkAsDormant(pos.address, pos.healthFactor);
              } else if (pos.healthFactor < HF_WATCH) {
                // In danger tier — track HF stability
                const prev = this.lastDangerHF.get(addr);
                if (prev && prev.hf === pos.healthFactor) {
                  this.lastDangerHF.set(addr, { hf: pos.healthFactor, stableFor: prev.stableFor + 1, checkedAtBlock: this.currentBlock });
                } else {
                  this.lastDangerHF.set(addr, { hf: pos.healthFactor, stableFor: 0, checkedAtBlock: this.currentBlock });
                }
              }
            }
          }
        } catch (e: any) {
          logger.debug(`multicall decode ${addr}: ${e.message}`);
        }
      }
    };

    // Decode-only per chunk — no state mutation, safe to run concurrently.
    const decodeChunk = async (subBatch: string[]) => {
      const calls = subBatch.map(addr => ({
        target: AAVE_POOL,
        callData: IFACE.encodeFunctionData("getUserAccountData", [addr]),
      }));
      // tryAggregate(false) never reverts — returns (success, data) per call
      const results: Array<{ success: boolean; returnData: string }> =
        await this.multicall.tryAggregate(false, calls);

      const pairs: Array<{ addr: string; decoded: ReturnType<ethers.Interface["decodeFunctionResult"]> }> = [];
      for (let i = 0; i < subBatch.length; i++) {
        const addr   = subBatch[i]!;
        const result = results[i];
        if (!result?.success || result.returnData === "0x") {
          logger.debug(`multicall skip ${addr}: call failed`);
          continue;
        }
        pairs.push({ addr, decoded: IFACE.decodeFunctionResult("getUserAccountData", result.returnData) });
      }
      return pairs;
    };

    try {
      const chunks: string[][] = [];
      for (let si = 0; si < batch.length; si += MC_SUBCHUNK) {
        chunks.push(batch.slice(si, si + MC_SUBCHUNK));
      }

      const isProviderDestroyed = (e: any) =>
        e?.code === 'UNSUPPORTED_OPERATION' || /provider destroyed|cancelled request/i.test(e?.message ?? "");

      const settled = await Promise.allSettled(chunks.map(decodeChunk));
      // The cycle that owns this sweep gave up while we were awaiting. Its
      // results are stale by definition and applying them would overwrite fresh
      // state written by the cycle that succeeded it.
      if (signal?.aborted) return [];
      for (const r of settled) {
        if (r.status === "rejected" && isProviderDestroyed(r.reason)) return liquidatable;
      }
      // Chunk rejections are absorbed by allSettled, so a shed chunk never
      // reaches the catch below as a typed error — it arrives as the generic
      // "all multicall chunks failed", which would then trigger the individual-
      // call fallback and pour `batch.length` more calls into a queue that is
      // already full. Detect it here, where the reason objects still exist.
      if (settled.some(r => r.status === "rejected" && (r.reason as any)?.code === "RPC_BACKPRESSURE")) {
        const shedChunks = settled.filter(r => r.status === "rejected").length;
        logger.warn(
          `refreshBatch: ${shedChunks}/${chunks.length} chunks shed by rate limiter — ` +
          `sweep skipped this cycle (no individual-call fallback)`
        );
        applyResults(
          settled.flatMap(r => (r.status === "fulfilled" ? r.value : [])),
        );
        return liquidatable;
      }

      const pairs: Array<{ addr: string; decoded: ReturnType<ethers.Interface["decodeFunctionResult"]> }> = [];
      let failedChunks = 0;
      for (const r of settled) {
        if (r.status === "fulfilled") pairs.push(...r.value);
        else failedChunks++;
      }

      applyResults(pairs);

      if (failedChunks > 0 && pairs.length === 0 && chunks.length > 0) {
        // Every chunk failed — mimic the old behaviour so the individual-call
        // fallback below runs.
        throw new Error("all multicall chunks failed");
      }
      if (failedChunks > 0) {
        logger.warn(`refreshBatch: ${failedChunks}/${chunks.length} multicall chunks failed (${pairs.length} results applied)`);
      }
    } catch (e: any) {
      // If the provider itself was destroyed (reconnect in progress), abort immediately
      // rather than hammering N individual calls that will all fail the same way.
      if (e.code === 'UNSUPPORTED_OPERATION' || /provider destroyed|cancelled request/i.test(e.message)) {
        return liquidatable;
      }
      // Backpressure is the one failure this fallback must never answer. The
      // multicall chunks were shed because the call budget is already spent;
      // replacing 2 shed calls with `batch.length` individual ones is the exact
      // opposite of what the limiter asked for, and it is how a transient
      // overload used to turn into a self-sustaining one.
      if (e.code === "RPC_BACKPRESSURE") {
        logger.warn(`refreshBatch shed by rate limiter (${e.message}) — skipping sweep, not falling back`);
        return liquidatable;
      }
      if (signal?.aborted) return [];
      // Multicall unavailable — fall back to individual parallel calls in chunks of 25
      logger.warn(`Multicall failed (${e.message}), falling back to individual calls`);
      const CHUNK = 25;
      for (let i = 0; i < batch.length; i += CHUNK) {
        if (signal?.aborted) return liquidatable;
        const results = await Promise.allSettled(batch.slice(i, i + CHUNK).map(addr => this.refreshOne(addr)));
        for (const r of results) {
          if (r.status !== "fulfilled" || !r.value) continue;
          const pos = r.value;
          if (this.badDebtDenylist.has(pos.address)) {
            this.positions.delete(pos.address);
            this.dropUserState(pos.address);   // else the model outlives the position
            this.markRotationDirty();
            this.markDangerDirty(); // FIX: addr may be in dangerList
          } else {
            this.positions.set(pos.address, pos);
            if (pos.healthFactor < HF_ONE) {
              liquidatable.push(pos);
              this.lastDangerHF.delete(pos.address); // liquidatable — always re-check
            } else if (pos.healthFactor > HF_WATCH) {
              this.parkAsDormant(pos.address, pos.healthFactor);
            } else {
              // FIX: track danger HF stability in fallback path (was missing entirely)
              const prev = this.lastDangerHF.get(pos.address);
              if (prev && prev.hf === pos.healthFactor) {
                this.lastDangerHF.set(pos.address, { hf: pos.healthFactor, stableFor: prev.stableFor + 1, checkedAtBlock: this.currentBlock });
              } else {
                this.lastDangerHF.set(pos.address, { hf: pos.healthFactor, stableFor: 0, checkedAtBlock: this.currentBlock });
              }
            }
          }
        }
        if (i + CHUNK < batch.length) await sleep(20);
      }
    }

    return liquidatable;
  }

  // Shared logic for processing a getUserAccountData return value
  private processAccountData(
    address: string,
    d: ethers.Result,
  ): BorrowerPosition | null {
    const debt = d.totalDebtBase as bigint;
    const hf    = d.healthFactor as bigint;
    const hfNum = Number(hf) / 1e18;
    const totalCollateral = d.totalCollateralBase as bigint;

    // Bug #6 fix: check bad-debt BEFORE dust check. Previously, a position with
    // HF=0, $0 collateral, and $8 debt (< $10 dust threshold) was silently deleted
    // without being denylisted, causing restart loops.
    if (hf === 0n && totalCollateral === 0n) {
      logger.info(`Bad debt evicted: ${address} (HF=0, col=$0, debt=$${(Number(debt)/1e8).toFixed(2)}) -- no collateral to liquidate`);
      this.positions.delete(address);
      this.dormant.delete(address);
      this.dropUserState(address);   // else the model outlives the position
      this.markRotationDirty();
      this.markDangerDirty(); // FIX: danger list may contain this address — mark stale
      // FIX: add to denylist so this address is blocked on re-seed/re-scan.
      // Without this, restarts re-seed the address from cache, re-evaluate it, and re-evict —
      // wasting a cycle and logging a false "liquidatable" every restart indefinitely.
      this.badDebtDenylist.add(address);
      saveDenylist(this.badDebtDenylist);
      return null;
    }

    if (debt < MIN_DEBT_USD8) {
      this.positions.delete(address);
      this.dropUserState(address);   // else the model outlives the position
      this.markRotationDirty();
      this.markDangerDirty(); // FIX: danger list may contain this address — mark stale
      return null;
    }
    const existing = this.positions.get(address);
    const newPos: BorrowerPosition = {
      address, healthFactor: hf, healthFactorNum: hfNum,
      totalCollateralBase: d.totalCollateralBase as bigint,
      totalDebtBase: debt,
    };
    // Mark danger list dirty if this position crossed the watch threshold or its HF changed
    const wasInDanger = existing && existing.healthFactor < HF_WATCH;
    const isInDanger  = hf < HF_WATCH;
    if (wasInDanger !== isInDanger || (isInDanger && existing?.healthFactor !== hf)) {
      this.markDangerDirty();
    }
    return newPos;
  }

  // Fallback: individual refreshOne (used when multicall fails)
  private async refreshOne(address: string): Promise<BorrowerPosition | null> {
    try {
      const d = await this.pool.getUserAccountData(address);
      return this.processAccountData(address, d);
    } catch (err: any) {
      logger.debug(`refreshOne ${address}: ${err?.shortMessage ?? err?.message}`);
      return null;
    }
  }

  // ── Batched asset breakdown ───────────────────────────────────────────────────
  // Materialised from the in-memory model, which stores Aave's SCALED balances.
  // Actual balance = scaled × the reserve's current normalised index, so no
  // per-asset balance read is needed at all.
  //
  // Cost history for N addresses:
  //   originally   2N eth_calls (getUserReservesData + getUserReserveData each),
  //                except getUserReservesData was throwing on a bad ABI, so in
  //                practice every address took the ~19-reserve fallback scan
  //   now          ceil(N/20) eth_calls, and zero once the model is warm
  //
  // Addresses the model cannot represent (unknown reserve, failed fetch) fall
  // back to the per-address path, so behaviour is unchanged for them.
  async getAssetBreakdownBatch(
    addresses: string[],
    minDebtUsd8 = MIN_DEBT_FOR_BREAKDOWN_USD8,
    signal?: AbortSignal,
  ): Promise<Map<string, { collaterals: AssetPosition[]; debts: AssetPosition[] }>> {
    if (signal?.aborted) return new Map();
    const out = new Map<string, { collaterals: AssetPosition[]; debts: AssetPosition[] }>();
    const wanted: string[] = [];

    for (const raw of addresses) {
      const address = raw.toLowerCase();
      if (out.has(address) || wanted.includes(address)) continue;  // dedupe
      const pos = this.positions.get(address);
      if (pos && pos.totalDebtBase < minDebtUsd8) { out.set(address, { collaterals: [], debts: [] }); continue; }
      wanted.push(address);
    }
    if (wanted.length === 0) return out;

    // Fetch model entries for anything not already modelled. Entries persist
    // until an Aave event touches the address, so this is usually a no-op.
    const missing = wanted.filter(a => !this.userStates.has(a));
    if (missing.length > 0) {
      await this.refreshUserStates(missing).catch(e =>
        logger.debug(`breakdownBatch: model refresh failed: ${e?.message ?? e}`)
      );
    }

    const fallback: string[] = [];
    for (const address of wanted) {
      const materialised = this.materialiseBreakdown(address);
      if (materialised) out.set(address, materialised);
      else fallback.push(address);
    }

    if (fallback.length > 0) {
      logger.debug(`breakdownBatch: ${fallback.length}/${wanted.length} addresses need the per-address path`);
      const FALLBACK_CONCURRENCY = 4;
      for (let i = 0; i < fallback.length; i += FALLBACK_CONCURRENCY) {
        if (signal?.aborted) break;
        const slice = fallback.slice(i, i + FALLBACK_CONCURRENCY);
        const settled = await Promise.allSettled(slice.map(a => this.getAssetBreakdown(a, minDebtUsd8)));
        for (let j = 0; j < slice.length; j++) {
          const r = settled[j]!;
          if (r.status === "fulfilled") out.set(slice[j]!, r.value);
        }
      }
    }

    return out;
  }

  // Convert a model entry into the collateral/debt view the evaluator expects.
  // Returns null when the address is not modelled or references a reserve the
  // registry does not know, so the caller can fall back.
  private materialiseBreakdown(
    address: string,
  ): { collaterals: AssetPosition[]; debts: AssetPosition[] } | null {
    const state = this.userStates.get(address);
    if (!state || !this.reserves.loaded) return null;

    const nowSec = Math.floor(Date.now() / 1000);
    const collaterals: AssetPosition[] = [];
    const debts:       AssetPosition[] = [];

    for (const r of state.reserves) {
      const reserve = this.reserves.get(r.asset);
      if (!reserve) return null;
      if (r.usageAsCollateral && r.scaledATokenBalance > 0n) {
        const balance = (r.scaledATokenBalance * this.reserves.normalizedIncome(reserve, nowSec)) / RAY;
        if (balance > 0n) {
          collaterals.push({
            symbol: reserve.symbol, address: reserve.address,
            decimals: reserve.decimals, balance, balanceUsd: 0,
          });
        }
      }
      if (r.scaledVariableDebt > 0n) {
        const balance = (r.scaledVariableDebt * this.reserves.normalizedVariableDebt(reserve, nowSec)) / RAY;
        if (balance > 0n) {
          debts.push({
            symbol: reserve.symbol, address: reserve.address,
            decimals: reserve.decimals, balance, balanceUsd: 0,
          });
        }
      }
    }
    return { collaterals, debts };
  }

  // ── Asset breakdown (single address) ──────────────────────────────────────────
  // Kept as the fallback path for getAssetBreakdownBatch and for callers that
  // genuinely need one address. Prefer the batch method for any fan-out.
  // Strategy:
  //   1. UiPoolDataProvider → identifies which assets are active (1 RPC call)
  //   2. Multicall3 → fetches actual (non-scaled) balances for all relevant assets
  //      in a SINGLE RPC call instead of N individual getUserReserveData calls.
  //      Previously this was Promise.allSettled(N × getUserReserveData) = N parallel
  //      calls. With Multicall3 it's 1 call regardless of asset count.
  //   3. Full fallback: if UiProvider fails or finds unknown assets, scan all RESERVES
  //      via Multicall3 in one call.
  // Results cached for BREAKDOWN_CACHE_BLOCKS (invalidated on any event for this address).
  async getAssetBreakdown(
    address: string,
    minDebtUsd8 = MIN_DEBT_FOR_BREAKDOWN_USD8,
  ): Promise<{ collaterals: AssetPosition[]; debts: AssetPosition[] }> {
    const pos = this.positions.get(address);
    if (pos && pos.totalDebtBase < minDebtUsd8) {
      return { collaterals: [], debts: [] };
    }

    // Cache check — tiered TTL: danger positions expire in 5 blocks, others in 50
    const cacheBlocks = (pos && pos.healthFactor > 0n && pos.healthFactor < HF_PREWARM)
      ? BREAKDOWN_CACHE_BLOCKS_DANGER
      : BREAKDOWN_CACHE_BLOCKS_NORMAL;
    const cached = this.breakdownCache.get(address);
    if (cached && this.currentBlock < cached.expiresAt) {
      return { collaterals: cached.collaterals, debts: cached.debts };
    }

    const collaterals: AssetPosition[] = [];
    const debts:       AssetPosition[] = [];

    // ── Step 1: UiPoolDataProvider — identify active assets ───────────────────
    let useFullFallback = false;
    let relevantAssets: Array<{ symbol: string; address: string; decimals: number; hasCollateral: boolean; hasDebt: boolean }> = [];

    try {
      const [userReserves, userEmodeCategoryId]: [Array<{
        underlyingAsset:               string;
        scaledATokenBalance:           bigint;
        usageAsCollateralEnabledOnUser: boolean;
        scaledVariableDebt:            bigint;
        principalStableDebt:           bigint;
      }>, number] = await this.uiDataProvider.getUserReservesData(POOL_ADDRESSES_PROVIDER, address);

      // Bug #8 fix: store e-mode category on the position for close factor calculation
      const pos = this.positions.get(address);
      if (pos) pos.userEmodeCategoryId = userEmodeCategoryId;

      for (const ur of userReserves) {
        // Bug #2 fix: include principalStableDebt in hasActivity and hasDebt checks.
        // Previously, borrowers with only stable-rate debt were silently skipped
        // because scaledVariableDebt was 0 but principalStableDebt was > 0.
        const hasActivity = ur.scaledATokenBalance > 0n || ur.scaledVariableDebt > 0n || ur.principalStableDebt > 0n;
        if (!hasActivity) continue;
        const assetAddr = ur.underlyingAsset.toLowerCase();
        const reserve = RESERVE_BY_ADDRESS[assetAddr];
        if (!reserve) {
          logger.warn(`Unknown active asset in position ${address.slice(0,10)}: ${ur.underlyingAsset} — using full fallback`);
          useFullFallback = true;
          break;
        }
        relevantAssets.push({
          symbol:        reserve.symbol,
          address:       reserve.address,
          decimals:      reserve.decimals,
          hasCollateral: ur.scaledATokenBalance > 0n && ur.usageAsCollateralEnabledOnUser,
          hasDebt:       ur.scaledVariableDebt > 0n || ur.principalStableDebt > 0n,  // Bug #2 fix
        });
      }
    } catch (e: any) {
      if (e.code === 'UNSUPPORTED_OPERATION' || /provider destroyed|cancelled request/i.test(e.message)) {
        return { collaterals: [], debts: [] };
      }
      logger.debug(`UiPoolDataProvider failed for ${address.slice(0,10)}: ${e.message} — full fallback`);
      useFullFallback = true;
    }

    // ── Step 2: Multicall3 to fetch actual balances in ONE RPC call ───────────
    // Replaces N × getUserReserveData calls (previously N parallel calls via
    // Promise.allSettled, now a single batched call).
    const dataProviderIface = DATA_PROVIDER_IFACE;  // module-level constant — no alloc per call

    if (!useFullFallback && relevantAssets.length > 0) {
      const calls = relevantAssets.map(asset => ({
        target:   AAVE_DATA_PROVIDER,
        callData: dataProviderIface.encodeFunctionData("getUserReserveData", [asset.address, address]),
      }));

      try {
        const results: Array<{ success: boolean; returnData: string }> =
          await this.multicall.tryAggregate(false, calls);

        for (let i = 0; i < relevantAssets.length; i++) {
          const asset  = relevantAssets[i]!;
          const result = results[i];
          if (!result?.success || result.returnData === "0x") {
            logger.debug(`Multicall breakdown: no data for ${asset.symbol} — skipping`);
            continue;
          }
          try {
            const ud = dataProviderIface.decodeFunctionResult("getUserReserveData", result.returnData);
            const aTokenBal  = ud.currentATokenBalance as bigint;
            const variableDebt = (ud.currentVariableDebt as bigint) + (ud.currentStableDebt as bigint);

            if (asset.hasCollateral && aTokenBal > 0n) {
              collaterals.push({ symbol: asset.symbol, address: asset.address, decimals: asset.decimals, balance: aTokenBal, balanceUsd: 0 });
            }
            if (asset.hasDebt && variableDebt > 0n) {
              debts.push({ symbol: asset.symbol, address: asset.address, decimals: asset.decimals, balance: variableDebt, balanceUsd: 0 });
            }
          } catch (e: any) {
            logger.debug(`Breakdown decode ${asset.symbol}: ${e.message}`);
          }
        }

        if (collaterals.length > 0 || debts.length > 0) {
          const result = {
            collaterals: collaterals.filter(c => c.balance > 0n),
            debts:       debts.filter(d => d.balance > 0n),
          };
          this.setBreakdownCache(address, { ...result, expiresAt: this.currentBlock + cacheBlocks });
          return result;
        }

        // UiProvider returned slots but all balances came back zero — position closed
        const empty = { collaterals: [], debts: [] };
        this.setBreakdownCache(address, { ...empty, expiresAt: this.currentBlock + cacheBlocks });
        return empty;

      } catch (e: any) {
        // Provider destroyed: abort immediately, don't try Step 3.
        // Backpressure too — Step 3 is a ~4-chunk sweep over every reserve, so
        // answering a shed call with it is the wrong direction entirely.
        if (e.code === "RPC_BACKPRESSURE"
            || e.code === 'UNSUPPORTED_OPERATION'
            || /provider destroyed|cancelled request/i.test(e.message)) {
          return { collaterals: [], debts: [] };
        }
        logger.warn(`Multicall breakdown failed for ${address.slice(0,10)}: ${e.message} — full fallback`);
        useFullFallback = true;
      }
    } else if (!useFullFallback && relevantAssets.length === 0) {
      // UiProvider succeeded but returned no active slots — position closed
      const empty = { collaterals: [], debts: [] };
      this.setBreakdownCache(address, { ...empty, expiresAt: this.currentBlock + cacheBlocks });
      return empty;
    }

    // ── Step 3: Full fallback — Multicall3 across all RESERVES, CHUNKED ──────
    // Runs when: (a) UiProvider failed, OR (b) unknown asset detected.
    // FIX: previously one unchunked tryAggregate across ALL ~19 reserves — every
    // other multicall in this file chunks (refreshBatch, pruneStale), this one
    // didn't. Some RPC providers (shared/free-tier nodes especially — e.g. a
    // conservative eth_call gas cap, or throttling on large batched calls) reject
    // a call this size outright with an empty-data CALL_EXCEPTION ("missing revert
    // data"), which looks identical whether it happens once or on every borrower.
    // Chunking shrinks each request and, on a chunk failure, falls back to
    // individual calls for just that chunk instead of all ~19 reserves.
    const allReserves = Object.values(RESERVES);
    const FALLBACK_CHUNK = 6;

    for (let start = 0; start < allReserves.length; start += FALLBACK_CHUNK) {
      const chunk = allReserves.slice(start, start + FALLBACK_CHUNK);
      const chunkCalls = chunk.map(reserve => ({
        target:   AAVE_DATA_PROVIDER,
        callData: dataProviderIface.encodeFunctionData("getUserReserveData", [reserve.address, address]),
      }));

      try {
        const results: Array<{ success: boolean; returnData: string }> =
          await this.multicall.tryAggregate(false, chunkCalls);

        for (let i = 0; i < chunk.length; i++) {
          const reserve = chunk[i]!;
          const result  = results[i];
          if (!result?.success || result.returnData === "0x") continue;
          try {
            const ud = dataProviderIface.decodeFunctionResult("getUserReserveData", result.returnData);
            const aTokenBal    = ud.currentATokenBalance as bigint;
            const variableDebt = (ud.currentVariableDebt as bigint) + (ud.currentStableDebt as bigint);
            if (aTokenBal > 0n && ud.usageAsCollateralEnabled)
              collaterals.push({ symbol: reserve.symbol, address: reserve.address, decimals: reserve.decimals, balance: aTokenBal, balanceUsd: 0 });
            if (variableDebt > 0n)
              debts.push({ symbol: reserve.symbol, address: reserve.address, decimals: reserve.decimals, balance: variableDebt, balanceUsd: 0 });
          } catch { /* skip undecoded */ }
        }
      } catch (e: any) {
        // If the provider was destroyed (reconnect in progress), abort immediately.
        // Spawning individual calls against a dead socket just hangs for 45s each.
        // Under backpressure the individual calls would be shed anyway, after
        // taking slots the live path needs.
        if (e.code === "RPC_BACKPRESSURE"
            || e.code === 'UNSUPPORTED_OPERATION'
            || /provider destroyed|cancelled request/i.test(e.message)) {
          logger.debug(`Full fallback aborted (${e.code ?? "provider destroyed"}) for ${address.slice(0,10)}`);
          return { collaterals: [], debts: [] };
        }
        // Last resort for THIS chunk only: individual calls, not all ~19 reserves.
        logger.debug(`Full fallback chunk failed for ${address.slice(0,10)}: ${e.message} — individual calls for ${chunk.length} reserves`);
        await Promise.allSettled(chunk.map(async (reserve) => {
          try {
            const ud = await this.dataProvider.getUserReserveData(reserve.address, address);
            const aTokenBal    = ud.currentATokenBalance as bigint;
            const variableDebt = (ud.currentVariableDebt as bigint) + (ud.currentStableDebt as bigint);
            if (aTokenBal > 0n && ud.usageAsCollateralEnabled)
              collaterals.push({ symbol: reserve.symbol, address: reserve.address, decimals: reserve.decimals, balance: aTokenBal, balanceUsd: 0 });
            if (variableDebt > 0n)
              debts.push({ symbol: reserve.symbol, address: reserve.address, decimals: reserve.decimals, balance: variableDebt, balanceUsd: 0 });
          } catch { /* asset not in pool for this user */ }
        }));
      }
    }

    const result = { collaterals: collaterals.filter(c => c.balance > 0n), debts: debts.filter(d => d.balance > 0n) };
    this.setBreakdownCache(address, { ...result, expiresAt: this.currentBlock + cacheBlocks });
    return result;
  }

  // Evict a position permanently from the watchlist (e.g. dust positions with HF < 1.0).
  // Adds to badDebtDenylist so upsert() cannot re-insert it from scan/Supply/Repay events.
  // Only a new Borrow event can re-admit the address.
  // Persists the denylist to disk so restarts don't re-evaluate known-bad positions.
  evict(address: string): void {
    const key = address.toLowerCase();
    if (this.positions.delete(key)) {
      this.markRotationDirty();
      this.markDangerDirty();
      this.breakdownCache.delete(key);
      this.lastDangerHF.delete(key);
    }
    // The model entry outlives the position unless it is dropped here. That is
    // why the heartbeat reported model=17195/16738 — more modelled users than
    // tracked ones, which is not a coverage figure at all, plus a map that only
    // ever grows. An evicted address is never evaluated again, so nothing needs
    // its scaled balances.
    this.dropUserState(key);
    this.badDebtDenylist.add(key);
    saveDenylist(this.badDebtDenylist);
  }

  // ── Pre-warm breakdown cache for danger-tier positions ──────────────────────
  // Called by index.ts every N blocks on positions with HF < HF_PREWARM (1.05).
  // When these positions cross HF=1.0 and become liquidatable, their breakdown is
  // already cached — the cycle skips the UiPoolDataProvider + Multicall3 round-trip
  // entirely and goes straight to evaluate(). This saves ~100-200ms on the hot path
  // when it matters most.
  //
  // Only pre-warms positions whose cache has expired AND HF < HF_PREWARM.
  // Runs as a fire-and-forget background task — never blocks the cycle.
  private _prewarmInProgress = false;

  async prewarmDangerBreakdowns(): Promise<void> {
    // Guard: if a prewarm is already running, skip this call entirely.
    // Without this, overlapping prewarms pile up and flood the RPC queue,
    // causing refreshBatch multicalls to queue behind hundreds of pending
    // UiPoolDataProvider calls → cycle times inflate from 150ms to 8s+.
    if (this._prewarmInProgress) {
      logger.debug(`prewarm: skipped — previous prewarm still in progress`);
      return;
    }
    this._prewarmInProgress = true;

    try {
      // Warm the most-at-risk positions (HF closest to 1.0). The event-driven
      // trigger needs a cached breakdown to compute local HF — the wider this
      // window, the more positions a sudden price move can fire on instantly.
      // Cost is CONFIG.prewarmMax × 2 eth_calls, all of which pass through the
      // shared rate limiter — see the PREWARM_MAX note in config.ts before
      // raising it, since an oversized sweep starves the cycle and the trigger.
      const toWarm = [...this.positions.values()]
        .filter(p =>
          p.healthFactor > 0n &&
          p.healthFactor < HF_PREWARM &&
          p.totalDebtBase >= MIN_DEBT_FOR_BREAKDOWN_USD8 &&
          !this.badDebtDenylist.has(p.address) &&
          (() => {
            const cached = this.breakdownCache.get(p.address);
            return !cached || this.currentBlock >= cached.expiresAt;
          })()
        )
        .sort((a, b) => (a.healthFactor < b.healthFactor ? -1 : 1))
        .slice(0, CONFIG.prewarmMax);  // most-at-risk first; see PREWARM_MAX in config.ts

      if (toWarm.length === 0) return;
      logger.debug(`prewarm: warming ${toWarm.length} most-at-risk danger positions`);

      // One batched fan-out instead of 2 eth_calls per position. This is the
      // difference between ~4 calls and ~80 for a 40-position sweep, which is
      // what let prewarm monopolise the shared rate limiter.
      await this.getAssetBreakdownBatch(toWarm.map(p => p.address)).catch(e =>
        logger.debug(`prewarm batch failed: ${e?.message ?? e}`)
      );
    } finally {
      this._prewarmInProgress = false;
    }
  }

  // Evict a dust position (HF < 1.0 but debt < min threshold).
  // Unlike evict(), does NOT add to the bad-debt denylist — dust positions
  // can regain meaningful debt and re-enter via any live Aave event.
  // FIX: Previously evict() was called for both bad-debt AND dust, permanently
  // banning addresses with tiny debt. A $8 position today may become $5k tomorrow.
  evictDust(address: string): void {
    const key = address.toLowerCase();
    if (this.positions.delete(key)) {
      this.markRotationDirty();
      this.markDangerDirty();
      this.breakdownCache.delete(key);
      this.lastDangerHF.delete(key);
    }
    // Bug #7 fix: also remove from dormant map so wakeExpiredDormant doesn't
    // re-add a dust position that was just evicted.
    this.dormant.delete(key);
    // Same leak as evict() — an address that is in neither positions nor dormant
    // must not keep a model entry, or modelCoverage() reports more modelled
    // users than tracked ones and the map grows without bound.
    this.dropUserState(key);
    // No denylist — any subsequent Borrow/Supply/etc event re-admits naturally
  }

  // Returns a compact summary of the danger tier for heartbeat logging.
  // Shows count + top-3 most-at-risk addresses so operators can see at a glance
  // whether the bot is actively tracking near-liquidatable positions.
  getDangerTierSummary(): { count: number; top3: Array<{ addr: string; hf: number }> } {
    const list = this.getDangerList();
    return {
      count: list.length,
      top3:  list.slice(0, 3).map(p => ({ addr: p.address.slice(0, 8), hf: p.healthFactorNum })),
    };
  }

  // ── Local HF recomputation for the event-driven trigger ────────────────────
  // Given the assets whose prices just moved, find watched positions whose LOCAL
  // health factor is at or below `ceiling` (1e18 fixed point). PURE COMPUTATION:
  // no RPC, microsecond-scale, safe to call from an event handler.
  //
  // This now runs off the in-memory model (scaled balances + reserve indices +
  // e-mode), not off pre-warmed breakdowns. That removes the coverage hole that
  // made the fast path useless in a crash: previously only positions whose
  // breakdown had been fetched — in practice those already near HF 1.05 — were
  // visible, so a position at HF 1.2 taken straight past 1.0 by a sharp move was
  // invisible to the trigger and had to wait for the polling sweep.
  //
  // Only positions the moved assets can actually affect are scanned, via
  // assetIndex, so cost scales with holders-of-that-asset rather than watchlist
  // size.
  findLocalCandidates(
    assetsLower: Set<string>,
    prices: Map<string, bigint>,
    ceiling: bigint,
    maxResults = 10,
  ): Array<{ pos: BorrowerPosition; collaterals: AssetPosition[]; debts: AssetPosition[]; hfLocal: number }> {
    const out: Array<{ pos: BorrowerPosition; collaterals: AssetPosition[]; debts: AssetPosition[]; hfLocal: number }> = [];
    if (assetsLower.size === 0 || !this.reserves.loaded) return out;

    // Candidate borrowers = union of holders of any moved asset.
    const candidates = new Set<string>();
    for (const asset of assetsLower) {
      const holders = this.assetIndex.get(asset);
      if (!holders) continue;
      for (const addr of holders) candidates.add(addr);
    }
    if (candidates.size === 0) return out;

    const nowSec = Math.floor(Date.now() / 1000);
    const nowMs  = Date.now();
    let skipped = 0, evaluated_ = 0;

    for (const address of candidates) {
      if (this.badDebtDenylist.has(address)) continue;
      const state = this.userStates.get(address);
      if (!state) continue;
      // Dormant positions stay in the model (parking only removes them from the
      // active map), so they are evaluated here directly rather than being woken
      // en masse first. See the note in the trigger engine's dispatch.
      const isDormant = !this.positions.has(address);
      if (isDormant && !this.dormant.has(address)) continue;  // evicted entirely

      // Cheap provable skip. This loop used to run a full health-factor
      // recomputation for EVERY holder of the moved asset on EVERY price tick,
      // and once the model reached full coverage that was ~16.8k positions —
      // ETH/USD alone backs six reserves. Measured at 30ms p50 and 70ms max,
      // synchronous, on the single event-loop thread that also handles blocks,
      // WS heartbeats and receipt polling.
      //
      // The bound below is exact, not heuristic. With HF = N/D over collateral
      // value N and debt value D, scaling each price by rᵢ gives
      //   N' >= N · min(r over collateral)   and   D' <= D · max(r over debt)
      // so HF' >= HF · min(r_collateral) / max(r_debt). If that floor is still
      // at or above the ceiling, the position provably cannot have crossed and
      // the recomputation would only confirm it.
      if (this.canSkipLocalEval(address, state, prices, ceiling, nowMs)) { skipped++; continue; }

      evaluated_++;
      const evaluated = this.evaluateUserState(state, prices, nowSec);
      if (!evaluated) continue;
      // Keep the closest-to-threshold positions this dispatch actually computed,
      // so the trigger can audit one against the chain. These are the only
      // health factors anywhere in the bot derived from the SAME price snapshot
      // the fire decision uses, which makes them the only valid basis for
      // measuring how wrong that decision can be.
      this.noteLocalEval(address, evaluated.hfE18);
      // Cache the result against the prices that produced it, so the next tick
      // can bound this position instead of recomputing it.
      this.rememberLocalHf(address, state, prices, evaluated.hfE18, nowMs);
      const { collaterals, debts, hfE18, collateralUsd8, debtUsd8 } = evaluated;
      // Exclusive: Aave liquidates only when healthFactor < 1e18, so a position
      // exactly at the ceiling is not liquidatable either.
      if (hfE18 >= ceiling) continue;
      if (collaterals.length === 0 || debts.length === 0) continue;
      // Dust guard. The polling cycle has always filtered these, but the trigger
      // path did not — so sub-cent positions were being evaluated, and were even
      // driving background Uniswap route refreshes to quote 5 wei of USDC.
      if (debtUsd8 < MIN_DEBT_USD8) continue;

      let pos = this.positions.get(address);
      // Only reactivate a dormant position that is genuinely below 1.0. The
      // caller's ceiling now reaches slightly ABOVE 1.0 so the model's negative
      // error cannot hide a liquidatable borrower, but a position merely near
      // the threshold is not a reason to pull it out of the dormant tier — that
      // would put the churn back that the tier exists to prevent.
      if (!pos && hfE18 >= HF_ONE) {
        out.push({
          pos: {
            address,
            healthFactor: hfE18,
            healthFactorNum: Number(hfE18) / 1e18,
            totalCollateralBase: collateralUsd8,
            totalDebtBase: debtUsd8,
            userEmodeCategoryId: state.emodeId,
          },
          collaterals, debts, hfLocal: Number(hfE18) / 1e18,
        });
        continue;
      }
      if (!pos) {
        // Crossed the ceiling while parked — pull it back into the active set
        // now that it actually matters, instead of waking every dormant holder
        // of this asset on every price tick.
        pos = {
          address,
          healthFactor: hfE18,
          healthFactorNum: Number(hfE18) / 1e18,
          totalCollateralBase: collateralUsd8,
          totalDebtBase: debtUsd8,
        };
        this.positions.set(address, pos);
        this.dormant.delete(address);
        this.markRotationDirty();
        this.markDangerDirty();
        this.priorityQueue.add(address);
        logger.info(`⚡ Dormant position crossed locally: ${address.slice(0,10)}… HF=${(Number(hfE18)/1e18).toFixed(4)} — reactivated`);
      }

      // Publish the freshly computed figures so the close-factor rule, the
      // profit math and the logs all use live values rather than whatever the
      // last sweep happened to leave behind (which showed as HF=1.1000 debt=$0.00).
      pos.healthFactor        = hfE18;
      pos.healthFactorNum     = Number(hfE18) / 1e18;
      pos.totalCollateralBase = collateralUsd8;
      pos.totalDebtBase       = debtUsd8;
      pos.userEmodeCategoryId = state.emodeId;

      out.push({ pos, collaterals, debts, hfLocal: Number(hfE18) / 1e18 });
    }

    this.boundSkipped   += skipped;
    this.boundEvaluated += evaluated_;
    if (skipped > 0) {
      logger.debug(`findLocalCandidates: ${evaluated_} evaluated, ${skipped} skipped by bound`);
    }
    out.sort((a, b) => a.hfLocal - b.hfLocal);
    return out.slice(0, maxResults);
  }

  // ── Local-HF skip bound ────────────────────────────────────────────────────
  // Cached health factor per address, together with the prices it was computed
  // from. Cleared whenever the model entry changes (setUserState/dropUserState),
  // because a balance change invalidates the health factor outright.
  private localHfCache = new Map<string, { hf: bigint; prices: bigint[]; at: number }>();
  // How long a cached health factor may be used as a skip basis.
  //
  // This was 30s, which would have made the whole bound nearly useless in
  // production: Chainlink feeds update on deviation or heartbeat, and ETH/USD
  // ticks roughly once a minute, so a position's cache would routinely expire
  // before the next event that touches it and every evaluation would fall
  // through to the full recomputation anyway.
  //
  // The limit exists because interest accrual moves the health factor with no
  // price change, but that drift is tiny and — importantly — BOUNDED and known,
  // so it can be priced into the slack instead of forcing a short expiry. Ten
  // minutes at the conservative rate below costs 0.6 bps of headroom.
  private static readonly LOCAL_HF_CACHE_MS = 10 * 60_000;
  // Upper bound on how fast accrual can move a health factor, per second,
  // relative. Aave variable borrow rates spike but stay far under 100% APR
  // (3.2e-8/s); 1e-7 is roughly a 300% APR position and is used purely as a
  // ceiling, not an estimate.
  private static readonly LOCAL_HF_DRIFT_PER_SEC = 1e-7;
  // Floor slack covering float rounding in the ratio arithmetic, applied on top
  // of the age-scaled accrual allowance.
  private static readonly LOCAL_HF_BOUND_SLACK = 0.99999;

  private rememberLocalHf(
    address: string, state: UserState, prices: Map<string, bigint>, hf: bigint, nowMs: number,
  ): void {
    const snap: bigint[] = new Array(state.reserves.length);
    for (let i = 0; i < state.reserves.length; i++) {
      snap[i] = prices.get(state.reserves[i]!.asset) ?? 0n;
    }
    this.localHfCache.set(address, { hf, prices: snap, at: nowMs });
  }

  // True when the position provably cannot have crossed `ceiling` since its
  // cached evaluation. Conservative in the only direction that matters: any
  // uncertainty (missing price, stale cache, shape change) returns false and
  // falls through to the full recomputation.
  private canSkipLocalEval(
    address: string,
    state:   UserState,
    prices:  Map<string, bigint>,
    ceiling: bigint,
    nowMs:   number,
  ): boolean {
    const c = this.localHfCache.get(address);
    if (!c || c.hf <= 0n) return false;
    if (nowMs - c.at > PositionTracker.LOCAL_HF_CACHE_MS) return false;
    if (c.prices.length !== state.reserves.length) return false;   // model reshaped

    // min price ratio across collateral, max across debt — the two that bound
    // the health factor from below.
    let minCollR = Infinity;
    let maxDebtR = 0;
    for (let i = 0; i < state.reserves.length; i++) {
      const r = state.reserves[i]!;
      const prev = c.prices[i]!;
      if (prev <= 0n) return false;
      const cur = prices.get(r.asset);
      if (cur === undefined || cur <= 0n) return false;
      const ratio = Number(cur) / Number(prev);
      if (!Number.isFinite(ratio) || ratio <= 0) return false;

      if (r.usageAsCollateral && r.scaledATokenBalance > 0n) {
        if (ratio < minCollR) minCollR = ratio;
      }
      if (r.scaledVariableDebt > 0n) {
        if (ratio > maxDebtR) maxDebtR = ratio;
      }
    }
    // No collateral or no debt legs recorded — let the full path decide.
    if (minCollR === Infinity || maxDebtR === 0) return false;

    // Accrual allowance scales with how old the cached figure is, so a long-lived
    // entry is held to a proportionally stricter bound instead of being trusted
    // as much as a fresh one.
    const ageSec  = Math.max(0, (nowMs - c.at) / 1000);
    const accrual = 1 - PositionTracker.LOCAL_HF_DRIFT_PER_SEC * ageSec;
    const floorHf = (Number(c.hf) / 1e18) * (minCollR / maxDebtR)
                  * accrual * PositionTracker.LOCAL_HF_BOUND_SLACK;
    return floorHf >= Number(ceiling) / 1e18;
  }

  // Turn a user's scaled balances into real ones and compute the health factor,
  // applying e-mode exactly as Aave does. Returns null when a needed price is
  // missing — the polling sweep still covers those positions with authoritative
  // getUserAccountData.
  //
  // Not modelled: isolation-mode debt ceilings and siloed borrowing. Both make
  // the real position WEAKER than computed here, so ignoring them errs toward
  // firing on something that reverts cheaply, never toward missing a fire.
  private evaluateUserState(
    state:  UserState,
    prices: Map<string, bigint>,
    nowSec: number,
  ): {
    collaterals: AssetPosition[]; debts: AssetPosition[];
    hfE18: bigint; collateralUsd8: bigint; debtUsd8: bigint;
  } | null {
    const collaterals: AssetPosition[] = [];
    const debts:       AssetPosition[] = [];
    let ltAccum = 0n;  // Σ collateralValue(USD8) × liquidationThreshold(bps)
    let den     = 0n;  // Σ debtValue(USD8)
    let colUsd8Total = 0n;

    for (const r of state.reserves) {
      const reserve = this.reserves.get(r.asset);
      if (!reserve) return null;               // unknown reserve — can't model it
      const price = prices.get(r.asset);
      if (price === undefined || price === 0n) return null;
      const unit = BigInt(10 ** reserve.decimals);

      if (r.usageAsCollateral && r.scaledATokenBalance > 0n) {
        // rayMul, matching _getUserBalanceInBaseCurrency's scaledBalance.rayMul(index).
        const balance = rayMul(r.scaledATokenBalance, this.reserves.normalizedIncome(reserve, nowSec));
        if (balance > 0n) {
          const usd8 = (price * balance) / unit;
          colUsd8Total += usd8;
          // E-mode aware. A position in a category uses the CATEGORY threshold
          // for assets inside that category's collateral bitmap; assets OUTSIDE
          // it keep their own reserve threshold and still count as collateral.
          // (Aave 3.2 "liquid e-mode" — the previous comment here claimed such
          // assets contribute zero, which is neither what Aave does nor what
          // effectiveLiquidationThreshold returns.)
          const lt = BigInt(this.reserves.effectiveLiquidationThreshold(reserve, state.emodeId));
          ltAccum += usd8 * lt;
          collaterals.push({
            symbol: reserve.symbol, address: reserve.address, decimals: reserve.decimals,
            balance, balanceUsd: 0,
          });
        }
      }

      // Stable debt is deliberately absent: the deployed UiPoolDataProvider's
      // UserReserveData carries no stable fields (Aave 3.2 removed stable rate
      // borrowing), which is also why the 4-field tuple in UI_POOL_DATA_PROVIDER_ABI
      // decodes correctly. If a future upgrade reintroduces them this must be
      // revisited, because omitted debt overstates the health factor.
      if (r.scaledVariableDebt > 0n) {
        const balance = rayMul(r.scaledVariableDebt, this.reserves.normalizedVariableDebt(reserve, nowSec));
        if (balance > 0n) {
          den += (price * balance) / unit;
          debts.push({
            symbol: reserve.symbol, address: reserve.address, decimals: reserve.decimals,
            balance, balanceUsd: 0,
          });
        }
      }
    }

    if (den === 0n) return null;
    return {
      collaterals, debts,
      // Bit-exact with GenericLogic: truncate the average threshold to whole
      // bps first, then percentMul and wadDiv with half-up rounding.
      hfE18: healthFactorExact(colUsd8Total, ltAccum, den),
      collateralUsd8: colUsd8Total,
      debtUsd8: den,
    };
  }

  // Authoritative health factors for a handful of addresses, in one multicall.
  //
  // The model's ARITHMETIC is now a faithful replica of GenericLogic — Aave's
  // rounding, the truncated average liquidation threshold, compounded debt
  // interest — so given identical prices it agrees bit-for-bit and checkModel
  // reports EXACT.
  //
  // What remains is the price input, not the maths. The trigger's hot path feeds
  // the model snapshotAllPrices(), which mixes ratio-ESTIMATED prices with ones
  // up to the cache TTL old, while Aave values every asset at one instant. Two
  // live fires computed 0.9997 and 0.9992 against a real 1.0010 and 1.0014 and
  // both reverted with HealthFactorNotBelowThreshold(); that is a ~13-22 bps
  // price disagreement, far larger than any arithmetic term.
  //
  // Every call here therefore does double duty: it gates the fire, and it yields
  // a matched (model, chain) pair that ModelErrorTracker uses to measure that
  // residual rather than assume a constant for it.
  async confirmHealthFactors(addresses: string[]): Promise<Map<string, bigint>> {
    const out = new Map<string, bigint>();
    const targets = [...new Set(addresses.map(a => a.toLowerCase()))];
    if (targets.length === 0) return out;
    try {
      const results: Array<{ success: boolean; returnData: string }> = await this.multicall.tryAggregate(
        false,
        targets.map(addr => ({
          target:   AAVE_POOL,
          callData: IFACE.encodeFunctionData("getUserAccountData", [addr]),
        })),
      );
      for (let i = 0; i < targets.length; i++) {
        const r = results[i];
        if (!r?.success || r.returnData === "0x") continue;
        try {
          const d = IFACE.decodeFunctionResult("getUserAccountData", r.returnData);
          const hf = d.healthFactor as bigint;
          out.set(targets[i]!, hf);
          // Keep the tracked position in step with what the chain just told us.
          const pos = this.positions.get(targets[i]!);
          if (pos) {
            pos.healthFactor        = hf;
            pos.healthFactorNum     = Number(hf) / 1e18;
            pos.totalCollateralBase = d.totalCollateralBase as bigint;
            pos.totalDebtBase       = d.totalDebtBase as bigint;
          }
        } catch { /* skip undecodable */ }
      }
    } catch (e: any) {
      logger.debug(`confirmHealthFactors failed: ${e?.message ?? e}`);
    }
    return out;
  }

  // Addresses whose authoritative health factor was written by the most recent
  // refreshBatch. Used only for error sampling — see sampleModelError.
  private lastSwept: string[] = [];

  // Lowest-health-factor positions evaluated by the most recent
  // findLocalCandidates pass, with the model figure that pass computed.
  //
  // Separate from lastSwept and NOT interchangeable with it. These come from the
  // trigger's own price snapshot — ratio estimates, TTL-stale entries and all —
  // so they carry the error the fire decision is actually exposed to. lastSwept
  // carries prices the cycle had just refreshed authoritatively, which measures
  // something quite different. Conflating the two is exactly the mistake that
  // made the measured error read 0.0 bps against a real 11.5.
  private lastLocalEval: Array<{ addr: string; hf: bigint }> = [];
  private static readonly LOCAL_EVAL_SAMPLE_MAX = 8;

  // Cumulative effectiveness of the skip bound. Reported in the heartbeat
  // because the bound is only worth its complexity if it actually fires, and
  // that was invisible: its own log line is at debug, so a run could not show
  // whether trig.dispatch was fast because the bound worked or slow because it
  // silently never engaged.
  private boundSkipped   = 0;
  private boundEvaluated = 0;

  /** Skip-bound hit rate since process start, for the heartbeat. */
  boundStats(): { skipped: number; evaluated: number; pct: number } {
    const total = this.boundSkipped + this.boundEvaluated;
    return {
      skipped: this.boundSkipped,
      evaluated: this.boundEvaluated,
      pct: total > 0 ? (this.boundSkipped / total) * 100 : 0,
    };
  }

  private noteLocalEval(addr: string, hf: bigint): void {
    if (hf <= 0n) return;
    const arr = this.lastLocalEval;
    if (arr.length < PositionTracker.LOCAL_EVAL_SAMPLE_MAX) {
      arr.push({ addr, hf });
      arr.sort((a, b) => (a.hf < b.hf ? -1 : a.hf > b.hf ? 1 : 0));
      return;
    }
    // Keep the closest to the threshold — those are where a model error can
    // actually change the verdict.
    const worst = arr[arr.length - 1]!;
    if (hf < worst.hf) {
      arr[arr.length - 1] = { addr, hf };
      arr.sort((a, b) => (a.hf < b.hf ? -1 : a.hf > b.hf ? 1 : 0));
    }
  }

  /** Drain the near-threshold model evaluations from the last dispatch. */
  takeLocalEvalSamples(): Array<{ addr: string; hf: bigint }> {
    const out = this.lastLocalEval;
    this.lastLocalEval = [];
    return out;
  }

  // Pairs of (model health factor, chain health factor) for a few addresses the
  // sweep just read authoritatively.
  //
  // The trigger's fire decision rests on how far the model can be from the
  // chain, and the only source of matched pairs used to be the confirmations it
  // performs on marginal candidates. Those are rare — one sample in thirteen
  // hours of live running — so the measured distribution could not reach the
  // threshold where it becomes usable, and the engine stayed on the fallback
  // constant indefinitely.
  //
  // The sweep already pays for authoritative health factors on hundreds of
  // positions a cycle. Comparing a handful of them against the model costs
  // nothing extra in RPC and samples the whole health-factor range rather than
  // just the marginal band.
  //
  // `prices` MUST be the trigger's own snapshot, not the cycle's freshly-fetched
  // map: the quantity worth measuring is the error the trigger would actually
  // have made, which includes the staleness and ratio estimates in that snapshot.
  // Sampling against fresh prices would understate it and make the engine fire
  // blind more readily than the evidence supports.
  sampleModelError(prices: Map<string, bigint>, max = 5): Array<[bigint, bigint]> {
    const out: Array<[bigint, bigint]> = [];
    if (this.lastSwept.length === 0) return out;
    for (let i = 0; i < this.lastSwept.length && out.length < max; i++) {
      const addr = this.lastSwept[i]!;
      const pos = this.positions.get(addr);
      if (!pos || pos.healthFactor <= 0n) continue;
      const local = this.localHealthFactor(addr, prices);
      if (local === null || local <= 0n) continue;
      out.push([local, pos.healthFactor]);
    }
    this.lastSwept = [];
    return out;
  }

  // Rotating authoritative verification of the model, for trigger-only operation.
  //
  // With the sweep disabled nothing else reads a health factor from the chain,
  // so nothing would notice the model going wrong — an Aave upgrade, a reserve
  // added, an e-mode category changed — and the trigger would keep committing
  // gas against it with full confidence. This walks the whole watchlist in a
  // rotation at one multicall per tick so that drift shows up as arith-err
  // moving off zero, which is exactly the signal the sweep used to provide.
  //
  // The model figure is captured BEFORE confirmHealthFactors runs, because that
  // writes the chain value straight into pos.healthFactor and would otherwise
  // leave nothing to compare against.
  private auditCursor = 0;

  async auditModel(prices: Map<string, bigint>, n: number): Promise<Array<[bigint, bigint]>> {
    if (n <= 0) return [];
    const all = [...this.positions.keys(), ...this.dormant.keys()];
    if (all.length === 0) return [];

    const picks: string[] = [];
    const take = Math.min(n, all.length);
    for (let i = 0; i < take; i++) picks.push(all[(this.auditCursor + i) % all.length]!);
    this.auditCursor = (this.auditCursor + take) % all.length;

    const local = new Map<string, bigint>();
    for (const a of picks) {
      const h = this.localHealthFactor(a, prices);
      if (h !== null && h > 0n) local.set(a, h);
    }
    if (local.size === 0) return [];

    const chain = await this.confirmHealthFactors([...local.keys()]);
    const out: Array<[bigint, bigint]> = [];
    for (const [a, l] of local) {
      const c = chain.get(a);
      if (c !== undefined && c > 0n) out.push([l, c]);
    }
    return out;
  }

  // Evaluate an arbitrary user state through the PRODUCTION health-factor path.
  //
  // Exposed for checkModel.ts, which previously re-implemented the formula
  // inline. A validator that reimplements the thing it validates can agree with
  // Aave perfectly while the code that actually fires disagrees — it was
  // measuring a second opinion, not the model. Routing it through here means a
  // clean checkModel run is evidence about the real fire path.
  evaluateStateForDiagnostics(
    state:  UserState,
    prices: Map<string, bigint>,
    nowSec: number = Math.floor(Date.now() / 1000),
  ): { hfE18: bigint; collateralUsd8: bigint; debtUsd8: bigint;
       collaterals: AssetPosition[]; debts: AssetPosition[] } | null {
    return this.evaluateUserState(state, prices, nowSec);
  }

  // Health factor for one address straight from the model, or null if it can't
  // be computed. Used by the sweep to skip authoritative reads it doesn't need.
  localHealthFactor(address: string, prices: Map<string, bigint>): bigint | null {
    const state = this.userStates.get(address.toLowerCase());
    if (!state || !this.reserves.loaded) return null;
    const r = this.evaluateUserState(state, prices, Math.floor(Date.now() / 1000));
    return r ? r.hfE18 : null;
  }

  get size(): number { return this.positions.size; }
  get dormantSize(): number { return this.dormant.size; }

  // Reconcile the model against the tracked set.
  //
  // Every call site that removes a position now drops its model entry too, so in
  // steady state this finds nothing. It exists for the race those fixes cannot
  // close: refreshUserStates is asynchronous, and an address evicted while its
  // multicall was in flight has its entry written back after the eviction that
  // was supposed to remove it. One stray entry per such race is harmless in
  // isolation, but it accumulates and it makes modelCoverage report more
  // modelled users than tracked ones — a coverage figure above 100%, which is
  // not a number an operator should ever have to interpret.
  pruneModel(): number {
    let removed = 0;
    for (const addr of [...this.userStates.keys()]) {
      if (this.positions.has(addr) || this.dormant.has(addr)) continue;
      this.dropUserState(addr);
      removed++;
    }
    // The skip-bound cache is keyed the same way and is cleared alongside the
    // model on every normal path; this catches anything left for an address that
    // is no longer modelled at all.
    for (const addr of [...this.localHfCache.keys()]) {
      if (!this.userStates.has(addr)) this.localHfCache.delete(addr);
    }
    if (removed > 0) {
      logger.debug(`model reconcile: dropped ${removed} entries for untracked addresses`);
    }
    return removed;
  }

  // Bug #12 fix: periodically prune the full borrower cache to prevent unbounded growth.
  // After months of running, the full cache can contain 200k+ addresses (most long-repaid).
  // This method removes addresses not in the active or dormant maps.
  pruneFullCache(): void {
    const fullCache = loadFullCache();
    if (!fullCache) return;
    const activeAddrs = new Set([...this.positions.keys(), ...this.dormant.keys()]);
    const before = fullCache.borrowers.length;
    // Also keep denylisted addresses so they stay blocked after restart
    for (const addr of this.badDebtDenylist) activeAddrs.add(addr);
    fullCache.borrowers = fullCache.borrowers.filter(addr => activeAddrs.has(addr));
    const after = fullCache.borrowers.length;
    if (before !== after) {
      saveFullCache(BigInt(fullCache.scannedUpToBlock), fullCache.borrowers);
      logger.info(`Full cache pruned: ${before} → ${after} addresses (removed ${before - after} stale)`);
    }
  }

  // Returns a Set of all currently-watched addresses — used by index.ts to
  // prune the lastEvaluatedHF map without iterating over the full positions map.
  addressSet(): Set<string> {
    const s = new Set(this.positions.keys());
    for (const k of this.dormant.keys()) s.add(k);
    return s;
  }
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// True when the provider refused the request because the plan lacks archive
// access, rather than because the request itself was malformed or too large.
// Chainstack uses code -32002 with an "Archive, Debug and Trace requests are not
// available on your current plan" message; other providers word it differently.
export function isArchiveRestricted(e: any): boolean {
  const code = e?.error?.code ?? e?.info?.error?.code;
  const msg  = String(
    e?.error?.message ?? e?.info?.error?.message ?? e?.info?.responseBody ?? e?.message ?? ""
  );
  return code === -32002 || /archive|not available on your current plan|upgrade/i.test(msg);
}
