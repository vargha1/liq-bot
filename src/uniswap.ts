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
import { RESERVES } from "./config";

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

function getQuoter(provider: ethers.Provider): ethers.Contract {
  if (provider !== _cachedQuoterProvider) {
    _cachedQuoterProvider = provider;
    _cachedQuoter = new ethers.Contract(UNISWAP_QUOTER, QUOTER_ABI, provider);
  }
  return _cachedQuoter!;
}

// Fee tiers available on Uniswap V3
const FEE_TIERS = [500, 3000, 10000] as const;
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
  const quoter     = getQuoter(provider);  // FIX: use cached contract
  const candidates = candidatePaths(tokenIn, tokenOut);

  // Quote all candidates in parallel, each with a timeout
  const quoteResults = await Promise.allSettled(
    candidates.map(async ({ tokens, fees }) => {
      const path = encodePath(tokens, fees);
      const desc = tokens.map((t, i) =>
        i < fees.length ? `${symOf(t)}-[${fees[i]}]` : symOf(t)
      ).join("→");

      const [amountOut, , , gasEstimate] = await withTimeout(
        quoter.quoteExactInput.staticCall(path, amountIn),
        QUOTE_TIMEOUT_MS,
      );
      return {
        path,
        desc,
        out:  amountOut as bigint,
        gas:  Number(gasEstimate as bigint),
      };
    })
  );

  let bestOut  = 0n;
  let bestPath = "";
  let bestGas  = 350_000;
  let bestDesc = "";

  for (const result of quoteResults) {
    if (result.status !== "fulfilled") continue;
    const { path, desc, out, gas } = result.value;
    logger.debug(`  Uni ${desc}: out=${out} gas=${gas}`);
    if (out > bestOut) {
      bestOut  = out;
      bestPath = path;
      bestGas  = gas;
      bestDesc = desc;
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
