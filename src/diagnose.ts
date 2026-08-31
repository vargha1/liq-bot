/**
 * diagnose.ts — Consolidated diagnostic script
 *
 * Usage:
 *   npm run diagnose          Basic scan (default)
 *   npm run diagnose:deep     Deep analysis (--deep flag)
 *   npm run diag-excel        Excel workbook output (--excel flag)
 *
 * Flags:
 *   --deep   Show detailed skip-reason analysis for every candidate
 *   --excel  Generate a multi-sheet Excel workbook with live HF data
 *
 * Replaces: diagnose.ts, diagnose2.ts, diagnose3.ts
 */
import "dotenv/config";
import { ethers } from "ethers";
import * as path from "path";
import * as fs from "fs";
import {
  CONFIG, AAVE_POOL, AAVE_POOL_ABI, RESERVES,
  UI_POOL_DATA_PROVIDER, UI_POOL_DATA_PROVIDER_ABI,
  POOL_ADDRESSES_PROVIDER, MULTICALL3, MULTICALL3_ABI,
  AAVE_ORACLE, ORACLE_ABI,
} from "./config";
import { PositionTracker } from "./positions";
import { ReserveRegistry } from "./reserveState";
import { AaveOracle } from "./oracle";
import { Evaluator } from "./evaluator";

// ═══════════════════════════════════════════════════════════════════════════════
// CLI flag parsing
// ═══════════════════════════════════════════════════════════════════════════════
const args = process.argv.slice(2);
const flagDeep  = args.includes("--deep");
const flagExcel = args.includes("--excel");

// ═══════════════════════════════════════════════════════════════════════════════
// Terminal colours
// ═══════════════════════════════════════════════════════════════════════════════
const G = "\x1b[32m", R = "\x1b[31m", Y = "\x1b[33m", C = "\x1b[36m";
const B = "\x1b[1m", DIM = "\x1b[2m", RST = "\x1b[0m";

// ═══════════════════════════════════════════════════════════════════════════════
// Constants shared across modes
// ═══════════════════════════════════════════════════════════════════════════════
const HF_ONE   = 10n ** 18n;
const HF_WATCH = 130n * 10n ** 16n;   // 1.30 — used by Excel tier logic
const MAX_UINT = BigInt("115792089237316195423570985008687907853269984665640564039457584007913129639935");

// Cache file paths (for --excel mode)
const CACHE_FILE      = path.resolve(process.cwd(), "active-cache.json");
const FULL_CACHE_FILE = path.resolve(process.cwd(), "borrowers-cache.json");
const DENYLIST_FILE   = path.resolve(process.cwd(), "bad-debt-denylist.json");
const OUTPUT_FILE     = path.resolve(process.cwd(), "diagnose-output.xlsx");

// Multicall chunk size for --excel mode
const MC_CHUNK       = 1_500;
const MC_CONCURRENCY = 8;

// ═══════════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════════
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function formatDuration(ms: number): string {
  if (ms <= 0) return "now";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem > 0 ? `${h}h ${rem}m` : `${h}h`;
}

function loadJSON<T>(file: string): T | null {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch { return null; }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MODE 1: Basic scan (replaces original diagnose.ts)
// ═══════════════════════════════════════════════════════════════════════════════
async function runBasicScan(): Promise<void> {
  console.log(`\n${B}${C}════════════════════════════════════════════════${RST}`);
  console.log(`${B}${C}   Aave V3 Liquidation Bot — Diagnostic          ${RST}`);
  console.log(`${B}${C}════════════════════════════════════════════════${RST}\n`);

  const httpProvider = new ethers.JsonRpcProvider(CONFIG.rpcUrl, { chainId: 42161, name: "arbitrum" });
  const block    = await httpProvider.getBlockNumber();
  const feeData  = await httpProvider.getFeeData();
  const gweiNow  = Number(feeData.gasPrice ?? 0n) / 1e9;
  const gasPrice = feeData.gasPrice ?? 0n;

  console.log(`${G}Connected${RST} | block=${block} | gas=${gweiNow.toFixed(4)} gwei`);
  if (gweiNow > CONFIG.maxGasGwei) {
    console.log(`${Y}⚠️  Gas too high (${gweiNow.toFixed(3)} > ${CONFIG.maxGasGwei} gwei)${RST}`);
  }

  const getProvider = () => httpProvider;
  const reserveRegistry = new ReserveRegistry(getProvider);
  await reserveRegistry.refreshAll();
  const oracle    = new AaveOracle(getProvider);
  const evaluator = new Evaluator(oracle, getProvider, reserveRegistry);
  const ethPrice  = await evaluator.getEthPrice();
  console.log(`ETH price: $${ethPrice.toFixed(2)}\n`);

  const tracker = new PositionTracker(getProvider, reserveRegistry);
  console.log("Seeding from Aave subgraph…");
  await tracker.seed();
  tracker.setCurrentBlock(BigInt(block));
  console.log(`Loaded ${tracker.size} borrowers\n`);

  console.log(`${B}Checking ${CONFIG.positionsPerCycle} highest-risk positions…${RST}\n`);
  console.log("─".repeat(70));

  const atRisk = await tracker.refreshBatch(CONFIG.positionsPerCycle);

  if (atRisk.length === 0) {
    console.log(`${DIM}No liquidatable positions in this batch (HF ≥ 1.0 for all checked).`);
    console.log(`This is normal during calm markets. The bot monitors continuously.${RST}`);
  } else {
    console.log(`${R}${B}Found ${atRisk.length} liquidatable position(s):${RST}\n`);

    const allPrices   = await oracle.prefetchAllPrices();
    const ethPriceUsd = await evaluator.getEthPrice();

    for (const pos of atRisk) {
      const collUsd = Number(pos.totalCollateralBase) / 1e8;
      const debtUsd = Number(pos.totalDebtBase) / 1e8;
      console.log(
        `${R}●${RST} ${B}${pos.address}${RST}\n` +
        `  HF=${pos.healthFactorNum.toFixed(6)}  collateral=$${collUsd.toFixed(0)}  debt=$${debtUsd.toFixed(0)}`
      );

      const { collaterals, debts } = await tracker.getAssetBreakdown(pos.address);

      if (collaterals.length > 0) {
        console.log(`  Collaterals: ${collaterals.map(c => c.symbol).join(", ")}`);
      }
      if (debts.length > 0) {
        console.log(`  Debts:       ${debts.map(d => d.symbol).join(", ")}`);
      }

      const opp = await evaluator.evaluate(pos, collaterals, debts, gasPrice, allPrices, ethPriceUsd);
      if (opp && opp !== "EVICT") {
        console.log(
          `  ${G}${B}→ PROFITABLE: bonus=$${opp.expectedBonusUsd.toFixed(2)} ` +
          `gas=$${opp.gasCostUsd.toFixed(2)} net=$${opp.netProfitUsd.toFixed(2)}${RST}`
        );
        console.log(
          `     Liquidate ${opp.debtSymbol} debt, receive ${opp.collateralSymbol} collateral`
        );
      } else {
        console.log(`  ${Y}→ Below profit threshold ($${CONFIG.minProfitUsd})${RST}`);
      }
      console.log();
    }
  }

  console.log("─".repeat(70));
  console.log(`\n${B}Liquidation bonuses by asset (on Arbitrum V3):${RST}`);
  for (const [sym, r] of Object.entries(RESERVES)) {
    const bonus = ((r.liquidationBonus - 10000) / 100).toFixed(1);
    console.log(`  ${sym.padEnd(8)} ${bonus}% bonus  (threshold=${r.liquidationThreshold / 100}%)`);
  }

  console.log(`\n${B}Config:${RST}`);
  console.log(`  Min profit    : $${CONFIG.minProfitUsd}`);
  console.log(`  Positions/cyc : ${CONFIG.positionsPerCycle}`);

  console.log("\n✅ Diagnostic complete.\n");
}

// ═══════════════════════════════════════════════════════════════════════════════
// MODE 2: Deep analysis (--deep flag, replaces diagnose2.ts)
// ═══════════════════════════════════════════════════════════════════════════════
async function runDeepAnalysis(): Promise<void> {
  console.log(`\n${B}${C}════════════════════════════════════════════════${RST}`);
  console.log(`${B}${C}   Aave V3 Liquidation Bot — Deep Diagnostic      ${RST}`);
  console.log(`${B}${C}════════════════════════════════════════════════${RST}\n`);

  const provider = new ethers.JsonRpcProvider(CONFIG.rpcUrl, { chainId: 42161, name: "arbitrum" });
  const block = await provider.getBlockNumber();
  console.log(`${B}Connected${RST} | block=${block}\n`);

  const getProvider = () => provider;
  const reserveRegistry = new ReserveRegistry(getProvider);
  await reserveRegistry.refreshAll();
  const oracle    = new AaveOracle(getProvider);
  const evaluator = new Evaluator(oracle, getProvider, reserveRegistry);
  const tracker   = new PositionTracker(getProvider, reserveRegistry);

  await tracker.seed();
  tracker.setCurrentBlock(BigInt(block));

  const candidates = await tracker.refreshBatch(CONFIG.positionsPerCycle);
  console.log(`${B}refreshBatch found: ${candidates.length} liquidatable${RST}\n`);

  if (candidates.length === 0) {
    console.log(`${Y}No candidates found at all — check HF thresholds in positions.ts${RST}`);
    return;
  }

  const feeData  = await provider.getFeeData();
  const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice ?? 100_000_000n;
  const gweiNow  = Number(gasPrice) / 1e9;
  const allPrices   = await oracle.prefetchAllPrices();
  const ethPriceUsd = await evaluator.getEthPrice();

  console.log(`Gas: ${gweiNow.toFixed(4)} gwei | ETH: $${ethPriceUsd.toFixed(2)}\n`);
  console.log("─".repeat(80));

  const HF_EVAL_THRESHOLD = 990n * 10n ** 15n;
  const MIN_DEBT_USD      = 10;

  let countHFAbove1    = 0;
  let countTooSmall    = 0;
  let countBorderline  = 0;
  let countNoBreakdown = 0;
  let countNotProfitable = 0;
  let countProfitable  = 0;

  const limit = Math.min(candidates.length, 20);

  for (const pos of candidates.slice(0, limit)) {
    const debtUsd = Number(pos.totalDebtBase) / 1e8;
    const collUsd = Number(pos.totalCollateralBase) / 1e8;

    process.stdout.write(
      `\n${B}${pos.address}${RST}\n` +
      `  HF=${pos.healthFactorNum.toFixed(6)} | debt=$${debtUsd.toFixed(2)} | coll=$${collUsd.toFixed(2)}\n`
    );

    if (pos.healthFactor >= HF_ONE) {
      console.log(`  ${Y}→ SKIP: HF >= 1.0 (${pos.healthFactorNum.toFixed(6)})${RST}`);
      countHFAbove1++; continue;
    }
    if (debtUsd < MIN_DEBT_USD) {
      console.log(`  ${Y}→ SKIP: debt too small ($${debtUsd.toFixed(2)} < $${MIN_DEBT_USD})${RST}`);
      countTooSmall++; continue;
    }
    if (pos.healthFactor >= HF_EVAL_THRESHOLD) {
      console.log(`  ${Y}→ SKIP: borderline HF (${pos.healthFactorNum.toFixed(6)} >= 0.990)${RST}`);
      countBorderline++; continue;
    }

    // Try breakdown
    const { collaterals, debts } = await tracker.getAssetBreakdown(pos.address);
    console.log(`  Collaterals (${collaterals.length}): ${collaterals.map(c => `${c.symbol}(${c.balance})`).join(", ") || "NONE"}`);
    console.log(`  Debts       (${debts.length}): ${debts.map(d => `${d.symbol}(${d.balance})`).join(", ") || "NONE"}`);

    if (!collaterals.length || !debts.length) {
      console.log(`  ${R}→ SKIP: no breakdown — UiPoolDataProvider returned empty${RST}`);
      countNoBreakdown++;

      // Try raw UiPoolDataProvider call to debug
      try {
        const uiContract = new ethers.Contract(UI_POOL_DATA_PROVIDER, UI_POOL_DATA_PROVIDER_ABI, provider);
        const [rawReserves] = await uiContract.getUserReservesData(POOL_ADDRESSES_PROVIDER, pos.address);
        console.log(`  ${DIM}UiProvider raw result: ${rawReserves.length} reserve entries${RST}`);
        for (const r of rawReserves) {
          if (r.scaledATokenBalance > 0n || r.scaledVariableDebt > 0n || r.principalStableDebt > 0n) {
            console.log(`    ${r.underlyingAsset.toLowerCase()} aToken=${r.scaledATokenBalance} varDebt=${r.scaledVariableDebt} collEnabled=${r.usageAsCollateralEnabledOnUser}`);
          }
        }
      } catch (e: any) {
        console.log(`  ${R}UiPoolDataProvider raw call failed: ${e.message}${RST}`);
      }
      continue;
    }

    // Evaluate
    const opp = await evaluator.evaluate(pos, collaterals, debts, gasPrice, allPrices, ethPriceUsd);
    if (!opp || opp === "EVICT") {
      countNotProfitable++;
      // Show why — manually compute bonus for each coll/debt pair
      for (const debt of debts) {
        const debtPrice = allPrices.get(debt.address.toLowerCase()) ?? 0n;
        const dUsd = Number(debtPrice * debt.balance) / (1e8 * 10**debt.decimals);
        for (const coll of collaterals) {
          const collPrice = allPrices.get(coll.address.toLowerCase()) ?? 0n;
          const cUsd = Number(collPrice * coll.balance) / (1e8 * 10**coll.decimals);
          const res  = RESERVES[coll.symbol];
          const bonus = res ? (res.liquidationBonus - 10000) / 100 : 0;
          const gross = dUsd * 0.5 * (bonus / 100);
          const gasEst = Number(550_000n * gasPrice) / 1e18 * ethPriceUsd;
          console.log(
            `  ${Y}→ ${coll.symbol}/${debt.symbol}: debtUsd=$${dUsd.toFixed(2)} collUsd=$${cUsd.toFixed(2)} ` +
            `bonus=${bonus}% grossEst=$${gross.toFixed(2)} gas=$${gasEst.toFixed(2)} net=$${(gross-gasEst).toFixed(2)}${RST}`
          );
        }
      }
    } else {
      countProfitable++;
      console.log(
        `  ${G}${B}→ PROFITABLE: ${opp.collateralSymbol}→${opp.debtSymbol} ` +
        `debt=$${opp.debtToCoverUsd.toFixed(2)} bonus=$${opp.expectedBonusUsd.toFixed(2)} ` +
        `gas=$${opp.gasCostUsd.toFixed(2)} net=$${opp.netProfitUsd.toFixed(2)}${RST}`
      );
    }
  }

  console.log("\n" + "─".repeat(80));
  console.log(`${B}Summary (first ${limit} candidates):${RST}`);
  console.log(`  HF≥1.0:       ${countHFAbove1}`);
  console.log(`  Too small:    ${countTooSmall}`);
  console.log(`  Borderline:   ${countBorderline}  ← HF between 0.990 and 1.0`);
  console.log(`  No breakdown: ${countNoBreakdown}  ← UiPoolDataProvider returned no assets`);
  console.log(`  Unprofitable: ${countNotProfitable}`);
  console.log(`  ${G}PROFITABLE:   ${countProfitable}${RST}`);
  console.log();

  console.log("\n✅ Deep diagnostic complete.\n");
}

// ═══════════════════════════════════════════════════════════════════════════════
// MODE 3: Excel output (--excel flag, replaces diagnose3.ts)
// ═══════════════════════════════════════════════════════════════════════════════

// ── Excel types ──────────────────────────────────────────────────────────────
interface CacheFile {
  scannedUpToBlock: number;
  borrowers: string[];
  dormant?: Array<[string, string, number]>;
}

interface PositionRow {
  address: string;
  healthFactor: number;
  totalCollateralUsd: number;
  totalDebtUsd: number;
  ltv: number;
  liqThreshold: number;
  tier: "liquidatable" | "danger" | "watch" | "healthy";
  source: "active" | "dormant";
  lastKnownHF?: number;
  dormantSince?: string;
  recheckIn?: string;
}

function hfTier(hf: number): PositionRow["tier"] {
  if (hf < 1.0)  return "liquidatable";
  if (hf < 1.30) return "danger";
  if (hf < 2.0)  return "watch";
  return "healthy";
}

// ── Multicall fetch ───────────────────────────────────────────────────────────
async function fetchAccountData(
  addrs: string[],
  provider: ethers.JsonRpcProvider,
): Promise<Map<string, { hf: number; colUsd: number; debtUsd: number; ltv: number; liqThreshold: number }>> {
  const iface     = new ethers.Interface(AAVE_POOL_ABI);
  const multicall = new ethers.Contract(MULTICALL3, MULTICALL3_ABI, provider);
  const result    = new Map<string, { hf: number; colUsd: number; debtUsd: number; ltv: number; liqThreshold: number }>();

  const chunks: string[][] = [];
  for (let i = 0; i < addrs.length; i += MC_CHUNK) chunks.push(addrs.slice(i, i + MC_CHUNK));

  const total = addrs.length;
  let done = 0;

  for (let w = 0; w < chunks.length; w += MC_CONCURRENCY) {
    const wave = chunks.slice(w, w + MC_CONCURRENCY);
    await Promise.allSettled(wave.map(async (chunk) => {
      const calls = chunk.map(addr => ({
        target: AAVE_POOL,
        callData: iface.encodeFunctionData("getUserAccountData", [addr]),
      }));
      try {
        const results: Array<{ success: boolean; returnData: string }> =
          await multicall.tryAggregate(false, calls);
        for (let i = 0; i < chunk.length; i++) {
          const r = results[i];
          if (!r?.success || r.returnData === "0x") continue;
          try {
            const d = iface.decodeFunctionResult("getUserAccountData", r.returnData);
            const hfRaw  = d.healthFactor as bigint;
            const colRaw = d.totalCollateralBase as bigint;
            const dbtRaw = d.totalDebtBase as bigint;
            if (dbtRaw === 0n) continue;
            result.set(chunk[i]!.toLowerCase(), {
              hf:           hfRaw >= MAX_UINT ? 999 : Number(hfRaw) / 1e18,
              colUsd:       Number(colRaw) / 1e8,
              debtUsd:      Number(dbtRaw) / 1e8,
              ltv:          Number(d.ltv as bigint) / 100,
              liqThreshold: Number(d.currentLiquidationThreshold as bigint) / 100,
            });
          } catch { /* skip undecoded */ }
        }
      } catch (e: any) {
        console.warn(`  Multicall wave failed: ${e.message}`);
      }
    }));

    done += wave.reduce((s, c) => s + c.length, 0);
    const pct = ((done / total) * 100).toFixed(0);
    process.stdout.write(`\r  Fetching ${done}/${total} (${pct}%)...`);
    if (w + MC_CONCURRENCY < chunks.length) await sleep(50);
  }
  console.log();
  return result;
}

// ── Excel styling helpers ─────────────────────────────────────────────────────
const COLORS = {
  headerBg:      "FF1F3864",
  headerFg:      "FFFFFFFF",
  liquidatable:  "FFFF4444",
  danger:        "FFFF8C00",
  watch:         "FFFFFF00",
  healthy:       "FF90EE90",
  dormantBg:     "FFF0F0F0",
  altRowBg:      "FFF8F8FF",
  summaryLabel:  "FF2E4057",
  summaryValue:  "FF048A81",
};

async function runExcelOutput(): Promise<void> {
  // Lazy-import ExcelJS — only needed for --excel mode
  const ExcelJS = (await import("exceljs")).default;

  console.log("\n╔══════════════════════════════════════════════╗");
  console.log("║  Aave V3 Bot — Excel Diagnostic               ║");
  console.log("╚══════════════════════════════════════════════╝\n");

  const provider = new ethers.JsonRpcProvider(CONFIG.rpcUrl, undefined, { staticNetwork: true });
  const block    = await provider.getBlockNumber();
  console.log(`Connected to Arbitrum | block=${block}`);

  // Load caches
  const activeCache = loadJSON<CacheFile>(CACHE_FILE);
  const fullCache   = loadJSON<CacheFile>(FULL_CACHE_FILE);
  const denylist    = loadJSON<string[]>(DENYLIST_FILE) ?? [];

  if (!activeCache && !fullCache) {
    console.error("No cache files found. Run the bot first to seed borrower data.");
    process.exit(1);
  }

  const dormantMap = new Map<string, { lastHF: bigint; dormantSince: number }>();
  if (activeCache?.dormant) {
    for (const [addr, hfHex, ts] of activeCache.dormant) {
      dormantMap.set(addr.toLowerCase(), { lastHF: BigInt("0x" + hfHex), dormantSince: ts });
    }
  }

  // Active = all positions in active cache that aren't dormant
  const activeAddrs = (activeCache?.borrowers ?? [])
    .map(a => a.toLowerCase())
    .filter(a => !dormantMap.has(a));

  const dormantAddrs = [...dormantMap.keys()];

  const maxPositions = parseInt(process.env["MAX_POSITIONS"] ?? "99999", 10);
  const activeToFetch  = activeAddrs.slice(0, maxPositions);
  const dormantToFetch = dormantAddrs.slice(0, maxPositions);

  console.log(`\nActive positions : ${activeToFetch.length.toLocaleString()}`);
  console.log(`Dormant positions: ${dormantToFetch.length.toLocaleString()}`);
  console.log(`Bad-debt denylist: ${denylist.length.toLocaleString()}`);

  // Fetch live data
  console.log("\nFetching live health factor data for active positions…");
  const activeData = await fetchAccountData(activeToFetch, provider);

  console.log("Fetching health factor data for dormant positions…");
  const dormantData = await fetchAccountData(dormantToFetch, provider);

  // Build row arrays
  const now = Date.now();
  const DORMANT_RECHECK_MS = 60 * 60_000;

  const activeRows: PositionRow[] = [];
  for (const addr of activeToFetch) {
    const d = activeData.get(addr);
    if (!d) continue;
    activeRows.push({
      address:            addr,
      healthFactor:       d.hf,
      totalCollateralUsd: d.colUsd,
      totalDebtUsd:       d.debtUsd,
      ltv:                d.ltv,
      liqThreshold:       d.liqThreshold,
      tier:               hfTier(d.hf),
      source:             "active",
    });
  }
  activeRows.sort((a, b) => a.healthFactor - b.healthFactor);

  const dormantRows: PositionRow[] = [];
  for (const addr of dormantToFetch) {
    const meta   = dormantMap.get(addr)!;
    const liveD  = dormantData.get(addr);
    const lastHF = Number(meta.lastHF) / 1e18;
    const elapsed      = now - meta.dormantSince;
    const recheckInMs  = Math.max(0, DORMANT_RECHECK_MS - elapsed);
    dormantRows.push({
      address:            addr,
      healthFactor:       liveD?.hf ?? lastHF,
      totalCollateralUsd: liveD?.colUsd ?? 0,
      totalDebtUsd:       liveD?.debtUsd ?? 0,
      ltv:                liveD?.ltv ?? 0,
      liqThreshold:       liveD?.liqThreshold ?? 0,
      tier:               hfTier(liveD?.hf ?? lastHF),
      source:             "dormant",
      lastKnownHF:        lastHF,
      dormantSince:       new Date(meta.dormantSince).toISOString().replace("T", " ").slice(0, 19),
      recheckIn:          formatDuration(recheckInMs),
    });
  }
  dormantRows.sort((a, b) => (a.healthFactor ?? 999) - (b.healthFactor ?? 999));

  const allRows = [...activeRows, ...dormantRows];

  const dangerRows       = allRows.filter(r => r.healthFactor < 1.30 && r.healthFactor >= 1.0);
  const liquidatableRows = allRows.filter(r => r.healthFactor < 1.0);
  const watchRows        = allRows.filter(r => r.healthFactor >= 1.30 && r.healthFactor < 2.0);
  const healthyRows      = allRows.filter(r => r.healthFactor >= 2.0);

  const totalDebtWatched = allRows.reduce((s, r) => s + r.totalDebtUsd, 0);
  const totalColWatched  = allRows.reduce((s, r) => s + r.totalCollateralUsd, 0);
  const topDanger        = [...liquidatableRows, ...dangerRows]
    .slice(0, 20)
    .map(r => ({ addr: r.address, hf: r.healthFactor, debtUsd: r.totalDebtUsd }));

  console.log(`\nResults:`);
  console.log(`  Liquidatable (HF < 1.0):  ${liquidatableRows.length}`);
  console.log(`  Danger       (HF 1.0–1.3): ${dangerRows.length}`);
  console.log(`  Watch        (HF 1.3–2.0): ${watchRows.length}`);
  console.log(`  Healthy      (HF > 2.0):   ${healthyRows.length}`);

  // ── Build workbook ───────────────────────────────────────────────────────────
  console.log("\nBuilding Excel workbook…");
  const wb = new (ExcelJS as any).Workbook();
  wb.creator = "Aave V3 Liquidation Bot — diagnose";
  wb.created = new Date();

  // ── Helper: header style ─────────────────────────────────────────────────────
  function headerStyle(ws: any, row: number, cols: number): void {
    const r = ws.getRow(row);
    for (let c = 1; c <= cols; c++) {
      const cell = r.getCell(c);
      cell.font = { bold: true, color: { argb: COLORS.headerFg }, size: 10, name: "Arial" };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.headerBg } };
      cell.alignment = { horizontal: "center", vertical: "middle" };
      cell.border = {
        bottom: { style: "thin", color: { argb: "FFAAAAAA" } },
      };
    }
    r.height = 20;
  }

  function tierFill(tier: PositionRow["tier"]): any {
    const color = tier === "liquidatable" ? COLORS.liquidatable
      : tier === "danger" ? COLORS.danger
      : tier === "watch"  ? COLORS.watch
      : "FF00000000";
    return { type: "pattern", pattern: "solid", fgColor: { argb: color } };
  }

  function setColWidths(ws: any, widths: number[]): void {
    widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  }

  function addHyperlink(cell: any, addr: string): void {
    cell.value = {
      text: addr,
      hyperlink: `https://arbiscan.io/address/${addr}`,
    };
    cell.font = { color: { argb: "FF0563C1" }, underline: true, size: 9, name: "Arial" };
  }

  // ── Build position sheet ─────────────────────────────────────────────────────
  function buildPositionSheet(
    wb_: any,
    name: string,
    rows: PositionRow[],
    isDormant: boolean,
  ): void {
    const ws = wb_.addWorksheet(name);

    const headers = isDormant
      ? ["Address", "Last HF", "Last Col ($)", "Last Debt ($)", "Dormant Since", "Recheck In", "Tier"]
      : ["Address", "Health Factor", "Collateral ($)", "Debt ($)", "LTV (%)", "Liq. Threshold (%)", "Tier"];

    headers.forEach((h, i) => { ws.getCell(1, i + 1).value = h; });
    headerStyle(ws, 1, headers.length);
    setColWidths(ws, isDormant
      ? [46, 14, 14, 14, 22, 14, 14]
      : [46, 14, 14, 14, 10, 18, 14]);
    ws.getRow(1).height = 20;

    rows.forEach((row, idx) => {
      const r = ws.getRow(idx + 2);
      r.height = 16;

      if (isDormant) {
        addHyperlink(r.getCell(1), row.address);
        r.getCell(2).value = row.lastKnownHF ?? row.healthFactor;
        r.getCell(3).value = row.totalCollateralUsd > 0 ? row.totalCollateralUsd : "";
        r.getCell(4).value = row.totalDebtUsd > 0 ? row.totalDebtUsd : "";
        r.getCell(5).value = row.dormantSince ?? "";
        r.getCell(6).value = row.recheckIn ?? "";
        r.getCell(7).value = row.tier.toUpperCase();
      } else {
        addHyperlink(r.getCell(1), row.address);
        r.getCell(2).value = row.healthFactor < 900 ? row.healthFactor : "∞";
        r.getCell(3).value = row.totalCollateralUsd;
        r.getCell(4).value = row.totalDebtUsd;
        r.getCell(5).value = row.ltv;
        r.getCell(6).value = row.liqThreshold;
        r.getCell(7).value = row.tier.toUpperCase();
      }

      // Number formats
      if (!isDormant) {
        r.getCell(2).numFmt = "0.0000";
        r.getCell(3).numFmt = "$#,##0.00";
        r.getCell(4).numFmt = "$#,##0.00";
        r.getCell(5).numFmt = "0.0";
        r.getCell(6).numFmt = "0.0";
      } else {
        r.getCell(2).numFmt = "0.0000";
        r.getCell(3).numFmt = "$#,##0.00";
        r.getCell(4).numFmt = "$#,##0.00";
      }

      // Tier colour on the Tier cell
      const tierCell = r.getCell(7);
      tierCell.fill = tierFill(row.tier);
      tierCell.font = { bold: true, size: 9, name: "Arial" };
      tierCell.alignment = { horizontal: "center" };

      // Alternate row background
      if (row.tier === "healthy" || isDormant) {
        const bg = idx % 2 === 0 ? "FFFFFFFF" : COLORS.altRowBg;
        for (let c = 1; c <= headers.length - 1; c++) {
          r.getCell(c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: bg } };
        }
      }

      // Apply font to non-link cells
      for (let c = 2; c <= headers.length; c++) {
        const cell = r.getCell(c);
        if (!cell.font?.underline) {
          cell.font = { size: 9, name: "Arial" };
        }
      }
    });

    // Auto-filter + freeze header
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } };
    ws.views = [{ state: "frozen", ySplit: 1 }];
  }

  // ── Build Summary sheet ──────────────────────────────────────────────────────
  function buildSummarySheet(
    wb_: any,
    stats: {
      fetchedAt: string;
      blockNumber: number;
      activeCount: number;
      dormantCount: number;
      denylistCount: number;
      liquidatableCount: number;
      dangerCount: number;
      watchCount: number;
      healthyCount: number;
      topDanger: Array<{ addr: string; hf: number; debtUsd: number }>;
      totalDebtWatched: number;
      totalColWatched: number;
    },
  ): void {
    const ws = wb_.addWorksheet("Summary");
    setColWidths(ws, [32, 22, 46, 20, 20, 20]);

    // Title block
    const title = ws.getCell("A1");
    title.value = "Aave V3 Arbitrum — Bot Diagnostic Report";
    title.font  = { bold: true, size: 16, name: "Arial", color: { argb: COLORS.headerBg } };
    ws.mergeCells("A1:F1");

    const sub = ws.getCell("A2");
    sub.value = `Generated: ${stats.fetchedAt}  |  Block: ${stats.blockNumber.toLocaleString()}`;
    sub.font  = { size: 10, name: "Arial", color: { argb: "FF666666" }, italic: true };
    ws.mergeCells("A2:F2");
    ws.getRow(1).height = 32;
    ws.getRow(2).height = 18;

    // Stats table
    const statRows: Array<[string, string | number]> = [
      ["--- Position Counts ---", ""],
      ["Active (watching)",       stats.activeCount],
      ["Dormant (1-hr recheck)",  stats.dormantCount],
      ["Bad-debt denylist",       stats.denylistCount],
      ["Total known borrowers",   stats.activeCount + stats.dormantCount + stats.denylistCount],
      ["", ""],
      ["--- Risk Tiers (active) ---", ""],
      ["Liquidatable (HF < 1.0)",  stats.liquidatableCount],
      ["Danger      (HF 1.0-1.3)", stats.dangerCount],
      ["Watch       (HF 1.3-2.0)", stats.watchCount],
      ["Healthy     (HF > 2.0)",   stats.healthyCount],
      ["", ""],
      ["--- Portfolio ---", ""],
      ["Total collateral watched", `$${stats.totalColWatched.toLocaleString("en-US", { maximumFractionDigits: 0 })}`],
      ["Total debt watched",       `$${stats.totalDebtWatched.toLocaleString("en-US", { maximumFractionDigits: 0 })}`],
    ];

    statRows.forEach(([label, val], i) => {
      const r = ws.getRow(i + 4);
      r.height = 18;
      const lCell = r.getCell(1);
      const vCell = r.getCell(2);
      lCell.value = label;
      vCell.value = val;

      if (String(label).startsWith("---")) {
        lCell.font = { bold: true, size: 10, name: "Arial", color: { argb: COLORS.summaryLabel } };
        ws.mergeCells(`A${i + 4}:B${i + 4}`);
      } else if (label !== "") {
        lCell.font = { size: 10, name: "Arial" };
        vCell.font = { bold: true, size: 10, name: "Arial", color: { argb: COLORS.summaryValue } };
        vCell.alignment = { horizontal: "right" };
      }

      // Colour the tier rows
      if (label.includes("Liquidatable")) { vCell.fill = tierFill("liquidatable"); }
      if (label.includes("Danger"))       { vCell.fill = tierFill("danger"); }
      if (label.includes("Watch"))        { vCell.fill = tierFill("watch"); }
    });

    // Top danger positions
    if (stats.topDanger.length > 0) {
      const startRow = statRows.length + 6;
      const hdr = ws.getRow(startRow);
      hdr.getCell(1).value = "Top At-Risk Positions";
      hdr.getCell(1).font = { bold: true, size: 11, name: "Arial", color: { argb: COLORS.headerBg } };
      ws.mergeCells(`A${startRow}:F${startRow}`);
      hdr.height = 22;

      const colHdr = ws.getRow(startRow + 1);
      ["Address", "Health Factor", "Debt (USD)", "Arbiscan Link"].forEach((h, i) => {
        colHdr.getCell(i + 1).value = h;
      });
      headerStyle(ws, startRow + 1, 4);

      stats.topDanger.forEach((pos, i) => {
        const r = ws.getRow(startRow + 2 + i);
        r.height = 16;
        r.getCell(1).value = pos.addr;
        r.getCell(2).value = pos.hf;
        r.getCell(2).numFmt = "0.0000";
        r.getCell(3).value = pos.debtUsd;
        r.getCell(3).numFmt = "$#,##0.00";
        addHyperlink(r.getCell(4), pos.addr);
        r.getCell(2).fill = tierFill(hfTier(pos.hf));
        for (let c = 1; c <= 4; c++) {
          if (!r.getCell(c).font?.underline) r.getCell(c).font = { size: 9, name: "Arial" };
        }
      });
    }
  }

  // Build sheets
  buildSummarySheet(wb, {
    fetchedAt:         new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC",
    blockNumber:       block,
    activeCount:       activeRows.length,
    dormantCount:      dormantRows.length,
    denylistCount:     denylist.length,
    liquidatableCount: liquidatableRows.length,
    dangerCount:       dangerRows.length,
    watchCount:        watchRows.length,
    healthyCount:      healthyRows.length,
    topDanger,
    totalDebtWatched,
    totalColWatched,
  });

  buildPositionSheet(wb, "Active", activeRows, false);
  buildPositionSheet(wb, "Dormant", dormantRows, true);
  buildPositionSheet(wb, "Danger Tier", dangerRows, false);

  if (liquidatableRows.length > 0) {
    buildPositionSheet(wb, "Liquidatable", liquidatableRows, false);
  } else {
    const ws = wb.addWorksheet("Liquidatable");
    ws.getCell("A1").value = "No liquidatable positions found at this block.";
    ws.getCell("A1").font = { bold: true, size: 12, name: "Arial", color: { argb: "FF008000" } };
  }

  await wb.xlsx.writeFile(OUTPUT_FILE);
  console.log(`\n✅ Saved: ${OUTPUT_FILE}`);
  console.log(`   Sheets: Summary | Active (${activeRows.length}) | Dormant (${dormantRows.length}) | Danger Tier (${dangerRows.length}) | Liquidatable (${liquidatableRows.length})\n`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Main entry point — dispatch based on flags
// ═══════════════════════════════════════════════════════════════════════════════
async function main(): Promise<void> {
  if (flagDeep && flagExcel) {
    console.log(`${Y}Note: --deep and --excel are mutually exclusive. Running --deep.${RST}\n`);
  }

  if (flagDeep) {
    await runDeepAnalysis();
  } else if (flagExcel) {
    await runExcelOutput();
  } else {
    await runBasicScan();
  }
}

main().catch(err => { console.error(`${R}Fatal: ${err?.message}${RST}`); process.exit(1); });
