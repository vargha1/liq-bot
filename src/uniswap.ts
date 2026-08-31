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
import { RESERVES, MULTICALL3, MULTICALL3_ABI } from "./config";

export const UNISWAP_ROUTER = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45"; // SwapRouter02
export const UNISWAP_QUOTER = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e"; // QuoterV2

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

// Build candidate paths to try, ordered by expected output quality.
function candidatePaths(tokenIn: string, tokenOut: string): Array<{ tokens: string[]; fees: FeeTier[] }> {
  const inL  = tokenIn.toLowerCase();
  const outL = tokenOut.toLowerCase();
  const paths: Array<{ tokens: string[]; fees: FeeTier[] }> = [];

  // 1. Direct pools — all three fee tiers
  for (const fee of FEE_TIERS) {
    paths.push({ tokens: [tokenIn, tokenOut], fees: [fee] });
  }

  // 2. Via WETH — best for LSTs, ARB, LINK, AAVE, WBTC
  if (inL !== WETH.toLowerCase() && outL !== WETH.toLowerCase()) {
    const inFee:  FeeTier = STABLES.has(inL)  ? 500 : 3000;
    const outFee: FeeTier = STABLES.has(outL) ? 500 : 3000;
    paths.push({ tokens: [tokenIn, WETH, tokenOut], fees: [inFee,  outFee] });
    paths.push({ tokens: [tokenIn, WETH, tokenOut], fees: [3000,   3000]   });
    paths.push({ tokens: [tokenIn, WETH, tokenOut], fees: [500,    500]    });
  }

  // 3. Non-stable → non-USDC stable via WETH→USDC
  if (!STABLES.has(inL) && STABLES.has(outL) &&
      outL !== USDC.toLowerCase() && outL !== USDCe.toLowerCase()) {
    paths.push({ tokens: [tokenIn, WETH, USDC,  tokenOut], fees: [3000, 500, 500] });
    paths.push({ tokens: [tokenIn, WETH, USDCe, tokenOut], fees: [3000, 500, 500] });
  }

  // 4. Stable → stable via USDC bridge
  if (STABLES.has(inL) && STABLES.has(outL)) {
    if (inL !== USDC.toLowerCase()  && outL !== USDC.toLowerCase())
      paths.push({ tokens: [tokenIn, USDC,  tokenOut], fees: [500, 500] });
    if (inL !== USDCe.toLowerCase() && outL !== USDCe.toLowerCase())
      paths.push({ tokens: [tokenIn, USDCe, tokenOut], fees: [500, 500] });
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
const QUOTE_TIMEOUT_MS = 1_500;

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
    const results: Array<{ success: boolean; returnData: string }> = await withTimeout(
      mc.tryAggregate.staticCall(
        false,
        encoded.map(e => ({
          target:   UNISWAP_QUOTER,
          callData: QUOTER_IFACE.encodeFunctionData("quoteExactInput", [e.path, amountIn]),
        })),
      ),
      QUOTE_TIMEOUT_MS,
    );
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
      encoded.map(async ({ path, desc }) => {
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
  logger.info(`  Uni best ${bestDesc}: in=${amountIn} out=${bestOut} min=${amountOutMinimum}`);

  return {
    swapPath:         bestPath,
    outputAmount:     bestOut,
    amountOutMinimum,
    gasEstimate:      bestGas,
    routeDesc:        bestDesc,
  };
}
