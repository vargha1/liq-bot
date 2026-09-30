// svrPlumbingCheck.ts — verifies the SVR detection plumbing against stubbed model
// pieces: an announced price reaches the model, evaluation is hypothetical, the
// shared price cache is never touched, and the probe reports correctly.
//
//   npm run svr-plumbing
//
// Needs no network and no real keys; dummy config is set below before anything
// imports the bot's config module.

process.env.RPC_URL ??= "http://localhost";
process.env.RPC_WS ??= "ws://localhost";
process.env.PRIVATE_KEY ??= "0x" + "11".repeat(32);
process.env.CONTRACT_ADDRESS ??= "0x" + "11".repeat(20);
process.env.LOG_LEVEL ??= "error";

const WETH = "0x82af49447d8a07e3bd95bd0d56f35241523fbab1";
const USDC = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";
const FEED = "0xa5e1a36938769cbd5a26f5e19d8fcb379f597c83";
const UNANCHORED_FEED = "0xdeadbeef00000000000000000000000000000001";
const PRICE = 270_000_000_000n;   // $2,700

let fails = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
  if (!ok) fails++;
}

async function main(): Promise<void> {
  const { TriggerEngine } = await import("./trigger");

  let pokes = 0;
  const seen: Array<{ wethPrice: bigint; hypothetical: boolean }> = [];
  const cache = new Map<string, bigint>([[WETH, PRICE], [USDC, 100_000_000n]]);

  const oracle: any = {
    snapshotAllPrices: () => new Map(cache),
    pokePrice: () => { pokes++; return true; },
    peekPrice: (a: string) => cache.get(a) ?? null,
  };
  // A borrower who crosses only once WETH is below $2,650 (-1.85%).
  const tracker: any = {
    findLocalCandidates: (_a: Set<string>, prices: Map<string, bigint>, _c: bigint, _m: number, hypothetical: boolean) => {
      const w = prices.get(WETH)!;
      seen.push({ wethPrice: w, hypothetical });
      if (w >= 265_000_000_000n) return [];
      const hf = 0.97;
      return [{
        pos: { address: "0xb0", healthFactor: BigInt(Math.round(hf * 1e18)), healthFactorNum: hf, totalCollateralBase: 0n, totalDebtBase: 0n },
        collaterals: [], debts: [], hfLocal: hf, debtUsd8: 0n,
      }];
    },
  };
  const evaluator: any = {
    ethPriceCached: () => 2700,
    buildFromLocal: () => ({ borrower: "0xb0", netProfitUsd: 42, expectedBonusUsd: 45, collateralSymbol: "WETH", debtSymbol: "USDC" }),
  };

  const t: any = new TriggerEngine(
    tracker, oracle, evaluator, {} as any, () => 1n, () => true, () => null as any, () => null as any,
  );
  t.feeds = new Map([[FEED, new Set([WETH])], [UNANCHORED_FEED, new Set([USDC])]]);
  t.lastAnswers.set(FEED, PRICE);
  t.basis.set(WETH, { price: PRICE, answer: PRICE, at: Date.now() });

  const flat = t.svrPreview(FEED, PRICE, 40_000_000n);
  check("unchanged price: model sees it, nobody crosses", typeof flat !== "string" && flat.candidates.length === 0);

  const down = t.svrPreview(FEED, 260_000_000_000n, 40_000_000n);
  check("announced lower price reaches the model", seen[seen.length - 1]!.wethPrice === 260_000_000_000n);
  check("evaluation is hypothetical", seen.every(s => s.hypothetical));
  check("a crossing borrower is returned as 'sure'", typeof down !== "string" && down.candidates.length === 1 && down.candidates[0]!.sure);
  check("shared price cache untouched", pokes === 0 && cache.get(WETH) === PRICE);

  check("unknown feed reported as untracked", t.svrPreview("0x1234", 1n, 1n) === "untracked");
  check("tracked feed without an anchor reported as unanchored", t.svrPreview(UNANCHORED_FEED, 100_000_000n, 1n) === "unanchored");

  const rows = await t.svrProbe([50, 200, 500]);
  const eth = rows.find((r: any) => r.feed === FEED)!;
  check("probe: -0.5% crosses nobody, -2% and -5% do",
    eth.shocks[0].sure === 0 && eth.shocks[1].sure === 1 && eth.shocks[2].sure === 1,
    JSON.stringify(eth.shocks.map((s: any) => s.sure)));
  check("probe flags the unanchored feed", rows.find((r: any) => r.feed === UNANCHORED_FEED)!.status === "unanchored");
  check("probe never touched the cache either", pokes === 0);

  console.log(fails === 0 ? "\nAll checks passed." : `\n${fails} check(s) FAILED.`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch(e => { console.error(e?.message ?? e); process.exit(1); });
