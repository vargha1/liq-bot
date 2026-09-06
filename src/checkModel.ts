// Validate the in-memory position model against Aave's own numbers.
//
//   npx tsx src/checkModel.ts <rpcUrl> <borrower> [borrower...]
//
// For each borrower it computes the health factor through the SAME code path the
// trigger engine fires on — PositionTracker.evaluateUserState, reached via
// evaluateStateForDiagnostics — and compares it to Pool.getUserAccountData().
//
// This previously re-implemented the health-factor formula inline. That made it
// a second opinion rather than a test: the copy could agree with Aave perfectly
// while the code that actually commits gas disagreed, and any fix applied to one
// silently left the other behind. Both now share one implementation, so a clean
// run here is evidence about the real fire path.
//
// Prices are read authoritatively from the oracle, so this isolates ARITHMETIC
// drift. It deliberately says nothing about the hot path's price snapshot, which
// mixes ratio estimates with TTL-stale entries — that error is measured live and
// continuously by ModelErrorTracker instead. If this reports ~0 bps and the
// trigger still sees disagreement, the difference is prices, not maths.
import { ethers } from "ethers";
import { AAVE_POOL, AAVE_POOL_ABI, UI_POOL_DATA_PROVIDER, UI_POOL_DATA_PROVIDER_ABI,
         POOL_ADDRESSES_PROVIDER, AAVE_ORACLE, ORACLE_ABI } from "./config";
import { ReserveRegistry } from "./reserveState";
import { PositionTracker, type UserReserveSnapshot } from "./positions";

async function main() {
  const rpcUrl = process.argv[2];
  const borrowers = process.argv.slice(3);
  if (!rpcUrl || borrowers.length === 0) {
    console.error("usage: tsx src/checkModel.ts <rpcUrl> <borrower> [borrower...]");
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl, 42161, { staticNetwork: true });
  const registry = new ReserveRegistry(() => provider);
  await registry.refreshAll();

  const pool   = new ethers.Contract(AAVE_POOL, AAVE_POOL_ABI, provider);
  const ui     = new ethers.Contract(UI_POOL_DATA_PROVIDER, UI_POOL_DATA_PROVIDER_ABI, provider);
  const oracle = new ethers.Contract(AAVE_ORACLE, ORACLE_ABI, provider);

  // The production evaluator lives on PositionTracker; construct one purely to
  // reach it. No seeding, no event monitoring — nothing but the model maths.
  const tracker = new PositionTracker(() => provider, registry);

  const addrs = registry.addresses();
  const rawPrices: bigint[] = await oracle.getAssetsPrices(addrs);
  const prices = new Map<string, bigint>();
  for (let i = 0; i < addrs.length; i++) prices.set(addrs[i]!.toLowerCase(), rawPrices[i]!);

  let worstDriftBps = 0;

  for (const borrower of borrowers) {
    const [userReserves, emodeIdRaw] = await ui.getUserReservesData(POOL_ADDRESSES_PROVIDER, borrower);
    const emodeId = Number(emodeIdRaw);
    await registry.ensureEModes([emodeId]);

    // Build exactly the state refreshUserStates would have stored.
    const snapshots: UserReserveSnapshot[] = [];
    for (const ur of userReserves) {
      const scaledATokenBalance = ur.scaledATokenBalance as bigint;
      const scaledVariableDebt  = ur.scaledVariableDebt as bigint;
      if (scaledATokenBalance === 0n && scaledVariableDebt === 0n) continue;
      snapshots.push({
        asset:             (ur.underlyingAsset as string).toLowerCase(),
        scaledATokenBalance,
        usageAsCollateral: ur.usageAsCollateralEnabledOnUser as boolean,
        scaledVariableDebt,
      });
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const evaluated = tracker.evaluateStateForDiagnostics(
      { reserves: snapshots, emodeId, fetchedAt: Date.now() },
      prices,
      nowSec,
    );

    const acct = await pool.getUserAccountData(borrower);
    const chainHf = acct.healthFactor as bigint;

    console.log(`\n${borrower}  (e-mode ${emodeId})`);

    if (!evaluated) {
      console.log(`    model: not evaluable (missing price, unknown reserve, or no debt)`);
      continue;
    }

    for (const c of evaluated.collaterals) {
      const rs = registry.get(c.address);
      const price = prices.get(c.address.toLowerCase()) ?? 0n;
      const usd8 = (price * c.balance) / BigInt(10 ** c.decimals);
      const lt = rs ? registry.effectiveLiquidationThreshold(rs, emodeId) : 0;
      console.log(`    col  ${c.symbol.padEnd(7)} $${(Number(usd8) / 1e8).toFixed(2).padStart(12)}  LT=${lt}`);
    }
    for (const d of evaluated.debts) {
      const price = prices.get(d.address.toLowerCase()) ?? 0n;
      const usd8 = (price * d.balance) / BigInt(10 ** d.decimals);
      console.log(`    debt ${d.symbol.padEnd(7)} $${(Number(usd8) / 1e8).toFixed(2).padStart(12)}`);
    }

    const modelHf = evaluated.hfE18;
    const chainNum = Number(chainHf) / 1e18;
    const modelNum = Number(modelHf) / 1e18;
    const driftBps = chainNum > 0 ? Math.abs(modelNum - chainNum) / chainNum * 10_000 : 0;
    worstDriftBps = Math.max(worstDriftBps, driftBps);

    const verdict = driftBps < 0.1 ? "EXACT" : driftBps < 5 ? "OK" : driftBps < 50 ? "CLOSE" : "MISMATCH";
    console.log(
      `    model HF = ${modelNum.toFixed(8)}   chain HF = ${chainNum.toFixed(8)}   ` +
      `drift = ${driftBps.toFixed(4)} bps   ${verdict}`
    );
    // Totals are a sharper diagnostic than the health factor alone: a
    // collateral or debt mismatch points at balances or prices, while matching
    // totals with a drifting HF points at the threshold/rounding step.
    console.log(
      `    model collateral=$${(Number(evaluated.collateralUsd8) / 1e8).toFixed(2)} ` +
      `debt=$${(Number(evaluated.debtUsd8) / 1e8).toFixed(2)}`
    );
    console.log(
      `    chain collateral=$${(Number(acct.totalCollateralBase) / 1e8).toFixed(2)} ` +
      `debt=$${(Number(acct.totalDebtBase) / 1e8).toFixed(2)} ` +
      `LT=${Number(acct.currentLiquidationThreshold)}`
    );
  }

  console.log(`\nworst drift: ${worstDriftBps.toFixed(4)} bps`);
  // The arithmetic is now a faithful replica of GenericLogic, so anything above
  // rounding noise is a real defect rather than an accepted approximation.
  console.log(worstDriftBps < 0.1
    ? "Model is bit-exact with Aave (given identical prices)."
    : worstDriftBps < 50
      ? "Model agrees, but not exactly — investigate the residual."
      : "MODEL DIVERGES — investigate before trusting the trigger engine.");
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
