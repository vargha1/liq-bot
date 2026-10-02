// Run with: npm test   (node:test via tsx). No network access needed.
//
// The chain is chosen at import time from CHAIN, and node:test runs each file in its
// own process, so this file pins Base and checks the pieces that differ from Arbitrum.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";

process.env.CHAIN = "base";
process.env.RPC_URL ??= "http://localhost:8545";
process.env.RPC_WS ??= "ws://localhost:8546";
process.env.PRIVATE_KEY ??= "0x" + "11".repeat(32);
process.env.CONTRACT_ADDRESS ??= "0x" + "22".repeat(20);
process.env.LOG_CTRL_PORT ??= "0";

const WETH  = "0x4200000000000000000000000000000000000006";
const USDC  = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const CBETH = "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22";

test("every profile is internally consistent", async () => {
  const { ALL_PROFILES } = await import("../src/chains");
  for (const p of Object.values(ALL_PROFILES)) {
    const addrs = [
      p.aave.pool, p.aave.dataProvider, p.aave.oracle, p.aave.addressesProvider, p.aave.uiPoolDataProvider,
      p.uniswap.router, p.uniswap.quoter, p.multicall3, p.routing.weth, p.routing.usdc,
      ...Object.values(p.reserves).map(r => r.address),
      ...p.routing.hubs.map(h => h.token), ...p.routing.twoHub.flat(),
    ];
    for (const a of addrs) assert.equal(ethers.getAddress(a), a, `${p.key}: ${a} is not a checksummed address`);

    const lower = Object.values(p.reserves).map(r => r.address.toLowerCase());
    assert.equal(new Set(lower).size, lower.length, `${p.key}: duplicate reserve address`);
    assert.ok(p.reserves.WETH && p.reserves.USDC, `${p.key}: WETH and USDC must be bootstrap reserves`);
    assert.equal(p.reserves.WETH!.address, p.routing.weth);
    // Warm-up lists name reserves by symbol: a typo silently skips that pair.
    for (const s of [...p.routing.warmCollaterals, ...p.routing.warmDebts]) assert.ok(p.reserves[s], `${p.key}: warm list names unknown reserve ${s}`);
    for (const s of p.routing.stables) assert.equal(s, s.toLowerCase());
    assert.ok(p.blockTimeMs > 0 && p.scanChunk > 0n && p.aave.deployBlock > 0n);
  }
});

test("selectChain defaults to arbitrum and rejects unknown names", async () => {
  const { selectChain } = await import("../src/chains");
  assert.equal(selectChain(undefined).key, "arbitrum");
  assert.equal(selectChain(" Base ").key, "base");
  assert.throws(() => selectChain("solana"), /Unknown CHAIN/);
});

test("config follows the selected chain", async () => {
  const c = await import("../src/config");
  assert.equal(c.PROFILE.key, "base");
  assert.equal(c.CHAIN_ID, 8453);
  assert.equal(c.AAVE_POOL, "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5");
  assert.equal(c.RESERVES.WETH!.address, WETH);
  assert.equal(c.RESERVE_BY_ADDRESS[USDC.toLowerCase()]!.symbol, "USDC");
  assert.equal(c.SEQUENCER_RPC, "https://mainnet-sequencer.base.org");
  // Arbitrum-only reserves must not leak in.
  assert.equal(c.RESERVES.ARB, undefined);
});

test("heuristic route goes through WETH for an LST and is direct for USDC pairs", async () => {
  const { encodeHeuristicPath, hopsFromPath } = await import("../src/uniswap");
  const lst = encodeHeuristicPath(CBETH, USDC);
  assert.equal(hopsFromPath(lst), 2);
  assert.ok(lst.toLowerCase().includes(WETH.slice(2).toLowerCase()));
  // GHO and USDC are both stables: the old code routed GHO->USDC->USDC.
  const gho = "0x6Bb7a212910682DCFdbd5BCBb3e28FB4E8da10Ee";
  const stable = encodeHeuristicPath(gho, USDC);
  assert.equal(hopsFromPath(stable), 1);
});

test("an implausible gas price is capped at the chain limit", async () => {
  const { sanitizeGasPrice } = await import("../src/evaluator");
  assert.equal(sanitizeGasPrice(5_000_000n), 5_000_000n);
  assert.equal(sanitizeGasPrice(50_000_000_000n), 2_000_000_000n);
});

test("OP-stack L1 fee is derived from the oracle's per-byte slope", async () => {
  const { Evaluator } = await import("../src/evaluator");
  // GasPriceOracle.getL1FeeUpperBound stub: fee = 8,000,000 wei per byte + a fixed 1,000,000.
  const iface = new ethers.Interface(["function getL1FeeUpperBound(uint256) view returns (uint256)"]);
  const runner: any = {
    call: async (tx: { data: string }) => {
      const [size] = iface.decodeFunctionData("getL1FeeUpperBound", tx.data);
      return iface.encodeFunctionResult("getL1FeeUpperBound", [8_000_000n * (size as bigint) + 1_000_000n]);
    },
  };
  const ev = new Evaluator({} as any, () => runner, {} as any);
  const before = (ev as any)._l1BaseFeeWei as bigint;
  await ev.refreshL1BaseFee();
  const after = (ev as any)._l1BaseFeeWei as bigint;
  assert.notEqual(after, before);
  // The equivalent base fee must make bytes x 16 x fee x 1.15 equal bytes x slope.
  assert.equal(after, (8_000_000n * 10_000n) / (16n * 11_500n));
  const reproduced = (1000n * 16n * after * 11_500n) / 10_000n;
  assert.ok(reproduced >= 7_990_000_000n && reproduced <= 8_000_000_000n, `got ${reproduced}`);
});

test("pickBestPair finds a profitable WETH->USDC liquidation on Base", async () => {
  const { pickBestPair } = await import("../src/evaluator");
  const position: any = { address: "0xabc", healthFactor: 90n * 10n ** 16n, healthFactorNum: 0.9, totalCollateralBase: 0n, totalDebtBase: 0n };
  const collaterals = [{ symbol: "WETH", address: WETH, decimals: 18, balance: 10n * 10n ** 18n, balanceUsd: 0 }];
  const debts = [{ symbol: "USDC", address: USDC, decimals: 6, balance: 20_000n * 10n ** 6n, balanceUsd: 0 }];
  const prices = new Map<string, bigint>([[WETH.toLowerCase(), 3000n * 10n ** 8n], [USDC.toLowerCase(), 10n ** 8n]]);
  const registry: any = { get: () => undefined, effectiveLiquidationBonus: () => 10500 };
  const best = pickBestPair({ position, collaterals, debts, prices, registry, effectiveGasPrice: 6_000_000n, ethPrice: 3000, l1BaseFeeWei: 434_782n, emodeId: 0 });
  assert.ok(best);
  assert.equal(best!.debtToCover, (20_000n * 10n ** 6n * 10_005n) / 10_000n);   // HF <= 0.95: full close + buffer
  assert.ok(best!.netProfitUsd > 100, `net ${best!.netProfitUsd}`);
});
