// Validate the in-memory position model against Aave's own numbers.
//
//   npx tsx src/checkModel.ts <rpcUrl> <borrower> [borrower...]
//
// For each borrower it computes the health factor from the model — scaled
// balances × reserve indices, e-mode aware — and compares it to
// Pool.getUserAccountData(). They should agree to well under a basis point.
//
// The model is what the trigger engine fires on, so a drift here is a wrong
// liquidation decision. Run this after any Aave upgrade.
import { ethers } from "ethers";
import { AAVE_POOL, AAVE_POOL_ABI, UI_POOL_DATA_PROVIDER, UI_POOL_DATA_PROVIDER_ABI,
         POOL_ADDRESSES_PROVIDER, AAVE_ORACLE, ORACLE_ABI } from "./config";
import { ReserveRegistry, RAY } from "./reserveState";

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

  const addrs = registry.addresses();
  const rawPrices: bigint[] = await oracle.getAssetsPrices(addrs);
  const prices = new Map<string, bigint>();
  for (let i = 0; i < addrs.length; i++) prices.set(addrs[i]!, rawPrices[i]!);

  let worstDriftBps = 0;

  for (const borrower of borrowers) {
    const [userReserves, emodeIdRaw] = await ui.getUserReservesData(POOL_ADDRESSES_PROVIDER, borrower);
    const emodeId = Number(emodeIdRaw);
    await registry.ensureEModes([emodeId]);

    const nowSec = Math.floor(Date.now() / 1000);
    let num = 0n, den = 0n;
    const lines: string[] = [];

    for (const ur of userReserves) {
      const asset = (ur.underlyingAsset as string).toLowerCase();
      const rs = registry.get(asset);
      if (!rs) continue;
      const price = prices.get(asset) ?? 0n;
      const unit  = BigInt(10 ** rs.decimals);

      if (ur.usageAsCollateralEnabledOnUser && (ur.scaledATokenBalance as bigint) > 0n) {
        const bal  = ((ur.scaledATokenBalance as bigint) * registry.normalizedIncome(rs, nowSec)) / RAY;
        const usd8 = (price * bal) / unit;
        const lt   = BigInt(registry.effectiveLiquidationThreshold(rs, emodeId));
        num += usd8 * lt;
        lines.push(`    col  ${rs.symbol.padEnd(7)} $${(Number(usd8) / 1e8).toFixed(2).padStart(12)}  LT=${lt}`);
      }
      if ((ur.scaledVariableDebt as bigint) > 0n) {
        const bal  = ((ur.scaledVariableDebt as bigint) * registry.normalizedVariableDebt(rs, nowSec)) / RAY;
        const usd8 = (price * bal) / unit;
        den += usd8;
        lines.push(`    debt ${rs.symbol.padEnd(7)} $${(Number(usd8) / 1e8).toFixed(2).padStart(12)}`);
      }
    }

    const acct = await pool.getUserAccountData(borrower);
    const chainHf = acct.healthFactor as bigint;

    console.log(`\n${borrower}  (e-mode ${emodeId})`);
    for (const l of lines) console.log(l);

    if (den === 0n) { console.log(`    model: no debt — nothing to compare`); continue; }
    const modelHf = (num * 10n ** 18n) / (den * 10_000n);

    const chainNum = Number(chainHf) / 1e18;
    const modelNum = Number(modelHf) / 1e18;
    const driftBps = chainNum > 0 ? Math.abs(modelNum - chainNum) / chainNum * 10_000 : 0;
    worstDriftBps = Math.max(worstDriftBps, driftBps);

    const verdict = driftBps < 5 ? "OK" : driftBps < 50 ? "CLOSE" : "MISMATCH";
    console.log(
      `    model HF = ${modelNum.toFixed(6)}   chain HF = ${chainNum.toFixed(6)}   ` +
      `drift = ${driftBps.toFixed(3)} bps   ${verdict}`
    );
    console.log(
      `    chain collateral=$${(Number(acct.totalCollateralBase) / 1e8).toFixed(2)} ` +
      `debt=$${(Number(acct.totalDebtBase) / 1e8).toFixed(2)} ` +
      `LT=${Number(acct.currentLiquidationThreshold)}`
    );
  }

  console.log(`\nworst drift: ${worstDriftBps.toFixed(3)} bps`);
  console.log(worstDriftBps < 50
    ? "Model agrees with Aave."
    : "MODEL DIVERGES — investigate before trusting the trigger engine.");
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
