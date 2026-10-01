// sizingCheck.ts — verifies liquidation sizing against Aave V3.3+ rules
// (close-factor cap, $1000 leftover / MustNotLeaveDust, full-close buffer).
//
//   npm run sizing-check
//
// Needs no network; dummy config is set before the bot's config module loads.

process.env.RPC_URL ??= "http://localhost";
process.env.RPC_WS ??= "ws://localhost";
process.env.PRIVATE_KEY ??= "0x" + "11".repeat(32);
process.env.CONTRACT_ADDRESS ??= "0x" + "11".repeat(20);
process.env.LOG_LEVEL ??= "error";

export {};

const WETH = "0x82af49447d8a07e3bd95bd0d56f35241523fbab1";
const USDC = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";

let fails = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
  if (!ok) fails++;
}

async function main(): Promise<void> {
  const { Evaluator } = await import("./evaluator");
  const ev: any = new Evaluator({ toUsdNumber: (v: bigint) => Number(v) / 1e8 } as any, () => ({}) as any, { get: () => undefined } as any);

  const prices = new Map<string, bigint>([[WETH, 270_000_000_000n], [USDC, 100_000_000n]]);
  const usdc = (n: number) => BigInt(Math.round(n * 1e6));
  const weth = (n: number) => BigInt(Math.round(n * 1e18));

  function run(hf: number, collUsd: number, debtUsdc: number) {
    const position: any = {
      address: "0xb0", healthFactor: BigInt(Math.round(hf * 1e18)), healthFactorNum: hf,
      totalCollateralBase: 0n, totalDebtBase: 0n,
    };
    const collaterals: any[] = [{ symbol: "WETH", address: WETH, decimals: 18, balance: weth(collUsd / 2700), balanceUsd: 0 }];
    const debts: any[] = [{ symbol: "USDC", address: USDC, decimals: 6, balance: usdc(debtUsdc), balanceUsd: 0 }];
    return ev.buildFromLocal(position, collaterals, debts, prices, 40_000_000n, 2700, true) as { debtToCover: bigint } | null;
  }

  // 1. The production failure: small position, old code asked for 50% and Aave
  //    reverted with MustNotLeaveDust. The whole collateral is worth less than the
  //    debt plus bonus, so the right move is to sweep the collateral.
  const small = run(0.9992, 70, 68);
  check("small position: sweeps collateral instead of repaying half",
    !!small && small.debtToCover > usdc(60), small ? `asked ${Number(small.debtToCover) / 1e6} USDC` : "no opportunity");

  // 2. Large position: 50% of total debt cap applies, shaved slightly.
  const big = run(0.99, 20_000, 10_000);
  check("large position: capped at 50% of total debt, just under",
    !!big && big.debtToCover < usdc(5000) && big.debtToCover > usdc(4990),
    big ? `asked ${Number(big.debtToCover) / 1e6} USDC` : "no opportunity");

  // 3. Cap would leave exactly $1000 of debt, below the 0.5% margin: size down so
  //    the leftover stays safely above the line.
  const edge = run(0.99, 20_000, 2000);
  check("cap lands on the leftover line: sized to leave > $1000 of debt",
    !!edge && edge.debtToCover < usdc(996) && edge.debtToCover > usdc(990),
    edge ? `asked ${Number(edge.debtToCover) / 1e6} USDC` : "no opportunity");

  // 4. Under $2000 of debt the 50% cap does not apply: full close, with buffer.
  const full = run(0.99, 20_000, 1500);
  check("debt under $2000: asks for the full debt plus buffer",
    !!full && full.debtToCover >= usdc(1500) && full.debtToCover <= usdc(1501),
    full ? `asked ${Number(full.debtToCover) / 1e6} USDC` : "no opportunity");

  // 5. HF <= 0.95: whole debt liquidatable even on a big position.
  const deep = run(0.9, 40_000, 10_000);
  check("HF below 0.95: asks for the full debt plus buffer",
    !!deep && deep.debtToCover >= usdc(10_000) && deep.debtToCover <= usdc(10_006),
    deep ? `asked ${Number(deep.debtToCover) / 1e6} USDC` : "no opportunity");

  console.log(fails === 0 ? "\nAll checks passed." : `\n${fails} check(s) FAILED.`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
