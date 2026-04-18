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

// ── Constants ──────────────────────────────────────────────────────────────────
const HF_ONE   = 10n ** 18n;
const HF_WATCH = 130n * 10n ** 16n;   // 1.30 — prune threshold (delete if HF > this)
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
const SCAN_CHUNK        = 2_000n;
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
interface BorrowerCache {
  scannedUpToBlock: number;
  borrowers: string[];
  // Dormant positions survive restarts so the 6-hour recheck window isn't reset.
  // Stored as [address, lastHF (hex string), dormantSince (ms timestamp)] tuples.
  dormant?: Array<[string, string, number]>;
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
  try {
    fs.writeFileSync(DENYLIST_FILE, JSON.stringify([...denylist]), "utf8");
  } catch (e: any) { logger.warn(`Denylist save failed: ${e.message}`); }
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

function saveCache(scannedUpToBlock: bigint, borrowers: string[], dormant?: Map<string, { lastHF: bigint; dormantSince: number }>): void {
  try {
    const dormantArr: Array<[string, string, number]> = dormant
      ? [...dormant.entries()].map(([addr, e]) => [addr, e.lastHF.toString(16), e.dormantSince])
      : [];
    fs.writeFileSync(CACHE_FILE, JSON.stringify({
      scannedUpToBlock: Number(scannedUpToBlock),
      borrowers,
      dormant: dormantArr,
    }), "utf8");
    logger.info(`Active cache saved: ${borrowers.length} borrowers + ${dormantArr.length} dormant at block ${scannedUpToBlock}`);
  } catch (e: any) { logger.warn(`Active cache write failed: ${e.message}`); }
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
  try {
    fs.writeFileSync(FULL_CACHE_FILE, JSON.stringify({ scannedUpToBlock: Number(scannedUpToBlock), borrowers }), "utf8");
    logger.info(`Full cache saved: ${borrowers.length} borrowers at block ${scannedUpToBlock}`);
  } catch (e: any) { logger.warn(`Full cache write failed: ${e.message}`); }
}


// ── Topic hashes ───────────────────────────────────────────────────────────────
const IFACE                  = new ethers.Interface(AAVE_POOL_ABI);
const DATA_PROVIDER_IFACE    = new ethers.Interface(DATA_PROVIDER_ABI);
const TOPIC_BORROW           = IFACE.getEvent("Borrow")!.topicHash;
const TOPIC_SUPPLY           = IFACE.getEvent("Supply")!.topicHash;
const TOPIC_REPAY            = IFACE.getEvent("Repay")!.topicHash;
const TOPIC_WITHDRAW         = IFACE.getEvent("Withdraw")!.topicHash;
const TOPIC_LIQUIDATION_CALL = IFACE.getEvent("LiquidationCall")!.topicHash;
export const MONITORED_TOPICS = [TOPIC_BORROW, TOPIC_SUPPLY, TOPIC_REPAY, TOPIC_WITHDRAW, TOPIC_LIQUIDATION_CALL];

// ── Breakdown cache entry ──────────────────────────────────────────────────────
interface BreakdownEntry {
  collaterals: AssetPosition[];
  debts:       AssetPosition[];
  expiresAt:   bigint;  // block number after which the entry is stale
}

export class PositionTracker {
  private positions      = new Map<string, BorrowerPosition>();
  private priorityQueue  = new Set<string>();
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
  private dormant = new Map<string, { lastHF: bigint; dormantSince: number }>();
  private static readonly DORMANT_RECHECK_MS = 1 * 60 * 60 * 1000; // 1 hour (was 6h)
  // Tracks last-known HF for danger positions. If HF is identical across consecutive
  // cycles, skip re-queuing that position for DANGER_SKIP_BLOCKS to free slots.
  // Reset whenever an Aave event touches that address (via breakdownCache invalidation).
  // NOTE: set to 1 — danger positions should be re-checked every other cycle at minimum.
  // A 3-cycle skip on Arbitrum = 750ms blind window where other bots can front-run.
  private lastDangerHF = new Map<string, { hf: bigint; stableFor: number }>();
  private static readonly DANGER_SKIP_BLOCKS = 1;  // skip only 1 cycle of unchanged HF

  private rebuildDangerList(): void {
    this.dangerList = [...this.positions.values()]
      .filter(p => p.healthFactor > 0n && p.healthFactor < HF_WATCH)
      .sort((a, b) => (a.healthFactor < b.healthFactor ? -1 : 1));
    this.dangerDirty = false;
  }

  private markDangerDirty(): void { this.dangerDirty = true; }

  // FIX: max positions to wake per 5-min interval — prevents thundering-herd
  // when thousands of positions were parked simultaneously (e.g. after prune).
  // With ~16k dormant and a 1-hour window, steady-state wakes are ~22/interval.
  // Cap at 500 to absorb any burst while still making forward progress.
  private static readonly MAX_DORMANT_WAKE_PER_INTERVAL = 500;

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
    const jitterMs = Math.floor(Math.random() * 15 * 60_000); // 0–15 min
    this.dormant.set(addr, { lastHF: hf, dormantSince: Date.now() + jitterMs });
  }

  // Wake dormant positions that hold a specific collateral asset.
  // Called when a price drop is detected for that asset — these positions may
  // now be liquidatable even though they were healthy when last checked.
  // Uses the dormant map's lastHF as a heuristic: only wake positions whose
  // last known HF was below 1.50 (i.e. a 2% price drop could push them under 1.0).
  wakeByCollateralAssets(droppedAssetAddrs: Set<string>): void {
    if (droppedAssetAddrs.size === 0) return;
    // We don't store which collateral assets a dormant position holds (that would
    // require keeping full breakdown data for every dormant entry). Instead we
    // wake ALL dormant positions whose last HF was below a conservative threshold —
    // a 2% price drop on a single collateral can push HF from 1.30 to <1.0 when
    // the collateral has a high concentration in the position.
    const HF_VULNERABLE = 140n * 10n ** 16n; // 1.40 — conservative safety margin
    let woke = 0;
    for (const [addr, entry] of this.dormant) {
      if (entry.lastHF < HF_VULNERABLE && !this.badDebtDenylist.has(addr)) {
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
        woke++;
      }
    }
    if (woke > 0) {
      logger.info(
        `⚡ Price-drop wake: ${woke} vulnerable dormant positions re-activated ` +
        `(${this.dormant.size} still dormant, ${this.positions.size} active)`
      );
    }
  }
  // Called periodically by index.ts. Re-inserts them into the active rotation
  // at their last known HF so the rotation tier picks them up naturally.
  // FIX: Capped at MAX_DORMANT_WAKE_PER_INTERVAL per call to prevent thundering
  // herds when thousands of positions all expire at the same time (e.g. post-prune).
  // Remaining expired entries are processed in the next interval(s).
  wakeExpiredDormant(): void {
    const now = Date.now();
    let woke = 0;
    for (const [addr, entry] of this.dormant) {
      if (woke >= PositionTracker.MAX_DORMANT_WAKE_PER_INTERVAL) break;
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
      logger.info(`dormant: woke ${woke} positions for recheck (${this.dormant.size} still dormant, ${this.positions.size} active)`);
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

  private getProvider(): ethers.Provider { return this._getProvider(); }

  constructor(private _getProvider: () => ethers.Provider) {}

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
      }
      if (addr) {
        const key = addr.toLowerCase();
        logger.debug(`${source} ${parsed.name}: ${key}`);
        this.upsert(key, `live:${parsed.name}`, true);
        // FIX 4.2: Invalidate breakdown cache on any event for this address
        // so the next breakdown call gets fresh data immediately.
        this.breakdownCache.delete(key);
        this.lastDangerHF.delete(key);  // force re-check on next cycle after any event
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

    // Process one chunk — returns number pruned from this chunk
    const processChunk = async (chunk: string[]): Promise<number> => {
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
        logger.warn(`Prune chunk failed: ${e.message} — skipping ${chunk.length} addresses`);
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
      try { await this.getProvider().getNetwork(); } catch {
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
        for (const [addr, hfHex, dormantSince] of activeCache.dormant) {
          // Drop entries that have already expired (past their 6-hour window) —
          // they'll be re-seeded from the full cache and checked on first rotation.
          if (now - dormantSince < PositionTracker.DORMANT_RECHECK_MS) {
            this.dormant.set(addr, { lastHF: BigInt("0x" + hfHex), dormantSince });
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
  private activeWsProvider: ethers.WebSocketProvider | null = null;

  async startEventMonitoring(wsProvider: ethers.WebSocketProvider, onSubId: (id: string) => void): Promise<void> {
    // ── Gap-fill: catch events missed during disconnect ───────────────────
    try {
      const current = BigInt(await wsProvider.getBlockNumber());
      if (current > this.lastEventBlock) {
        const fromBlock = current - this.lastEventBlock > 2_000n
          ? current - 2_000n   // cap — older gaps covered by position cache
          : this.lastEventBlock;
        logger.info(`Gap-filling ${fromBlock}→${current}…`);
        const logs = await wsProvider.getLogs({
          address: AAVE_POOL,
          topics:  [MONITORED_TOPICS],
          fromBlock,
          toBlock:  current,
        });
        logger.info(`  Gap-fill: ${logs.length} events`);
        for (const log of logs) this.handleRawLog(log, "gap-fill");
        this.lastEventBlock = current;
        this.currentBlock   = current;
      }
    } catch (e: any) { logger.warn(`Gap-fill failed: ${e.message}`); }

    // ── Remove stale listeners from previous provider instance ────────────
    // This prevents duplicate handlers when reconnecting.
    if (this.activeWsProvider && this.logFilter) {
      try { this.activeWsProvider.removeListener(this.logFilter, this._onLog); } catch { /* ignore */ }
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
    try {
      wsProvider.on(this.logFilter, this._onLog);
      logger.info("Subscribed to Aave logs via ethers provider.on()");
    } catch (e: any) {
      logger.warn(`provider.on(logs) failed: ${e.message}`);
    }
  }

  // Arrow function so `this` is bound correctly when passed as a listener
  private _onLog = (log: ethers.Log): void => {
    try {
      if (!log.removed) this.handleRawLog(log, "ws-log");
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

  async refreshBatch(batchSize: number): Promise<BorrowerPosition[]> {
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
          // HF has been identical for DANGER_SKIP_BLOCKS cycles — skip for now.
          // Will be re-included once stableFor resets (event or HF change).
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

    // Multicall3 — batch all getUserAccountData into a single RPC call.
    // Falls back to individual calls if multicall reverts (e.g. provider doesn't support it).
    // PERF: Uses module-level IFACE constant — avoids new Interface() allocation every cycle.
    const liquidatable: BorrowerPosition[] = [];
    try {
      const calls = batch.map(addr => ({
        target: AAVE_POOL,
        callData: IFACE.encodeFunctionData("getUserAccountData", [addr]),
      }));

      // tryAggregate(false) never reverts — returns (success, data) per call
      const results: Array<{ success: boolean; returnData: string }> =
        await this.multicall.tryAggregate(false, calls);

      for (let i = 0; i < batch.length; i++) {
        const addr    = batch[i]!;
        const result  = results[i];
        if (!result?.success || result.returnData === "0x") {
          logger.debug(`multicall skip ${addr}: call failed`);
          continue;
        }
        try {
          const decoded = IFACE.decodeFunctionResult("getUserAccountData", result.returnData);
          const pos = this.processAccountData(addr, decoded);
          if (pos !== null) {
            // Skip re-insertion if this address was evicted as bad debt
            if (this.badDebtDenylist.has(pos.address)) {
              this.positions.delete(pos.address);
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
                // Will be re-checked after DORMANT_RECHECK_MS (6 hours) or on next live event.
                this.parkAsDormant(pos.address, pos.healthFactor);
              } else if (pos.healthFactor < HF_WATCH) {
                // In danger tier — track HF stability
                const prev = this.lastDangerHF.get(addr);
                if (prev && prev.hf === pos.healthFactor) {
                  this.lastDangerHF.set(addr, { hf: pos.healthFactor, stableFor: prev.stableFor + 1 });
                } else {
                  this.lastDangerHF.set(addr, { hf: pos.healthFactor, stableFor: 0 });
                }
              }
            }
          }
        } catch (e: any) {
          logger.debug(`multicall decode ${addr}: ${e.message}`);
        }
      }
    } catch (e: any) {
      // Multicall unavailable — fall back to individual parallel calls in chunks of 25
      logger.warn(`Multicall failed (${e.message}), falling back to individual calls`);
      // If the provider itself was destroyed (reconnect in progress), abort immediately
      // rather than hammering N individual calls that will all fail the same way.
      if (e.code === 'UNSUPPORTED_OPERATION' || /provider destroyed|cancelled request/i.test(e.message)) {
        return liquidatable;
      }
      const CHUNK = 25;
      for (let i = 0; i < batch.length; i += CHUNK) {
        const results = await Promise.allSettled(batch.slice(i, i + CHUNK).map(addr => this.refreshOne(addr)));
        for (const r of results) {
          if (r.status !== "fulfilled" || !r.value) continue;
          const pos = r.value;
          if (this.badDebtDenylist.has(pos.address)) {
            this.positions.delete(pos.address);
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
                this.lastDangerHF.set(pos.address, { hf: pos.healthFactor, stableFor: prev.stableFor + 1 });
              } else {
                this.lastDangerHF.set(pos.address, { hf: pos.healthFactor, stableFor: 0 });
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
    if (debt < MIN_DEBT_USD8) {
      this.positions.delete(address);
      this.markRotationDirty();
      this.markDangerDirty(); // FIX: danger list may contain this address — mark stale
      return null;
    }
    const hf    = d.healthFactor as bigint;
    const hfNum = Number(hf) / 1e18;
    // HF=0 AND collateral=0 means Aave bad-debt write-off: no collateral bonus
    // to capture regardless of debt size. Evict permanently.
    //
    // BUG FIX: Previous check (hfNum < 0.01 && debt < $100) missed 0xf740382c:
    // HF=0, $201 DAI debt, $0 WETH collateral — looped with collValue=$0 forever.
    // Now we check hf===0n && totalCollateralBase===0n (the definitive signal).
    const totalCollateral = d.totalCollateralBase as bigint;
    if (hf === 0n && totalCollateral === 0n) {
      logger.info(`Bad debt evicted: ${address} (HF=0, col=$0, debt=$${(Number(debt)/1e8).toFixed(2)}) -- no collateral to liquidate`);
      this.positions.delete(address);
      this.dormant.delete(address);
      this.markRotationDirty();
      this.markDangerDirty(); // FIX: danger list may contain this address — mark stale
      // FIX: add to denylist so this address is blocked on re-seed/re-scan.
      // Without this, restarts re-seed the address from cache, re-evaluate it, and re-evict —
      // wasting a cycle and logging a false "liquidatable" every restart indefinitely.
      this.badDebtDenylist.add(address);
      saveDenylist(this.badDebtDenylist);
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

  // ── Asset breakdown ───────────────────────────────────────────────────────────
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
      const [userReserves]: [Array<{
        underlyingAsset:               string;
        scaledATokenBalance:           bigint;
        usageAsCollateralEnabledOnUser: boolean;
        scaledVariableDebt:            bigint;
      }>] = await this.uiDataProvider.getUserReservesData(POOL_ADDRESSES_PROVIDER, address);

      for (const ur of userReserves) {
        const hasActivity = ur.scaledATokenBalance > 0n || ur.scaledVariableDebt > 0n;
        if (!hasActivity) continue;
        const assetAddr = ur.underlyingAsset.toLowerCase();
        const reserve = Object.values(RESERVES).find(r => r.address.toLowerCase() === assetAddr);
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
          hasDebt:       ur.scaledVariableDebt > 0n,
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
          this.breakdownCache.set(address, { ...result, expiresAt: this.currentBlock + cacheBlocks });
          return result;
        }

        // UiProvider returned slots but all balances came back zero — position closed
        const empty = { collaterals: [], debts: [] };
        this.breakdownCache.set(address, { ...empty, expiresAt: this.currentBlock + cacheBlocks });
        return empty;

      } catch (e: any) {
        // Provider destroyed: abort immediately, don't try Step 3
        if (e.code === 'UNSUPPORTED_OPERATION' || /provider destroyed|cancelled request/i.test(e.message)) {
          return { collaterals: [], debts: [] };
        }
        logger.warn(`Multicall breakdown failed for ${address.slice(0,10)}: ${e.message} — full fallback`);
        useFullFallback = true;
      }
    } else if (!useFullFallback && relevantAssets.length === 0) {
      // UiProvider succeeded but returned no active slots — position closed
      const empty = { collaterals: [], debts: [] };
      this.breakdownCache.set(address, { ...empty, expiresAt: this.currentBlock + cacheBlocks });
      return empty;
    }

    // ── Step 3: Full fallback — Multicall3 across all RESERVES ───────────────
    // Runs when: (a) UiProvider failed, OR (b) unknown asset detected.
    // Still uses Multicall3 for a single batched call instead of N parallel ones.
    const allReserves = Object.values(RESERVES);
    const fallbackCalls = allReserves.map(reserve => ({
      target:   AAVE_DATA_PROVIDER,
      callData: dataProviderIface.encodeFunctionData("getUserReserveData", [reserve.address, address]),
    }));

    try {
      const results: Array<{ success: boolean; returnData: string }> =
        await this.multicall.tryAggregate(false, fallbackCalls);

      for (let i = 0; i < allReserves.length; i++) {
        const reserve = allReserves[i]!;
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
      // Spawning N individual calls against a dead socket just hangs for 45s each.
      if (e.code === 'UNSUPPORTED_OPERATION' || /provider destroyed|cancelled request/i.test(e.message)) {
        logger.debug(`Full fallback aborted (provider destroyed) for ${address.slice(0,10)}`);
        return { collaterals: [], debts: [] };
      }
      // Last resort: parallel individual calls if multicall itself fails for other reasons
      logger.warn(`Full fallback multicall failed: ${e.message} — individual calls`);
      await Promise.allSettled(allReserves.map(async (reserve) => {
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

    const result = { collaterals: collaterals.filter(c => c.balance > 0n), debts: debts.filter(d => d.balance > 0n) };
    this.breakdownCache.set(address, { ...result, expiresAt: this.currentBlock + cacheBlocks });
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
      // Only warm the top 30 positions with HF closest to 1.0 — these are
      // the only ones that could cross the liquidation threshold in the next
      // few blocks. Warming 400 positions costs ~12s of RPC time; warming 30
      // costs ~1s. The cycle's hot path only ever executes 1-3 of these anyway.
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
        .slice(0, 30);  // top 30 most-at-risk only

      if (toWarm.length === 0) return;
      logger.debug(`prewarm: warming ${toWarm.length} most-at-risk danger positions`);

      // Low concurrency (3) with 30ms gaps — prewarm is best-effort background work.
      // It must not compete with the main cycle's RPC budget.
      const PREWARM_CONCURRENCY = 3;
      for (let i = 0; i < toWarm.length; i += PREWARM_CONCURRENCY) {
        const batch = toWarm.slice(i, i + PREWARM_CONCURRENCY);
        await Promise.allSettled(
          batch.map(pos => this.getAssetBreakdown(pos.address).catch(() => {}))
        );
        if (i + PREWARM_CONCURRENCY < toWarm.length) await sleep(30);
      }
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

  get size(): number { return this.positions.size; }
  get dormantSize(): number { return this.dormant.size; }

  // Returns a Set of all currently-watched addresses — used by index.ts to
  // prune the lastEvaluatedHF map without iterating over the full positions map.
  addressSet(): Set<string> {
    const s = new Set(this.positions.keys());
    for (const k of this.dormant.keys()) s.add(k);
    return s;
  }
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
