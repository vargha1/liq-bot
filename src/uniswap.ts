/**
 * uniswap.ts
 *
 * Finds the best Uniswap V3 route for a given token swap using QuoterV2
 * (on-chain static call, no API, ~30ms), then returns the encoded path bytes
 * and amountOutMinimum ready to pass directly to the liquidator contract's
 * liquidate(swapPath, amountOutMinimum) parameters.
 *
 * The contract calls SwapRouter02.exactInput() itself — we just supply the path.
 */
import { ethers } from "ethers";
import { logger } from "./logger";
import { RESERVES, MULTICALL3, MULTICALL3_ABI, UNISWAP_ROUTER, UNISWAP_QUOTER } from "./config";

// Single source of truth lives in config.ts; re-exported for existing importers.
export { UNISWAP_ROUTER, UNISWAP_QUOTER };

const QUOTER_ABI = [
  "function quoteExactInput(bytes memory path, uint256 amountIn) external returns (uint256 amountOut, uint160[] memory sqrtPriceX96AfterList, uint32[] memory initializedTicksCrossedList, uint256 gasEstimate)",
];

// FIX: Cache quoter contract per provider instance to avoid creating a new
// ethers.Contract (with full ABI parse) on every uniswapSwap() call.
// At 1-3 calls/cycle this was ~3-9 Contract allocations/sec needlessly.
let _cachedQuoterProvider: ethers.Provider | null = null;
let _cachedQuoter: ethers.Contract | null = null;

const QUOTER_IFACE = new ethers.Interface(QUOTER_ABI);
let _cachedMulticall: ethers.Contract | null = null;

// Both contracts are rebuilt together whenever the provider instance changes,
// from a single tracked provider so neither getter can invalidate the other's
// cache out from under it.
function refreshContractCache(provider: ethers.Provider): void {
  if (provider === _cachedQuoterProvider) return;
  _cachedQuoterProvider = provider;
  _cachedQuoter    = new ethers.Contract(UNISWAP_QUOTER, QUOTER_ABI, provider);
  _cachedMulticall = new ethers.Contract(MULTICALL3, MULTICALL3_ABI, provider);
}

function getQuoter(provider: ethers.Provider): ethers.Contract {
  refreshContractCache(provider);
  return _cachedQuoter!;
}

function getMulticall(provider: ethers.Provider): ethers.Contract {
  refreshContractCache(provider);
  return _cachedMulticall!;
}

// Fee tiers available on Uniswap V3. The 0.01% tier was missing and is often
// the deepest pool for stable pairs and for WETH/USDC on Arbitrum — a live
// quote of 1 WETH returned more USDC through the 100 tier than through 3000.
// Adding it costs nothing now that all candidate paths are quoted in one
// batched eth_call. It is used for QUOTING only; the pre-cache heuristic path
// still picks widely-present tiers, since a heuristic path that names a
// non-existent pool reverts on-chain.
const FEE_TIERS = [100, 500, 3000, 10000] as const;
type FeeTier = typeof FEE_TIERS[number];

// Intermediate routing tokens (deepest liquidity on Arbitrum)
const WETH  = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";
const USDC  = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const USDCe = "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8";

const STABLES = new Set([
  USDC.toLowerCase(), USDCe.toLowerCase(),
  "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9", // USDT
  "0xda10009cbd5d07dd0cecc66161fc93d7c9000da1", // DAI
  "0x93b346b6bc2548da6a1e7d98e9a421b42541425b", // LUSD
  "0x17fc002b466eec40dae837fc4be5c67993ddbd6f", // FRAX
  "0x7dff72693f6a4149b17e7c6314655f6a9f7c8b33", // GHO
  "0xd22a58f79e9481d1a88e00c343885a588b34b68b", // EURS
  "0x3f56e0c36d275367b8c502090edf38289b3dea0d", // MAI
]);

// Encode a Uniswap V3 multi-hop path.
// Format: tokenA (20 bytes) ++ fee (3 bytes) ++ tokenB (20 bytes) [++ fee ++ tokenC ...]
function encodePath(tokens: string[], fees: FeeTier[]): string {
  let hex = tokens[0]!.slice(2).toLowerCase();
  for (let i = 0; i < fees.length; i++) {
    hex += fees[i]!.toString(16).padStart(6, "0");
    hex += tokens[i + 1]!.slice(2).toLowerCase();
  }
  return "0x" + hex;
}

function symOf(addr: string): string {
  return Object.values(RESERVES).find(
    r => r.address.toLowerCase() === addr.toLowerCase()
  )?.symbol ?? addr.slice(0, 8);
}

const WBTC = "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f";

// Bridge tokens and the fee tiers worth trying on each leg that touches them.
// The old candidate list guessed ONE fee per leg (3000 for volatile, 500 for
// stables), which missed the deepest pool whenever it was a different tier: a live
// probe quoted wstETH→USDC at $2.6k of a $5k trade through [3000,500] while
// wstETH-[100]→WETH-[500]→USDC returns ~$5k, and tBTC→DAI lost half its value the
// same way. WETH→GHO had no candidate at all (the 3-hop builder started the path
// with WETH twice). Every tier pair per hub is cheap now that the whole list goes
// out as batched eth_calls; 10000 is only worth quoting on direct pools.
const HUBS: Array<{ token: string; fees: readonly FeeTier[] }> = [
  { token: WETH,  fees: [100, 500, 3000] },
  { token: USDC,  fees: [100, 500] },
  { token: USDCe, fees: [100, 500] },
  { token: WBTC,  fees: [100, 500] },
];

// Two-hub bridges for tokens whose only pools face a stable (GHO and friends:
// X→WETH→USDC→GHO). Fees on the legs that exist on Arbitrum in practice.
const TWO_HUB: Array<[string, string]> = [[WETH, USDC], [WETH, USDCe], [USDC, WETH]];

// Build candidate paths to try. Order does not matter — every path is quoted and
// the best output wins.
function candidatePaths(tokenIn: string, tokenOut: string): Array<{ tokens: string[]; fees: FeeTier[] }> {
  const inL  = tokenIn.toLowerCase();
  const outL = tokenOut.toLowerCase();
  const paths: Array<{ tokens: string[]; fees: FeeTier[] }> = [];
  const seen = new Set<string>();
  const add = (tokens: string[], fees: FeeTier[]) => {
    const lower = tokens.map(t => t.toLowerCase());
    if (new Set(lower).size !== lower.length) return;          // a token twice = not a path
    const key = lower.join(",") + "|" + fees.join(",");
    if (seen.has(key)) return;
    seen.add(key);
    paths.push({ tokens, fees });
  };

  // 1. Direct pools
  for (const fee of FEE_TIERS) add([tokenIn, tokenOut], [fee]);

  // 2. One bridge token, every tier pair
  for (const hub of HUBS) {
    const h = hub.token.toLowerCase();
    if (h === inL || h === outL) continue;
    for (const f1 of hub.fees) for (const f2 of hub.fees) add([tokenIn, hub.token, tokenOut], [f1, f2]);
  }

  // 3. Two bridge tokens — only when a stablecoin is on one side, the case this
  // exists for. Skipping it elsewhere halves the number of quotes per refresh.
  if (STABLES.has(inL) || STABLES.has(outL)) for (const [a, b] of TWO_HUB) {
    for (const f1 of [100, 500, 3000] as const) for (const f3 of [100, 500] as const) {
      add([tokenIn, a, b, tokenOut], [f1, 500, f3]);
    }
  }

  return paths;
}

// ─── Result ───────────────────────────────────────────────────────────────────
export interface UniswapQuoteResult {
  swapPath:         string;   // raw encoded path bytes — pass to contract's swapPath param
  outputAmount:     bigint;   // quoted output before slippage
  amountOutMinimum: bigint;   // outputAmount * (1 - slippageBps/10000) — pass to contract
  gasEstimate:      number;   // from QuoterV2 — used for gas limit calculation
  routeDesc:        string;   // human-readable route for logging
}

// ─── Main ─────────────────────────────────────────────────────────────────────
// All candidate paths are quoted in parallel (Promise.allSettled).
// Each quote has a tight timeout — Tenderly returns in <200ms when healthy.
// Short timeout prevents orphaned staticCalls from piling up in the provider
// queue when Tenderly is slow, which causes cascading delays across cycles.
const QUOTE_TIMEOUT_MS = 3_000;   // background-only (route refresh / warm-up), never the hot path
const QUOTE_CHUNK      = 8;      // quoter calls per batched eth_call

// ─── Background route cache ──────────────────────────────────────────────────
// HOT-PATH RULE: evaluate() must never wait on a QuoterV2 staticCall. Instead:
//   1. The best-known route for a (collateral→debt) pair is cached here.
//   2. On a cache miss, a deterministic heuristic path is used immediately.
//   3. A background refresh re-quotes all candidate paths and updates the cache,
//      throttled to once per ROUTE_REFRESH_MIN_INTERVAL_MS per pair.
// Slippage protection does not depend on the quote: amountOutMinimum is derived
// from Aave oracle prices in evaluator.ts, and the contract enforces it on-chain.
export interface CachedRoute {
  path:     string;
  desc:     string;
  out:      bigint;
  gas:      number;
  ts:       number;
  amountIn: bigint;   // the size this quote was taken at — required to judge impact
}

const routeCache          = new Map<string, CachedRoute>();   // "colLower->debtLower" → best route
const inflightRefreshes   = new Map<string, Promise<void>>();
const lastRefreshAttempt  = new Map<string, number>();
const ROUTE_REFRESH_MIN_INTERVAL_MS = 60_000;   // at most one background quote fan-out per pair per minute
const ROUTE_TTL_MS                  = 10 * 60_000; // routes older than this are refreshed on next touch

function pairKey(tokenIn: string, tokenOut: string): string {
  return `${tokenIn.toLowerCase()}->${tokenOut.toLowerCase()}`;
}

// Deterministic fallback route used when no quoted route is cached.
// Mirrors the liquidity layout on Arbitrum: stables cluster around USDC 0.05%,
// volatile assets route through WETH 0.3%.
function heuristicCandidate(tokenIn: string, tokenOut: string): { tokens: string[]; fees: FeeTier[] } {
  const inL  = tokenIn.toLowerCase();
  const outL = tokenOut.toLowerCase();
  const inIsStable  = STABLES.has(inL);
  const outIsStable = STABLES.has(outL);

  if (inL === WETH.toLowerCase() || outL === WETH.toLowerCase()) {
    const stableSide = inIsStable || outIsStable;
    return { tokens: [tokenIn, tokenOut], fees: [stableSide ? 500 : 3000] };
  }
  if (inIsStable && outIsStable) {
    if (inL === USDC.toLowerCase()) return { tokens: [tokenIn, tokenOut], fees: [500] };
    return { tokens: [tokenIn, USDC, tokenOut], fees: [500, 500] };
  }
  if (inIsStable && !outIsStable) return { tokens: [tokenIn, WETH, tokenOut], fees: [500, 3000] };
  if (!inIsStable && outIsStable) return { tokens: [tokenIn, WETH, tokenOut], fees: [3000, 500] };
  return { tokens: [tokenIn, WETH, tokenOut], fees: [3000, 3000] };
}

// Encoded heuristic path — usable as swapPath with zero RPC calls.
export function encodeHeuristicPath(tokenIn: string, tokenOut: string): string {
  const c = heuristicCandidate(tokenIn, tokenOut);
  return encodePath(c.tokens, c.fees);
}

export function getCachedRoute(tokenIn: string, tokenOut: string): CachedRoute | undefined {
  return routeCache.get(pairKey(tokenIn, tokenOut));
}

// Fire-and-forget background refresh of the best route for a pair.
// Never throws; deduplicates concurrent refreshes; throttles repeat attempts.
export function scheduleRouteRefresh(
  tokenIn:   string,
  tokenOut:  string,
  amountHint: bigint,
  provider:  ethers.Provider,
  force = false,
): void {
  const key = pairKey(tokenIn, tokenOut);
  const now = Date.now();

  const cached = routeCache.get(key);
  if (!force && cached && now - cached.ts < ROUTE_REFRESH_MIN_INTERVAL_MS) return;
  if (!force && !cached && now - (lastRefreshAttempt.get(key) ?? 0) < ROUTE_REFRESH_MIN_INTERVAL_MS) return;

  const inflight = inflightRefreshes.get(key);
  if (inflight) return;

  lastRefreshAttempt.set(key, now);
  const job = (async () => {
    const result = await uniswapSwap(tokenIn, amountHint, tokenOut, "", 0, provider);
    if (result) {
      routeCache.set(key, {
        path: result.swapPath,
        desc: result.routeDesc,
        out:  result.outputAmount,
        gas:  result.gasEstimate,
        ts:   Date.now(),
        amountIn: amountHint,
      });
      logger.debug(`routeCache: ${symOf(tokenIn)}→${symOf(tokenOut)} via ${result.routeDesc}`);
    }
  })()
    .catch(e => { logger.debug(`routeCache refresh failed for ${key}: ${e?.message ?? e}`); })
    .finally(() => inflightRefreshes.delete(key));
  inflightRefreshes.set(key, job);
}

// True if the cached route for this pair exists but is stale enough to warrant a
// background refresh (does not block — caller uses the stale route meanwhile).
export function routeNeedsRefresh(tokenIn: string, tokenOut: string): boolean {
  const cached = routeCache.get(pairKey(tokenIn, tokenOut));
  return !!cached && Date.now() - cached.ts > ROUTE_TTL_MS;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`quote timeout after ${ms}ms`)), ms)
    ),
  ]);
}

export async function uniswapSwap(
  tokenIn:     string,
  amountIn:    bigint,
  tokenOut:    string,
  _recipient:  string,
  slippageBps: number,
  provider:    ethers.Provider,
): Promise<UniswapQuoteResult | null> {
  const candidates = candidatePaths(tokenIn, tokenOut);

  const encoded = candidates.map(({ tokens, fees }) => ({
    path: encodePath(tokens, fees),
    desc: tokens.map((t, i) => (i < fees.length ? `${symOf(t)}-[${fees[i]}]` : symOf(t))).join("→"),
  }));

  let bestOut  = 0n;
  let bestPath = "";
  let bestGas  = 350_000;
  let bestDesc = "";

  const consider = (path: string, desc: string, out: bigint, gas: number) => {
    logger.debug(`  Uni ${desc}: out=${out} gas=${gas}`);
    if (out > bestOut) { bestOut = out; bestPath = path; bestGas = gas; bestDesc = desc; }
  };

  // Every candidate path in ONE eth_call via Multicall3 instead of up to ten
  // separate QuoterV2 staticCalls. Each of those went through the shared rate
  // limiter, so a single route refresh could consume seconds of budget — and
  // route refreshes fire per collateral/debt pair.
  //
  // quoteExactInput is non-view on QuoterV2, but tryAggregate is invoked here as
  // an eth_call, so the state it touches is discarded exactly as with staticCall.
  // requireSuccess=false absorbs the revert QuoterV2 throws for a missing pool.
  try {
    const mc = getMulticall(provider);
    // Quote in batches of QUOTE_CHUNK. A path through a thin pool can burn millions
    // of gas crossing ticks (7.7M seen for one LINK→USDC→GHO candidate), which
    // exceeds the node's eth_call gas cap and fails the WHOLE batch with "missing
    // revert data" — silently taking the good candidates down with it. So a failed
    // batch is bisected until the offender is isolated and dropped; the healthy
    // halves still return their quotes. Costs extra calls only when that happens.
    const quoteBatch = async (items: typeof encoded): Promise<Array<{ success: boolean; returnData: string } | undefined>> => {
      try {
        return await withTimeout(
          mc.tryAggregate.staticCall(
            false,
            items.map(e => ({
              target:   UNISWAP_QUOTER,
              callData: QUOTER_IFACE.encodeFunctionData("quoteExactInput", [e.path, amountIn]),
            })),
          ),
          QUOTE_TIMEOUT_MS,
        ) as Array<{ success: boolean; returnData: string }>;
      } catch (e: any) {
        if (items.length === 1) return [undefined];
        if (/timeout|RPC_BACKPRESSURE|destroyed/i.test(`${e?.message} ${e?.code}`)) throw e;   // bisecting would not help
        const mid = items.length >> 1;
        const [l, r] = await Promise.all([quoteBatch(items.slice(0, mid)), quoteBatch(items.slice(mid))]);
        return [...l, ...r];
      }
    };
    const results: Array<{ success: boolean; returnData: string } | undefined> = [];
    for (let i = 0; i < encoded.length; i += QUOTE_CHUNK) {
      results.push(...await quoteBatch(encoded.slice(i, i + QUOTE_CHUNK)));
    }
    for (let i = 0; i < encoded.length; i++) {
      const r = results[i];
      if (!r?.success || r.returnData === "0x") continue;
      try {
        const d = QUOTER_IFACE.decodeFunctionResult("quoteExactInput", r.returnData);
        consider(encoded[i]!.path, encoded[i]!.desc, d[0] as bigint, Number(d[3] as bigint));
      } catch { /* unquotable path */ }
    }
  } catch (e: any) {
    // Multicall unavailable or timed out — fall back to individual quotes.
    logger.debug(`uniswapSwap: batched quote failed (${e?.message ?? e}) — individual quotes`);
    const quoter = getQuoter(provider);
    const quoteResults = await Promise.allSettled(
      // Direct pools + the WETH bridge only: this runs when batching is broken, so
      // it must not fan out the full candidate list one request at a time.
      encoded.slice(0, 13).map(async ({ path, desc }) => {
        const [amountOut, , , gasEstimate] = await withTimeout(
          quoter.quoteExactInput.staticCall(path, amountIn),
          QUOTE_TIMEOUT_MS,
        );
        return { path, desc, out: amountOut as bigint, gas: Number(gasEstimate as bigint) };
      })
    );
    for (const result of quoteResults) {
      if (result.status !== "fulfilled") continue;
      const { path, desc, out, gas } = result.value;
      consider(path, desc, out, gas);
    }
  }

  if (bestOut === 0n) {
    logger.warn(`uniswapSwap: no route ${symOf(tokenIn)}→${symOf(tokenOut)}`);
    return null;
  }

  const amountOutMinimum = (bestOut * BigInt(10_000 - slippageBps)) / 10_000n;
  logger.debug(`  Uni best ${bestDesc}: in=${amountIn} out=${bestOut} min=${amountOutMinimum}`);

  return {
    swapPath:         bestPath,
    outputAmount:     bestOut,
    amountOutMinimum,
    gasEstimate:      bestGas,
    routeDesc:        bestDesc,
  };
}

// ─── Startup route warm-up ────────────────────────────────────────────────────
// Without a cached route the evaluator falls back to a heuristic path whose fee
// tiers are a guess — a pool that does not exist reverts on-chain — and it can
// only estimate the swap output from oracle prices. The FIRST liquidation of any
// pair therefore ran on the least reliable data available. Quoting the common
// pairs once at startup, paced so it never competes with the hot path, means
// that first fire already has a verified route and a real quote.
const WARM_COLLATERALS = ["WETH", "wstETH", "WBTC", "weETH", "ARB", "LINK", "rETH", "tBTC", "AAVE", "USDC", "USDT", "DAI", "USDC.e"];
const WARM_DEBTS       = ["USDC", "USDT", "DAI", "WETH", "USDC.e", "WBTC", "GHO"];

export async function warmRouteCache(
  provider: ethers.Provider,
  prices:   Map<string, bigint>,
  targetUsd = 5_000,
  paceMs    = 500,   // each pair is now up to two batched calls; stay inside the shared RPC budget
): Promise<number> {
  let warmed = 0;
  for (const cSym of WARM_COLLATERALS) {
    const c = RESERVES[cSym];
    if (!c) continue;
    const cPrice = prices.get(c.address.toLowerCase()) ?? 0n;
    if (cPrice <= 0n) continue;
    for (const dSym of WARM_DEBTS) {
      const d = RESERVES[dSym];
      if (!d || d.address.toLowerCase() === c.address.toLowerCase()) continue;
      const key = pairKey(c.address, d.address);
      if (routeCache.has(key) || inflightRefreshes.has(key)) continue;

      const amountIn = BigInt(Math.max(1, Math.round(targetUsd / (Number(cPrice) / 1e8) * 10 ** c.decimals)));
      try {
        const r = await uniswapSwap(c.address, amountIn, d.address, "", 0, provider);
        if (r) {
          routeCache.set(key, {
            path: r.swapPath, desc: r.routeDesc, out: r.outputAmount,
            gas: r.gasEstimate, ts: Date.now(), amountIn,
          });
          warmed++;
        }
      } catch { /* best effort — the on-demand path still works */ }
      await new Promise(res => setTimeout(res, paceMs));
    }
  }
  logger.info(`routeCache: warmed ${warmed} routes`);
  return warmed;
}
