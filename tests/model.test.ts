// Run with: npm test   (node:test via tsx). No network access needed.
import { test } from "node:test";
import assert from "node:assert/strict";

// config.ts reads required env vars at import time.
process.env.RPC_URL ??= "http://localhost:8545";
process.env.RPC_WS ??= "ws://localhost:8546";
process.env.PRIVATE_KEY ??= "0x" + "11".repeat(32);
process.env.CONTRACT_ADDRESS ??= "0x" + "22".repeat(20);
process.env.LOG_CTRL_PORT ??= "0";

const WETH = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";
const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";

test("rayMul / wadDiv round half-up like Aave", async () => {
  const { rayMul, wadDiv, RAY: _ } = await import("../src/reserveState");
  assert.equal(rayMul(3n, 5n * 10n ** 26n), 2n);          // 1.5 -> 2
  assert.equal(rayMul(1n, 4n * 10n ** 26n), 0n);          // 0.4 -> 0
  assert.equal(wadDiv(1n, 2n), 5n * 10n ** 17n);
});

test("healthFactorExact truncates the average threshold to whole bps", async () => {
  const { healthFactorExact } = await import("../src/reserveState");
  // $100 collateral at LT 8000 vs $80 debt -> HF exactly 1.0
  assert.equal(healthFactorExact(100n * 10n ** 8n, 100n * 10n ** 8n * 8000n, 80n * 10n ** 8n), 10n ** 18n);
  // no debt -> max uint256
  assert.equal(healthFactorExact(1n, 1n, 0n), 2n ** 256n - 1n);
});

test("compounded debt index grows faster than linear income index", async () => {
  const { ReserveRegistry, RAY } = await import("../src/reserveState");
  const reg = new ReserveRegistry(() => { throw new Error("no rpc in tests"); });
  const state: any = {
    liquidityIndex: RAY, variableBorrowIndex: RAY,
    liquidityRate: RAY / 10n, variableBorrowRate: RAY / 10n, lastUpdateTimestamp: 1_000,
  };
  const dt = 365 * 24 * 3600;
  const income = reg.normalizedIncome(state, 1_000 + dt);
  const debt = reg.normalizedVariableDebt(state, 1_000 + dt);
  assert.ok(debt > income, "compounding must exceed linear accrual");
  assert.equal(reg.normalizedIncome(state, 1_000), RAY);
});

function fixture(hf: bigint) {
  const position: any = {
    address: "0xabc", healthFactor: hf, healthFactorNum: Number(hf) / 1e18,
    totalCollateralBase: 0n, totalDebtBase: 0n,
  };
  const collaterals = [{ symbol: "WETH", address: WETH, decimals: 18, balance: 10n * 10n ** 18n, balanceUsd: 0 }];
  const debts = [{ symbol: "USDC", address: USDC, decimals: 6, balance: 20_000n * 10n ** 6n, balanceUsd: 0 }];
  const prices = new Map<string, bigint>([
    [WETH.toLowerCase(), 3000n * 10n ** 8n],
    [USDC.toLowerCase(), 1n * 10n ** 8n],
  ]);
  const registry: any = { get: () => undefined, effectiveLiquidationBonus: () => 10500 };
  return { position, collaterals, debts, prices, registry };
}

test("pickBestPair applies the 50% close factor when HF > 0.95", async () => {
  const { pickBestPair } = await import("../src/evaluator");
  const f = fixture(97n * 10n ** 16n);
  const best = pickBestPair({ ...f, effectiveGasPrice: 10_000_000n, ethPrice: 3000, l1BaseFeeWei: 500_000_000n, emodeId: 0 });
  assert.ok(best);
  // 50% of $20k = $10k, shaved by 1 bp
  assert.equal(best!.debtToCover, 9_999n * 10n ** 6n);
});

test("pickBestPair allows a full close (+buffer) when HF <= 0.95", async () => {
  const { pickBestPair } = await import("../src/evaluator");
  const f = fixture(90n * 10n ** 16n);
  const best = pickBestPair({ ...f, effectiveGasPrice: 10_000_000n, ethPrice: 3000, l1BaseFeeWei: 500_000_000n, emodeId: 0 });
  assert.ok(best);
  assert.equal(best!.debtToCover, (20_000n * 10n ** 6n * 10_005n) / 10_000n);
});

test("pickBestPair sizes down to the collateral reserve's idle liquidity", async () => {
  const { pickBestPair } = await import("../src/evaluator");
  const f = fixture(90n * 10n ** 16n);
  // Only 1 WETH idle in the pool: seizure must be capped near 0.9 WETH (~$2.7k)
  f.registry.get = () => ({ availableLiquidity: 10n ** 18n, liquidationProtocolFee: 1000 });
  const best = pickBestPair({ ...f, effectiveGasPrice: 10_000_000n, ethPrice: 3000, l1BaseFeeWei: 500_000_000n, emodeId: 0 });
  assert.ok(best);
  assert.ok(best!.debtToCover < 3_000n * 10n ** 6n, `got ${best!.debtToCover}`);
});

test("evaluate does not judge bad debt when a collateral price is unknown", async () => {
  const { Evaluator } = await import("../src/evaluator");
  const f = fixture(90n * 10n ** 16n);
  const ev = new Evaluator({ getPrices: async () => f.prices } as any, () => { throw new Error("no rpc"); }, f.registry);
  f.prices.set(WETH.toLowerCase(), 0n);
  const r = await ev.evaluate(f.position, f.collaterals, f.debts, 10_000_000n, f.prices, 3000);
  assert.notEqual(r, "EVICT");
});

// ── Candidate index: must select exactly what a full recomputation would ─────
test("indexed candidate selection equals brute force", async () => {
  const { PositionTracker } = await import("../src/positions");
  const { ReserveRegistry, RAY } = await import("../src/reserveState");

  const nowSec = Math.floor(Date.now() / 1000);
  const mk = (address: string, id: number, decimals: number, lt: number): any => ({
    address: address.toLowerCase(), symbol: "T" + id, id, decimals,
    liquidationThreshold: lt, liquidationBonus: 10500, liquidationProtocolFee: 1000,
    active: true, frozen: false, liquidityIndex: RAY, variableBorrowIndex: RAY,
    liquidityRate: 0n, variableBorrowRate: 0n, lastUpdateTimestamp: nowSec + 3600, aTokenAddress: "0x0",
  });
  const reg = new ReserveRegistry(() => { throw new Error("no rpc"); });
  (reg as any).byAddress.set(WETH.toLowerCase(), mk(WETH, 4, 18, 8000));
  (reg as any).byAddress.set(USDC.toLowerCase(), mk(USDC, 12, 6, 8000));

  const tracker: any = new PositionTracker(() => { throw new Error("no rpc"); }, reg);
  let seed = 12345;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;

  const users: string[] = [];
  for (let i = 0; i < 400; i++) {
    const addr = "0x" + (i + 1).toString(16).padStart(40, "0");
    users.push(addr);
    const collEth = 1 + rnd() * 20;                 // WETH
    const price0 = 3000;
    const debtUsd = collEth * price0 * 0.8 * (0.80 + rnd() * 0.22);   // HF ~ 0.98 .. 1.25
    tracker.setUserState(addr, {
      emodeId: 0, fetchedAt: Date.now(),
      reserves: [
        { asset: WETH.toLowerCase(), scaledATokenBalance: BigInt(Math.floor(collEth * 1e18)), usageAsCollateral: true, scaledVariableDebt: 0n },
        { asset: USDC.toLowerCase(), scaledATokenBalance: 0n, usageAsCollateral: false, scaledVariableDebt: BigInt(Math.floor(debtUsd * 1e6)) },
      ],
    });
    tracker.positions.set(addr, { address: addr, healthFactor: 10n ** 18n, healthFactorNum: 1, totalCollateralBase: 0n, totalDebtBase: 0n });
  }

  const P = (eth: number) => new Map<string, bigint>([
    [WETH.toLowerCase(), BigInt(Math.round(eth * 1e8))],
    [USDC.toLowerCase(), 1n * 10n ** 8n],
  ]);
  const ceiling = 10n ** 18n + 15n * 10n ** 14n;
  const moved = new Set([WETH.toLowerCase()]);

  // Warm the caches at the starting price, then build the index.
  tracker.findLocalCandidates(moved, P(3000), ceiling, 1e9);
  tracker.rebuildHfIndexForTest();

  for (const eth of [2995, 3010, 2950, 3060, 2900, 3000, 2850]) {
    const prices = P(eth);
    const ext = (a: string) => {
      const lo = a === USDC.toLowerCase() ? 10n ** 8n : BigInt(Math.round(2850 * 1e8));
      const hi = a === USDC.toLowerCase() ? 10n ** 8n : BigInt(Math.round(3060 * 1e8));
      return { lo, hi };
    };
    const truth = new Set(users.filter(u => {
      const hf = tracker.localHealthFactor(u, prices);
      return hf !== null && hf < ceiling;
    }));
    const fast = new Set<string>(
      tracker.findLocalCandidates(moved, prices, ceiling, 1e9, false, ext).map((c: any) => c.pos.address),
    );
    assert.deepEqual([...fast].sort(), [...truth].sort(), `mismatch at ETH=${eth}`);
  }
  // The index must actually have been used, not silently fallen back.
  assert.ok(tracker.boundStats().skipped > 0, "index never skipped anything");
});
