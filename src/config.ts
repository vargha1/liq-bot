import * as dotenv from "dotenv";
dotenv.config();

function req(k: string): string { const v = process.env[k]; if (!v) throw new Error(`Missing env var: ${k}`); return v; }
function opt(k: string, d: string): string { return process.env[k] ?? d; }

export const CONFIG = {
  rpcUrl:            req("RPC_URL"),
  privateKey:        req("PRIVATE_KEY"),
  contractAddress:   req("CONTRACT_ADDRESS"),
  minProfitUsd:      parseFloat(opt("MIN_PROFIT_USD",      "0.07")),  // lowered from $0.50 — on Arbitrum gas is cheap
  // Lowered from 1000: each multicall sub-chunk costs a full RPC round-trip
  // (~0.3-3s depending on provider) and the whole cycle serializes behind it.
  // Detection latency now comes from event-driven triggers + price-drop wakes;
  // the sweep is just a safety net, so a smaller targeted batch wins.
  positionsPerCycle: parseInt(opt("POSITIONS_PER_CYCLE",   "300"),  10),
  // Multicall3 sub-chunk size for refreshBatch's getUserAccountData scan. Was
  // hardcoded at 300 — fine on providers with a generous eth_call gas cap, but
  // some shared/free-tier RPC nodes reject large batched multicalls outright
  // with an empty-data CALL_EXCEPTION ("missing revert data") regardless of
  // requireSuccess=false, since that failure happens before Multicall3's own
  // per-call error handling runs. Lowered default + made tunable so this can be
  // fixed via env instead of a code change if your provider is one of those.
  mcSubchunk:        parseInt(opt("MC_SUBCHUNK",            "50"),   10),
  // Global cap on NEW eth_call requests started per second on the shared
  // provider (see rpcLimiter.ts). Restricted RPC plans typically enforce a
  // requests-per-second ceiling, not a concurrency ceiling — a concurrency cap
  // (max N in flight) was tried first and didn't help, since fast-resolving
  // calls can still burst past an RPS limit with few in flight at once.
  // Default of 4 matches the pace the startup prune sustains successfully
  // (8-wide waves resolving in ~2.1s ≈ ~4 req/s). Lower further (2-3) if
  // "missing revert data" errors persist; raise if your provider tolerates more.
  rpcCallsPerSecond: parseInt(opt("RPC_CALLS_PER_SECOND",   "4"),    10),
  // Prune performance: the bottleneck is number of waves, not concurrency.
  // Each multicall round-trip takes ~2.9s regardless of concurrent count.
  // getUserAccountData is gas-heavy (iterates all Aave reserves internally).
  // Chunk must stay ≤500 or Multicall3 eth_call exceeds Arbitrum gas limit.
  //   chunk=500, conc=8 → 36 waves → ~1.5 min   (safe default)
  //   chunk=700, conc=8 → 26 waves → ~1.1 min   (risky on some providers)
  //   chunk=1500 causes CALL_EXCEPTION on every chunk → 0 pruned
  pruneChunk:        parseInt(opt("PRUNE_CHUNK",           "500"),  10),  // addresses per multicall during prune
  pruneConcurrency:  parseInt(opt("PRUNE_CONCURRENCY",     "8"),    10),  // parallel waves during prune
  // Max danger-tier positions whose breakdown is pre-warmed per sweep.
  //
  // This is coupled to RPC_CALLS_PER_SECOND and it is easy to starve the bot
  // here: each position costs 2 eth_calls, so the old hardcoded 100 was 200
  // calls — 50 SECONDS of the entire call budget at 4 calls/sec, during which
  // refreshBatch and the trigger engine's price confirmations queue behind it.
  // The sweep is dispatched every 30 blocks (~7.5s), so it could never finish
  // before the next one was due.
  //
  // Budget rule of thumb: prewarmMax × 2 / rpcCallsPerSecond should stay well
  // under the ~7.5s sweep interval. At the default 4 calls/sec that means ~15;
  // the default below assumes you raise rpcCallsPerSecond once you know what
  // your Chainstack plan tolerates. Coverage matters — the trigger engine can
  // only fire on positions whose breakdown is cached — so raise BOTH together.
  prewarmMax:        parseInt(opt("PREWARM_MAX",            "40"),   10),
  // Minimum gap between polling sweeps, in milliseconds.
  //
  // Arbitrum produces a block every ~250ms and the cycle used to fire on every
  // one of them, immediately re-arming itself from its own finally block
  // whenever a newer block had arrived. So the sweep ran continuously at
  // maximum rate and consumed the entire eth_call budget, starving the trigger
  // engine's price confirmations and the breakdown prewarm — the two things
  // that actually detect liquidations early.
  //
  // The sweep is a safety net now that the event-driven trigger works, so it
  // need not run every block. Detection latency is unaffected: the trigger
  // fires on Chainlink events independently of this interval. Set to 0 to
  // restore the old every-block behaviour.
  cycleMinIntervalMs: parseInt(opt("CYCLE_MIN_INTERVAL_MS", "1000"), 10),
  // Head-room added to the estimated gas units. Arbitrum refunds unused L2 gas,
  // but the node reserves gasLimit × maxFeePerGas from the wallet balance when
  // validating a transaction — so an oversized buffer starves concurrent
  // submissions on a thin balance. 400k is ample over the measured estimates.
  gasLimitBuffer:    parseInt(opt("GAS_LIMIT_BUFFER",      "400000"), 10),
  maxGasGwei:        parseFloat(opt("MAX_GAS_GWEI",        "2")),
  // FIX: slippageBps now properly wired from env (was hardcoded to 100 in executor)
  slippageBps:       parseInt(opt("SLIPPAGE_BPS",          "100"), 10),
  // OPT 1: Separate RPC for tx submission — can be a lower-latency endpoint.
  // If not set, falls back to the main RPC_URL. On Arbitrum, Timeboost express
  // lane is dominated by Selini/Wintermute (~90% of rounds per empirical research).
  // The practical equivalent for a solo bot is maximising the priority tip so the
  // FCFS sequencer orders us first among non-express-lane transactions.
  submitRpcUrl:      opt("SUBMIT_RPC_URL", ""),
  // Broadcast every signed liquidation to Arbitrum's public sequencer endpoint
  // in addition to the configured RPCs. Submitting straight to the sequencer
  // removes the forwarding hop your general-purpose RPC provider adds, which is
  // pure latency on the one path where latency decides whether you win.
  broadcastToSequencer: opt("BROADCAST_TO_SEQUENCER", "true") !== "false",
  // Priority tip in gwei.
  //
  // CORRECTION: this does NOT buy earlier ordering. Arbitrum's sequencer is
  // strictly first-come-first-served by arrival time; priority fees do not
  // reorder transactions (see the note in executor.ts, which had this right
  // while this comment did not). Ordering is decided by arrival time and, above
  // that, by Timeboost's express lane — which is auctioned, not tipped for.
  // The tip is kept because it is harmless and costs almost nothing on L2.
  timeboostPriorityGwei: parseFloat(opt("TIMEBOOST_PRIORITY_GWEI", "0.1")),
  // OPT 3: Max concurrent liquidation executions in the parallel queue.
  maxConcurrentExecutions: parseInt(opt("MAX_CONCURRENT_EXECUTIONS", "3"), 10),
  // OPT 4 (retired): hot-path Uniswap quotes were removed — amountOutMinimum is
  // now derived from Aave oracle prices and routes come from a background cache.
  // Key kept for env compat; no longer read on the hot path.
  minDebtForQuoteUsd: parseFloat(opt("MIN_DEBT_FOR_QUOTE_USD", "50")),
  // FIX: deadline passed to liquidate() to prevent stale txs executing at wrong prices.
  // 20 seconds is ample on Arbitrum (inclusion is ~1-2 blocks when submitted
  // promptly); a tight deadline kills stale txs fast instead of letting them
  // execute into post-competition state. Calibrated against chain clock skew —
  // see executor.ts clock calibration.
  deadlineSecs: parseInt(opt("DEADLINE_SECS", "20"), 10),
  logLevel:          opt("LOG_LEVEL", "info"),
  RPC_WS:            req("RPC_WS"),
  thegraphApiKey:    opt("THEGRAPH_API_KEY", ""),
  // pollIntervalMs kept for diagnose.ts compatibility (not used in main WS loop)
  pollIntervalMs:    parseInt(opt("POLL_INTERVAL_MS",      "3000"), 10),
  // Bug #4 fix: flashloan premium is governance-configurable — was hardcoded to 0.05% (5 bps).
  // If Aave changes the premium, update this env var or the default below.
  flashloanPremiumBps: parseInt(opt("FLASHLOAN_PREMIUM_BPS", "5"), 10),  // 5 = 0.05%
  // Event-driven trigger engine: subscribes to Chainlink AnswerUpdated events for
  // all reserve feeds and fires liquidations on local HF recomputation, without
  // waiting for the polling cycle. Disable with TRIGGER_ENABLED=false.
  triggerEnabled:    opt("TRIGGER_ENABLED", "true") !== "false",
  // Sequencer-feed accelerator. Arbitrum broadcasts transactions as it orders
  // them, before the block carrying them is published — so watching the feed for
  // a Chainlink transmit() beats every bot waiting on a log subscription.
  //
  // OFF by default: it decodes Arbitrum's message framing and Chainlink's OCR
  // report layout, both of which can change upstream. It is a pure accelerator —
  // the AnswerUpdated log subscription stays authoritative either way — so a
  // decode that silently stops matching costs you the head start, not
  // correctness. Turn it on once you have watched the logs confirm it matching.
  sequencerFeedEnabled: opt("SEQUENCER_FEED_ENABLED", "false") === "true",
  sequencerFeedUrl:     opt("SEQUENCER_FEED_URL", "wss://arb1.arbitrum.io/feed"),
  // Local health factor below which the trigger fires WITHOUT an authoritative
  // check. The hot-path price snapshot mixes ratio estimates with TTL-stale
  // entries, so the local figure carries low tens of bps of error; below this
  // cut that cannot change the verdict. At or above it, one getUserAccountData
  // multicall confirms before any gas is committed.
  triggerConfirmHf:     parseFloat(opt("TRIGGER_CONFIRM_HF", "0.995")),
} as const;

// ─── Aave V3 Arbitrum core addresses ─────────────────────────────────────────
// All addresses are EIP-55 checksummed. ethers v6 validates checksums on every
// contract call — a wrong-case address throws INVALID_ARGUMENT before any RPC
// call is made, causing silent fallback to the slower path for every breakdown.
//
// Sources (verified Feb 2026):
//   Pool, DataProvider, Oracle, PoolAddressesProvider:
//     https://aave.com/docs/resources/addresses (Arbitrum V3 Core Market)
//   UiPoolDataProvider:
//     https://arbiscan.io/address/0x13c833256BD767da2320d727a3691BAff3770E39
//   Multicall3: canonical address, same on all EVM chains
export const AAVE_POOL           = "0x794a61358D6845594F94dc1DB02A252b5b4814aD";
export const AAVE_DATA_PROVIDER  = "0x69FA688f1Dc47d4B5d8029D5a35FB7a548310654";
export const AAVE_ORACLE         = "0xb56c2F0B653B2e0b10C9b928C8580Ac5Df02C7C7";
export const POOL_ADDRESSES_PROVIDER = "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb";

// FIXED: previous address (0x145dE30c...) had an incorrect EIP-55 checksum,
// causing ethers v6 to throw INVALID_ARGUMENT on every getUserReservesData call
// and silently fall back to the full per-reserve scan (20× slower).
// Updated to the correct deployed address verified on Arbiscan.
export const UI_POOL_DATA_PROVIDER = "0x13c833256BD767da2320d727a3691BAff3770E39";

// FIX 4.1/4.5 — Multicall3 canonical address (same on all EVM chains)
export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";

// ─── Subgraph ─────────────────────────────────────────────────────────────────
function buildSubgraphUrl(): string {
  const key = CONFIG.thegraphApiKey;
  if (!key) return "";
  return `https://gateway.thegraph.com/api/${key}/subgraphs/id/4xyasjQeREe7PxnF6wVdobZvCw5mhoHZq3T7guRpuNPf`;
}
export const AAVE_SUBGRAPH_URL = buildSubgraphUrl();

// ─── Address checksum validation ─────────────────────────────────────────────
// ethers v6 throws INVALID_ARGUMENT on any contract call that uses an address
// with a wrong EIP-55 checksum — even before the RPC call is made. Validate
// all addresses at module load time so the bot fails loudly on startup with a
// clear error rather than silently falling back to slower code paths at runtime.
import { getAddress } from "ethers";
const CONTRACT_ADDRESSES: Record<string, string> = {
  AAVE_POOL, AAVE_DATA_PROVIDER, AAVE_ORACLE,
  POOL_ADDRESSES_PROVIDER, UI_POOL_DATA_PROVIDER, MULTICALL3,
};
for (const [name, addr] of Object.entries(CONTRACT_ADDRESSES)) {
  try {
    if (getAddress(addr) !== addr) {
      throw new Error(`${name}: address ${addr} has wrong EIP-55 checksum — correct form is ${getAddress(addr)}`);
    }
  } catch (e: any) {
    // Re-throw with name context so the error is immediately actionable
    if (!e.message.startsWith(name)) throw new Error(`${name}: ${e.message}`);
    throw e;
  }
}

// Uniswap V3 on Arbitrum
// Arbitrum One's public sequencer RPC. Accepts eth_sendRawTransaction directly,
// so a liquidation reaches the sequencer without the extra hop through a
// general-purpose provider. Broadcast-only — never used for reads.
export const ARBITRUM_SEQUENCER_RPC = "https://arb1-sequencer.arbitrum.io/rpc";

export const UNISWAP_ROUTER = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45"; // SwapRouter02
export const UNISWAP_QUOTER = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e"; // QuoterV2
export const CHAIN_ID       = 42161;

// ─── Reserve configs ──────────────────────────────────────────────────────────
// liquidationBonus: 10000 = 0%, 10500 = 5%, 10750 = 7.5%, 11000 = 10%, 11500 = 15%
// All addresses verified on Arbiscan.
export interface ReserveConfig {
  symbol:               string;
  address:              string;
  decimals:             number;
  liquidationBonus:     number;
  liquidationThreshold: number;
}

// liquidationBonus / liquidationThreshold below are the BOOTSTRAP values used
// only as a bootstrap/reference. At runtime the authority is ReserveRegistry,
// which loads every reserve's real configuration from Pool.getReserveData at
// startup and refreshes it on an interval — e-mode included, which this static
// table cannot express. Values here were verified against
// AaveProtocolDataProvider.getReserveConfigurationData on Arbitrum One.
//
// Keep them close to reality even though they are overridden: the local HF
// recomputation in the trigger engine runs on whatever is available at that
// instant, and a stale threshold shifts every computed HF. The previous values
// were off by up to 850 bps (LINK 6650 vs 7500, ARB 7000 vs 6300).
export const RESERVES: Record<string, ReserveConfig> = {
  // ── Stablecoins ──────────────────────────────────────────────────────────────
  USDC: {
    symbol: "USDC", address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    decimals: 6, liquidationBonus: 10500, liquidationThreshold: 7800,
  },
  "USDC.e": {
    symbol: "USDC.e", address: "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8",
    decimals: 6, liquidationBonus: 10500, liquidationThreshold: 7800,
  },
  USDT: {
    symbol: "USDT", address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
    decimals: 6, liquidationBonus: 10500, liquidationThreshold: 7800,
  },
  DAI: {
    symbol: "DAI", address: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",
    decimals: 18, liquidationBonus: 10500, liquidationThreshold: 7700,
  },
  LUSD: {
    // LT 0 / usageAsCollateral false on-chain — borrowable, but contributes
    // nothing to a borrower's collateral side.
    symbol: "LUSD", address: "0x93b346b6BC2548dA6A1E7d98E9a421B42541425b",
    decimals: 18, liquidationBonus: 10500, liquidationThreshold: 0,
  },
  FRAX: {
    symbol: "FRAX", address: "0x17FC002b466eEc40DaE837Fc4bE5c67993ddBd6F",
    decimals: 18, liquidationBonus: 10600, liquidationThreshold: 7200,
  },
  // FIX: Added GHO — Aave's native stablecoin, active on Arbitrum V3.
  // LT 0 / usageAsCollateral false on-chain (borrow-only asset).
  GHO: {
    symbol: "GHO", address: "0x7dfF72693f6A4149b17e7C6314655f6A9F7c8B33",
    decimals: 18, liquidationBonus: 10500, liquidationThreshold: 0,
  },
  // ── Major volatile assets ─────────────────────────────────────────────────────
  WETH: {
    symbol: "WETH", address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    decimals: 18, liquidationBonus: 10500, liquidationThreshold: 8400,
  },
  WBTC: {
    symbol: "WBTC", address: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f",
    decimals: 8,  liquidationBonus: 10700, liquidationThreshold: 7800,
  },
  tBTC: {
    // Threshold Bitcoin — onboarded to Aave v3 Arbitrum Q1 2025 (ARFC 2025-02-27)
    symbol: "tBTC", address: "0x6c84a8f1c29108F47a79964b5Fe888D4f4D0dE40",
    decimals: 18, liquidationBonus: 10750, liquidationThreshold: 7800,
  },
  ARB: {
    symbol: "ARB", address: "0x912CE59144191C1204E64559FE8253a0e49E6548",
    decimals: 18, liquidationBonus: 11000, liquidationThreshold: 6300,
  },
  LINK: {
    symbol: "LINK", address: "0xf97f4df75117a78c1A5a0DBb814Af92458539FB4",
    decimals: 18, liquidationBonus: 11000, liquidationThreshold: 7500,
  },
  AAVE: {
    symbol: "AAVE", address: "0xba5DdD1f9d7F570dc94a51479a000E3BCE967196",
    decimals: 18, liquidationBonus: 11000, liquidationThreshold: 7300,
  },
  // GMX removed — Aave V3 Arbitrum oracle price feed for GMX was deprecated
  // and now reverts (require(false)). Any call to getAssetPrice or getAssetsPrices
  // including GMX causes the entire batch to fail. Removed Feb 2026.
  // ── Liquid staking tokens ─────────────────────────────────────────────────────
  wstETH: {
    symbol: "wstETH", address: "0x5979D7b546E38E414F7E9822514be443A4800529",
    decimals: 18, liquidationBonus: 10720, liquidationThreshold: 7900,
  },
  rETH: {
    symbol: "rETH", address: "0xEC70Dcb4A1EFa46b8F2D97C310C9c4790ba5ffA8",
    decimals: 18, liquidationBonus: 10750, liquidationThreshold: 7400,
  },
  weETH: {
    symbol: "weETH", address: "0x35751007a407ca6FEFfE80b3cB397736D2cf4dbe",
    decimals: 18, liquidationBonus: 10750, liquidationThreshold: 7700,
  },
  ezETH: {
    // LT reduced to 10 bps on-chain — being offboarded. Positions holding it get
    // essentially no collateral credit, which is exactly what the real HF does.
    symbol: "ezETH", address: "0x2416092f143378750bb29b79eD961ab195CcEea5",
    decimals: 18, liquidationBonus: 10750, liquidationThreshold: 10,
  },
  rsETH: {
    // Frozen on-chain, LT 10 bps — same offboarding path as ezETH.
    symbol: "rsETH", address: "0x4186BFC76E2E237523CBC30FD220FE055156b41F",
    decimals: 18, liquidationBonus: 10750, liquidationThreshold: 10,
  },
  // ── Additional stablecoins / assets active on Aave V3 Arbitrum ───────────────
  EURS: {
    // STASIS Euro stablecoin — frozen on-chain but existing positions remain
    // liquidatable, so it stays in the table.
    symbol: "EURS", address: "0xD22a58f79e9481D1a88e00c343885A588b34b68B",
    decimals: 2, liquidationBonus: 10750, liquidationThreshold: 6700,
  },
  // NOTE: MAI (0x3F56e0ad...) and USDe (0x5d3a1Ff2...) were removed — their
  // Aave oracle price feeds on Arbitrum revert (deprecated). Keeping them in
  // RESERVES causes every batch oracle call to fail and fall back to slow
  // per-asset calls. If these feeds are re-enabled upstream, add them back.
};


// Address → symbol reverse lookup (lowercase keys)
export const ADDRESS_TO_SYMBOL: Record<string, string> = {};
for (const [, r] of Object.entries(RESERVES)) {
  ADDRESS_TO_SYMBOL[r.address.toLowerCase()] = r.symbol;
}

// ─── ABIs ──────────────────────────────────────────────────────────────────────
export const AAVE_POOL_ABI = [
  "function getUserAccountData(address user) external view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
  "function liquidationCall(address collateralAsset, address debtAsset, address user, uint256 debtToCover, bool receiveAToken) external",
  "event LiquidationCall(address indexed collateralAsset, address indexed debtAsset, address indexed user, uint256 debtToCover, uint256 liquidatedCollateralAmount, address liquidator, bool receiveAToken)",
  "event Borrow(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint8 interestRateMode, uint256 borrowRate, uint16 indexed referralCode)",
  "event Supply(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint16 indexed referralCode)",
  "event Repay(address indexed reserve, address indexed user, address indexed repayer, uint256 amount, bool useATokens)",
  "event Withdraw(address indexed reserve, address indexed user, address indexed to, uint256 amount)",
  // Toggling an asset as collateral changes the health factor without moving a
  // single balance. These were not monitored, so a borrower flipping collateral
  // off was invisible until something else touched their position.
  "event ReserveUsedAsCollateralEnabled(address indexed reserve, address indexed user)",
  "event ReserveUsedAsCollateralDisabled(address indexed reserve, address indexed user)",
];

export const DATA_PROVIDER_ABI = [
  "function getUserReserveData(address asset, address user) external view returns (uint256 currentATokenBalance, uint256 currentStableDebt, uint256 currentVariableDebt, uint256 principalStableDebt, uint256 scaledVariableDebt, uint256 stableBorrowRate, uint256 liquidityRate, uint40 stableRateLastUpdated, bool usageAsCollateralEnabled)",
  "function getAllReservesTokens() external view returns (tuple(string symbol, address tokenAddress)[] memory)",
];

export const ORACLE_ABI = [
  "function getAssetPrice(address asset) external view returns (uint256)",
  "function getAssetsPrices(address[] calldata assets) external view returns (uint256[] memory)",
  // Underlying Chainlink feed per reserve — used by the trigger engine to
  // subscribe to AnswerUpdated events (the earliest possible liquidation signal).
  "function getSourceOfAsset(address asset) external view returns (address)",
];

// FIX 5.1 — UiPoolDataProvider ABI
// getUserReservesData returns full state for ALL reserves for a user in one call.
// scaledATokenBalance > 0 && usageAsCollateralEnabledOnUser → collateral position
// scaledVariableDebt > 0 → variable debt position
// NOTE: scaledVariableDebt is the raw scaled amount; multiply by reserveNormalizedVariableDebt
// to get actual balance. For liquidation sizing we fetch actual via the breakdown result
// and the oracle prices. The key use is detecting which assets are relevant.
// VERIFIED against the deployed UiPoolDataProviderV3 on Arbitrum (Feb 2026).
// The struct has exactly FOUR fields. Aave 3.2+ removed stable-rate borrowing,
// which took `principalStableDebt`, `stableBorrowRate` and
// `stableBorrowLastUpdateTimestamp` out of UserReserveData.
//
// The previous ABI here declared a fifth field (principalStableDebt). ethers
// then failed to decode EVERY response ("could not decode result data"), so
// getUserReservesData threw on every call and the breakdown always fell through
// to the slow all-reserves scan — and userEmodeCategoryId was never populated,
// silently disabling all e-mode handling. If Aave upgrades this contract,
// re-verify the field count before trusting a decode.
//
// Note also that the array is returned in reserve-id order, so the index of an
// entry IS that reserve's id (confirmed: WETH id 4, USDC id 12).
export const UI_POOL_DATA_PROVIDER_ABI = [
  `function getUserReservesData(address provider, address user)
    external view returns (
      tuple(
        address underlyingAsset,
        uint256 scaledATokenBalance,
        bool usageAsCollateralEnabledOnUser,
        uint256 scaledVariableDebt
      )[] memory userReserves,
      uint8 userEmodeCategoryId
    )`,
];

// FIX 4.1/4.5 — Multicall3 ABI
// tryAggregate(false, ...) never reverts — returns (success, data) per call.
// Use for refreshBatch: 100 getUserAccountData calls → 1 round-trip.
// The 3-arg tryAggregate3 allows per-call gas limits to prevent any single
// sub-call from consuming excessive gas (important for getUserAccountData
// which iterates all Aave reserves internally).
export const MULTICALL3_ABI = [
  "function aggregate(tuple(address target, bytes callData)[] calls) external view returns (uint256 blockNumber, bytes[] returnData)",
  "function tryAggregate(bool requireSuccess, tuple(address target, bytes callData)[] calls) external view returns (tuple(bool success, bytes returnData)[] results)",
  "function tryAggregate3(bool requireSuccess, tuple(address target, bool allowFailure, bytes callData)[] calls) external payable returns (tuple(bool success, bytes returnData)[] results)",
];

export const LIQUIDATOR_ABI = [
  "function liquidate(address collateralAsset, address debtAsset, address borrower, uint256 debtToCover, bytes calldata swapPath, uint256 amountOutMinimum, uint256 deadline) external",
  "function withdraw(address token) external",
  "function withdrawNative() external",
  "function revokeApproval(address token, address spender) external",
  "function owner() external view returns (address)",
  "event LiquidationExecuted(address indexed borrower, address indexed collateralAsset, address indexed debtAsset, uint256 debtCovered, uint256 collateralReceived, uint256 profitRaw, uint256 flashloanPremium)",
];

export const ERC20_ABI = [
  "function balanceOf(address) external view returns (uint256)",
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function decimals() external view returns (uint8)",
];
