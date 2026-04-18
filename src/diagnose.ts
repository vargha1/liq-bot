/**
 * diagnose.ts — npm run diagnose
 * Shows current at-risk and liquidatable Aave V3 positions on Arbitrum.
 * No transactions fired.
 */
import "dotenv/config";
import { ethers } from "ethers";
import { CONFIG, AAVE_POOL, AAVE_POOL_ABI, RESERVES } from "./config";
import { PositionTracker } from "./positions";
import { AaveOracle } from "./oracle";
import { Evaluator } from "./evaluator";

const G = "\x1b[32m", R = "\x1b[31m", Y = "\x1b[33m", C = "\x1b[36m";
const B = "\x1b[1m", DIM = "\x1b[2m", RST = "\x1b[0m";

async function main() {
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

  // FIX: PositionTracker and AaveOracle now accept a provider getter function
  const getProvider = () => httpProvider;
  const oracle    = new AaveOracle(getProvider);
  const evaluator = new Evaluator(oracle, getProvider);
  const ethPrice  = await evaluator.getEthPrice();
  console.log(`ETH price: $${ethPrice.toFixed(2)}\n`);

  const tracker = new PositionTracker(getProvider);
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

    // FIX 4.3: Pre-fetch all prices once for the diagnostic run
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

  // ── Reserve summary ────────────────────────────────────────────────────────
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

main().catch(err => { console.error(`${R}Fatal: ${err?.message}${RST}`); process.exit(1); });
