/**
 * diagnose2.ts - Deep diagnostic to reveal exactly why candidates are being skipped
 * Run: npx tsx src/diagnose2.ts
 */
import "dotenv/config";
import { ethers } from "ethers";
import {
  CONFIG, AAVE_POOL, AAVE_POOL_ABI, RESERVES,
  UI_POOL_DATA_PROVIDER, UI_POOL_DATA_PROVIDER_ABI,
  POOL_ADDRESSES_PROVIDER, MULTICALL3, MULTICALL3_ABI,
  AAVE_ORACLE, ORACLE_ABI,
} from "./config";
import { PositionTracker } from "./positions";
import { AaveOracle } from "./oracle";
import { Evaluator } from "./evaluator";

const G = "\x1b[32m", R = "\x1b[31m", Y = "\x1b[33m", C = "\x1b[36m";
const B = "\x1b[1m", DIM = "\x1b[2m", RST = "\x1b[0m";

async function main() {
  const provider = new ethers.JsonRpcProvider(CONFIG.rpcUrl, { chainId: 42161, name: "arbitrum" });
  const block = await provider.getBlockNumber();
  console.log(`\n${B}Connected${RST} | block=${block}\n`);

  const getProvider = () => provider;
  const oracle    = new AaveOracle(getProvider);
  const evaluator = new Evaluator(oracle, getProvider);
  const tracker   = new PositionTracker(getProvider);

  await tracker.seed();
  tracker.setCurrentBlock(BigInt(block));

  const candidates = await tracker.refreshBatch(CONFIG.positionsPerCycle);
  console.log(`${B}refreshBatch found: ${candidates.length} liquidatable${RST}\n`);

  if (candidates.length === 0) {
    console.log(`${Y}No candidates found at all - check HF thresholds in positions.ts${RST}`);
    process.exit(0);
  }

  const feeData  = await provider.getFeeData();
  const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice ?? 100_000_000n;
  const gweiNow  = Number(gasPrice) / 1e9;
  const allPrices   = await oracle.prefetchAllPrices();
  const ethPriceUsd = await evaluator.getEthPrice();

  console.log(`Gas: ${gweiNow.toFixed(4)} gwei | ETH: $${ethPriceUsd.toFixed(2)}\n`);
  console.log("─".repeat(80));

  const HF_ONE           = 10n ** 18n;
  const HF_EVAL_THRESHOLD = 990n * 10n ** 15n;
  const MIN_DEBT_USD      = 10;

  let countHFAbove1   = 0;
  let countTooSmall   = 0;
  let countBorderline = 0;
  let countNoBreakdown= 0;
  let countNotProfitable = 0;
  let countProfitable = 0;

  for (const pos of candidates.slice(0, 20)) {
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
      // Show why — manually compute bonus
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
  console.log(`${B}Summary (first ${Math.min(candidates.length,20)} candidates):${RST}`);
  console.log(`  HF≥1.0:       ${countHFAbove1}`);
  console.log(`  Too small:    ${countTooSmall}`);
  console.log(`  Borderline:   ${countBorderline}  ← HF between 0.990 and 1.0`);
  console.log(`  No breakdown: ${countNoBreakdown}  ← UiPoolDataProvider returned no assets`);
  console.log(`  Unprofitable: ${countNotProfitable}`);
  console.log(`  ${G}PROFITABLE:   ${countProfitable}${RST}`);
  console.log();
}

main().catch(e => { console.error(R + "Fatal: " + e.message + RST); process.exit(1); });
