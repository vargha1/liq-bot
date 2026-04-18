/**
 * diagnose3.ts — npm run diag-excel
 *
 * Fetches live health-factor data for all watched + dormant borrowers via
 * Multicall3 and writes a detailed Excel workbook to diagnose3-output.xlsx.
 *
 * Sheets:
 *   1. Summary       — overview stats, danger counts, top opportunities
 *   2. Active        — all active (non-dormant) positions with live HF data
 *   3. Dormant       — all dormant positions with last-known HF + time until recheck
 *   4. Danger Tier   — positions with HF < 1.30, sorted by HF ascending
 *   5. Liquidatable  — positions with HF < 1.00 (should be empty in a healthy market)
 *
 * Usage:
 *   npm run diag-excel
 *   # or with options:
 *   MAX_POSITIONS=5000 npm run diag-excel
 */

import "dotenv/config";
import { ethers } from "ethers";
import * as path from "path";
import * as fs from "fs";
import ExcelJS from "exceljs";
import {
  CONFIG,
  AAVE_POOL, AAVE_POOL_ABI, MULTICALL3, MULTICALL3_ABI,
  RESERVES,
} from "./config";

// ── constants ────────────────────────────────────────────────────────────────
const HF_ONE   = 10n ** 18n;
const HF_WATCH = 130n * 10n ** 16n;   // 1.30

const CACHE_FILE      = path.resolve(process.cwd(), "active-cache.json");
const FULL_CACHE_FILE = path.resolve(process.cwd(), "borrowers-cache.json");
const DENYLIST_FILE   = path.resolve(process.cwd(), "bad-debt-denylist.json");
const OUTPUT_FILE     = path.resolve(process.cwd(), "diagnose3-output.xlsx");

// Multicall chunk size — 1500 addresses per call works on Tenderly/Alchemy
const CHUNK = 1_500;
// Max concurrent multicall waves to avoid flooding the RPC
const CONCURRENCY = 8;

interface CacheFile {
  scannedUpToBlock: number;
  borrowers: string[];
  dormant?: Array<[string, string, number]>; // [addr, hfHex, dormantSinceMs]
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
  lastKnownHF?: number;    // dormant only
  dormantSince?: string;   // dormant only — human readable
  recheckIn?: string;      // dormant only
}

// ── helpers ──────────────────────────────────────────────────────────────────
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function hfTier(hf: number): PositionRow["tier"] {
  if (hf < 1.0)  return "liquidatable";
  if (hf < 1.30) return "danger";
  if (hf < 2.0)  return "watch";
  return "healthy";
}

function formatDuration(ms: number): string {
  if (ms <= 0) return "now";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem > 0 ? `${h}h ${rem}m` : `${h}h`;
}

// ── load caches ───────────────────────────────────────────────────────────────
function loadJSON<T>(file: string): T | null {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch { return null; }
}

// ── multicall fetch ───────────────────────────────────────────────────────────
async function fetchAccountData(
  addrs: string[],
  provider: ethers.JsonRpcProvider,
): Promise<Map<string, { hf: number; colUsd: number; debtUsd: number; ltv: number; liqThreshold: number }>> {
  const iface     = new ethers.Interface(AAVE_POOL_ABI);
  const multicall = new ethers.Contract(MULTICALL3, MULTICALL3_ABI, provider);
  const result    = new Map<string, { hf: number; colUsd: number; debtUsd: number; ltv: number; liqThreshold: number }>();

  const chunks: string[][] = [];
  for (let i = 0; i < addrs.length; i += CHUNK) chunks.push(addrs.slice(i, i + CHUNK));

  const total = addrs.length;
  let done = 0;

  for (let w = 0; w < chunks.length; w += CONCURRENCY) {
    const wave = chunks.slice(w, w + CONCURRENCY);
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
            if (dbtRaw === 0n) continue; // no debt — skip
            result.set(chunk[i]!.toLowerCase(), {
              hf:           hfRaw >= BigInt("115792089237316195423570985008687907853269984665640564039457584007913129639935")
                            ? 999 : Number(hfRaw) / 1e18,
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
    if (w + CONCURRENCY < chunks.length) await sleep(50);
  }
  console.log(); // newline after progress
  return result;
}

// ── Excel styling helpers ─────────────────────────────────────────────────────
const COLORS = {
  headerBg:      "FF1F3864",  // dark navy
  headerFg:      "FFFFFFFF",
  liquidatable:  "FFFF4444",  // red
  danger:        "FFFF8C00",  // orange
  watch:         "FFFFFF00",  // yellow
  healthy:       "FF90EE90",  // light green
  dormantBg:     "FFF0F0F0",  // light grey
  altRowBg:      "FFF8F8FF",
  summaryLabel:  "FF2E4057",
  summaryValue:  "FF048A81",
};

function headerStyle(ws: ExcelJS.Worksheet, row: number, cols: number): void {
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

function tierFill(tier: PositionRow["tier"]): ExcelJS.Fill {
  const color = tier === "liquidatable" ? COLORS.liquidatable
    : tier === "danger" ? COLORS.danger
    : tier === "watch"  ? COLORS.watch
    : "FF00000000"; // transparent for healthy
  return { type: "pattern", pattern: "solid", fgColor: { argb: color } };
}

function setColWidths(ws: ExcelJS.Worksheet, widths: number[]): void {
  widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
}

function addHyperlink(cell: ExcelJS.Cell, addr: string): void {
  cell.value = {
    text: addr,
    hyperlink: `https://arbiscan.io/address/${addr}`,
  };
  cell.font = { color: { argb: "FF0563C1" }, underline: true, size: 9, name: "Arial" };
}

// ── build Active / Dormant / Danger / Liquidatable sheets ────────────────────
function buildPositionSheet(
  wb: ExcelJS.Workbook,
  name: string,
  rows: PositionRow[],
  isDormant: boolean,
): void {
  const ws = wb.addWorksheet(name);

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

    // Tier colour on the Tier cell + row background
    const tierCell = r.getCell(7);
    tierCell.fill = tierFill(row.tier);
    tierCell.font = { bold: true, size: 9, name: "Arial" };
    tierCell.alignment = { horizontal: "center" };

    // Alternate row background (only if not coloured by tier)
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

  // Auto-filter
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } };
  ws.views = [{ state: "frozen", ySplit: 1 }];
}

// ── build Summary sheet ───────────────────────────────────────────────────────
function buildSummarySheet(
  wb: ExcelJS.Workbook,
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
  const ws = wb.addWorksheet("Summary");
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
    ["─── Position Counts ───", ""],
    ["Active (watching)",       stats.activeCount],
    ["Dormant (1-hr recheck)",  stats.dormantCount],
    ["Bad-debt denylist",       stats.denylistCount],
    ["Total known borrowers",   stats.activeCount + stats.dormantCount + stats.denylistCount],
    ["", ""],
    ["─── Risk Tiers (active) ───", ""],
    ["🔴 Liquidatable (HF < 1.0)",  stats.liquidatableCount],
    ["🟠 Danger      (HF 1.0–1.3)", stats.dangerCount],
    ["🟡 Watch       (HF 1.3–2.0)", stats.watchCount],
    ["🟢 Healthy     (HF > 2.0)",   stats.healthyCount],
    ["", ""],
    ["─── Portfolio ───", ""],
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

    if (String(label).startsWith("───")) {
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

// ── main ──────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log("\n╔══════════════════════════════════════════════╗");
  console.log("║  Aave V3 Bot — Excel Diagnostic (diagnose3)  ║");
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

  // Fetch live data for active positions
  console.log("\nFetching live health factor data for active positions…");
  const activeData = await fetchAccountData(activeToFetch, provider);

  // For dormant, fetch live data too (gives us real current HF at report time)
  console.log("Fetching health factor data for dormant positions…");
  const dormantData = await fetchAccountData(dormantToFetch, provider);

  // Build row arrays
  const now = Date.now();
  const DORMANT_RECHECK_MS = 60 * 60_000; // 1 hour (matches positions.ts)

  const activeRows: PositionRow[] = [];
  for (const addr of activeToFetch) {
    const d = activeData.get(addr);
    if (!d) continue; // no debt → skip
    activeRows.push({
      address:           addr,
      healthFactor:      d.hf,
      totalCollateralUsd: d.colUsd,
      totalDebtUsd:      d.debtUsd,
      ltv:               d.ltv,
      liqThreshold:      d.liqThreshold,
      tier:              hfTier(d.hf),
      source:            "active",
    });
  }
  activeRows.sort((a, b) => a.healthFactor - b.healthFactor);

  const dormantRows: PositionRow[] = [];
  const DORMANT_RECHECK_WINDOW = DORMANT_RECHECK_MS;
  for (const addr of dormantToFetch) {
    const meta   = dormantMap.get(addr)!;
    const liveD  = dormantData.get(addr);
    const lastHF = Number(meta.lastHF) / 1e18;
    const elapsed      = now - meta.dormantSince;
    const recheckInMs  = Math.max(0, DORMANT_RECHECK_WINDOW - elapsed);
    dormantRows.push({
      address:           addr,
      healthFactor:      liveD?.hf ?? lastHF,
      totalCollateralUsd: liveD?.colUsd ?? 0,
      totalDebtUsd:      liveD?.debtUsd ?? 0,
      ltv:               liveD?.ltv ?? 0,
      liqThreshold:      liveD?.liqThreshold ?? 0,
      tier:              hfTier(liveD?.hf ?? lastHF),
      source:            "dormant",
      lastKnownHF:       lastHF,
      dormantSince:      new Date(meta.dormantSince).toISOString().replace("T", " ").slice(0, 19),
      recheckIn:         formatDuration(recheckInMs),
    });
  }
  dormantRows.sort((a, b) => (a.healthFactor ?? 999) - (b.healthFactor ?? 999));

  const allRows = [...activeRows, ...dormantRows];

  const dangerRows        = allRows.filter(r => r.healthFactor < 1.30 && r.healthFactor >= 1.0);
  const liquidatableRows  = allRows.filter(r => r.healthFactor < 1.0);
  const watchRows         = allRows.filter(r => r.healthFactor >= 1.30 && r.healthFactor < 2.0);
  const healthyRows       = allRows.filter(r => r.healthFactor >= 2.0);

  const totalDebtWatched  = allRows.reduce((s, r) => s + r.totalDebtUsd, 0);
  const totalColWatched   = allRows.reduce((s, r) => s + r.totalCollateralUsd, 0);
  const topDanger         = [...liquidatableRows, ...dangerRows]
    .slice(0, 20)
    .map(r => ({ addr: r.address, hf: r.healthFactor, debtUsd: r.totalDebtUsd }));

  console.log(`\nResults:`);
  console.log(`  Liquidatable (HF < 1.0):  ${liquidatableRows.length}`);
  console.log(`  Danger       (HF 1.0–1.3): ${dangerRows.length}`);
  console.log(`  Watch        (HF 1.3–2.0): ${watchRows.length}`);
  console.log(`  Healthy      (HF > 2.0):   ${healthyRows.length}`);

  // Build workbook
  console.log("\nBuilding Excel workbook…");
  const wb = new ExcelJS.Workbook();
  wb.creator = "Aave V3 Liquidation Bot — diagnose3";
  wb.created = new Date();

  // Summary sheet first
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

  // Active sheet
  buildPositionSheet(wb, "Active", activeRows, false);

  // Dormant sheet
  buildPositionSheet(wb, "Dormant", dormantRows, true);

  // Danger Tier sheet (HF 1.0 – 1.30, active + dormant)
  buildPositionSheet(wb, "Danger Tier", dangerRows, false);

  // Liquidatable sheet
  if (liquidatableRows.length > 0) {
    buildPositionSheet(wb, "🔴 Liquidatable", liquidatableRows, false);
  } else {
    const ws = wb.addWorksheet("🔴 Liquidatable");
    ws.getCell("A1").value = "✅ No liquidatable positions found at this block.";
    ws.getCell("A1").font = { bold: true, size: 12, name: "Arial", color: { argb: "FF008000" } };
  }

  await wb.xlsx.writeFile(OUTPUT_FILE);
  console.log(`\n✅ Saved: ${OUTPUT_FILE}`);
  console.log(`   Sheets: Summary | Active (${activeRows.length}) | Dormant (${dormantRows.length}) | Danger Tier (${dangerRows.length}) | 🔴 Liquidatable (${liquidatableRows.length})\n`);
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
