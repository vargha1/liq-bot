import * as dotenv from "dotenv";
dotenv.config();

function req(k: string): string { const v = process.env[k]; if (!v) throw new Error(`Missing env var: ${k}`); return v; }
function opt(k: string, d: string): string { return process.env[k] ?? d; }

export const CONFIG = {
  rpcUrl:            req("RPC_URL"),
  privateKey:        req("PRIVATE_KEY"),
  contractAddress:   req("CONTRACT_ADDRESS"),
  minProfitUsd:      parseFloat(opt("MIN_PROFIT_USD",      "0.10")),  // lowered from $0.50 — on Arbitrum gas is cheap
  positionsPerCycle: parseInt(opt("POSITIONS_PER_CYCLE",   "300"), 10),  // raised from 100 — Multicall3 handles 300 fine
  // Prune performance: the bottleneck is number of waves, not concurrency.
  // Each multicall round-trip takes ~2.9s regardless of concurrent count.
  // Bigger chunks = fewer waves = much faster total prune time.
  //   chunk=700,  conc=10 → 26 waves → ~12.5 min  (old default)
  //   chunk=1500, conc=10 → 13 waves →  ~48s       (new default)
  //   chunk=2000, conc=10 →  9 waves →  ~38s       (aggressive)
  pruneChunk:        parseInt(opt("PRUNE_CHUNK",           "1500"), 10),  // addresses per multicall during prune
  pruneConcurrency:  parseInt(opt("PRUNE_CONCURRENCY",     "10"),   10),  // parallel waves during prune
  maxGasGwei:        parseFloat(opt("MAX_GAS_GWEI",        "2")),
  // FIX: slippageBps now properly wired from env (was hardcoded to 100 in executor)
  slippageBps:       parseInt(opt("SLIPPAGE_BPS",          "100"), 10),
  // OPT 1: Separate RPC for tx submission — can be a lower-latency endpoint.
  // If not set, falls back to the main RPC_URL. On Arbitrum, Timeboost express
  // lane is dominated by Selini/Wintermute (~90% of rounds per empirical research).
  // The practical equivalent for a solo bot is maximising the priority tip so the
  // FCFS sequencer orders us first among non-express-lane transactions.
  submitRpcUrl:      opt("SUBMIT_RPC_URL", ""),
  // Priority tip in gwei added on top of network base — higher = earlier FCFS sequencing.
  timeboostPriorityGwei: parseFloat(opt("TIMEBOOST_PRIORITY_GWEI", "0.1")),
  // OPT 3: Max concurrent liquidation executions in the parallel queue.
  maxConcurrentExecutions: parseInt(opt("MAX_CONCURRENT_EXECUTIONS", "3"), 10),
  // OPT 4: Minimum USD debt before attempting a Uniswap quote. Positions below
  // this threshold use oracle-estimated pricing only (saves RPC round-trip).
  minDebtForQuoteUsd: parseFloat(opt("MIN_DEBT_FOR_QUOTE_USD", "50")),
  // FIX: deadline passed to liquidate() to prevent stale txs executing at wrong prices.
  // 60 seconds is generous on Arbitrum (~240 blocks). Set higher if your RPC is slow.
  deadlineSecs: parseInt(opt("DEADLINE_SECS", "60"), 10),
  logLevel:          opt("LOG_LEVEL", "info"),
  RPC_WS:            req("RPC_WS"),
  thegraphApiKey:    opt("THEGRAPH_API_KEY", ""),
  // pollIntervalMs kept for diagnose.ts compatibility (not used in main WS loop)
  pollIntervalMs:    parseInt(opt("POLL_INTERVAL_MS",      "3000"), 10),
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

export const RESERVES: Record<string, ReserveConfig> = {
  // ── Stablecoins ──────────────────────────────────────────────────────────────
  USDC: {
    symbol: "USDC", address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    decimals: 6, liquidationBonus: 10500, liquidationThreshold: 8000,
  },
  "USDC.e": {
    symbol: "USDC.e", address: "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8",
    decimals: 6, liquidationBonus: 10500, liquidationThreshold: 8000,
  },
  USDT: {
    symbol: "USDT", address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
    decimals: 6, liquidationBonus: 10500, liquidationThreshold: 7500,
  },
  DAI: {
    symbol: "DAI", address: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",
    decimals: 18, liquidationBonus: 10500, liquidationThreshold: 8000,
  },
  LUSD: {
    symbol: "LUSD", address: "0x93b346b6BC2548dA6A1E7d98E9a421B42541425b",
    decimals: 18, liquidationBonus: 10500, liquidationThreshold: 7500,
  },
  FRAX: {
    symbol: "FRAX", address: "0x17FC002b466eEc40DaE837Fc4bE5c67993ddBd6F",
    decimals: 18, liquidationBonus: 10500, liquidationThreshold: 7500,
  },
  // FIX: Added GHO — Aave's native stablecoin, active on Arbitrum V3
  GHO: {
    symbol: "GHO", address: "0x7dfF72693f6A4149b17e7C6314655f6A9F7c8B33",
    decimals: 18, liquidationBonus: 10500, liquidationThreshold: 7500,
  },
  // ── Major volatile assets ─────────────────────────────────────────────────────
  WETH: {
    symbol: "WETH", address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    decimals: 18, liquidationBonus: 10500, liquidationThreshold: 8250,
  },
  WBTC: {
    symbol: "WBTC", address: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f",
    decimals: 8,  liquidationBonus: 10750, liquidationThreshold: 7500,
  },
  tBTC: {
    // Threshold Bitcoin — onboarded to Aave v3 Arbitrum Q1 2025 (ARFC 2025-02-27)
    // LT: 78%, Liquidation Bonus: 7.5%, collateral only (not borrowable)
    symbol: "tBTC", address: "0x6c84a8f1c29108F47a79964b5Fe888D4f4D0dE40",
    decimals: 18, liquidationBonus: 10750, liquidationThreshold: 7800,
  },
  ARB: {
    symbol: "ARB", address: "0x912CE59144191C1204E64559FE8253a0e49E6548",
    decimals: 18, liquidationBonus: 11000, liquidationThreshold: 7000,
  },
  LINK: {
    symbol: "LINK", address: "0xf97f4df75117a78c1A5a0DBb814Af92458539FB4",
    decimals: 18, liquidationBonus: 11000, liquidationThreshold: 6650,
  },
  AAVE: {
    symbol: "AAVE", address: "0xba5DdD1f9d7F570dc94a51479a000E3BCE967196",
    decimals: 18, liquidationBonus: 11000, liquidationThreshold: 7000,
  },
  // GMX removed — Aave V3 Arbitrum oracle price feed for GMX was deprecated
  // and now reverts (require(false)). Any call to getAssetPrice or getAssetsPrices
  // including GMX causes the entire batch to fail. Removed Feb 2026.
  // ── Liquid staking tokens ─────────────────────────────────────────────────────
  wstETH: {
    symbol: "wstETH", address: "0x5979D7b546E38E414F7E9822514be443A4800529",
    decimals: 18, liquidationBonus: 10700, liquidationThreshold: 8000,
  },
  rETH: {
    symbol: "rETH", address: "0xEC70Dcb4A1EFa46b8F2D97C310C9c4790ba5ffA8",
    decimals: 18, liquidationBonus: 10700, liquidationThreshold: 7400,
  },
  weETH: {
    symbol: "weETH", address: "0x35751007a407ca6FEFfE80b3cB397736D2cf4dbe",
    decimals: 18, liquidationBonus: 10700, liquidationThreshold: 7500,
  },
  ezETH: {
    symbol: "ezETH", address: "0x2416092f143378750bb29b79eD961ab195CcEea5",
    decimals: 18, liquidationBonus: 10700, liquidationThreshold: 7500,
  },
  rsETH: {
    symbol: "rsETH", address: "0x4186BFC76E2E237523CBC30FD220FE055156b41F",
    decimals: 18, liquidationBonus: 10700, liquidationThreshold: 7500,
  },
  // ── Additional stablecoins / assets active on Aave V3 Arbitrum ───────────────
  EURS: {
    // STASIS Euro stablecoin — confirmed active (aEURS on Arbitrum Arbiscan)
    symbol: "EURS", address: "0xD22a58f79e9481D1a88e00c343885A588b34b68B",
    decimals: 2, liquidationBonus: 10500, liquidationThreshold: 7500,
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
];

export const DATA_PROVIDER_ABI = [
  "function getUserReserveData(address asset, address user) external view returns (uint256 currentATokenBalance, uint256 currentStableDebt, uint256 currentVariableDebt, uint256 principalStableDebt, uint256 scaledVariableDebt, uint256 stableBorrowRate, uint256 liquidityRate, uint40 stableRateLastUpdated, bool usageAsCollateralEnabled)",
  "function getAllReservesTokens() external view returns (tuple(string symbol, address tokenAddress)[] memory)",
];

export const ORACLE_ABI = [
  "function getAssetPrice(address asset) external view returns (uint256)",
  "function getAssetsPrices(address[] calldata assets) external view returns (uint256[] memory)",
];

// FIX 5.1 — UiPoolDataProvider ABI
// getUserReservesData returns full state for ALL reserves for a user in one call.
// scaledATokenBalance > 0 && usageAsCollateralEnabledOnUser → collateral position
// scaledVariableDebt > 0 → variable debt position
// NOTE: scaledVariableDebt is the raw scaled amount; multiply by reserveNormalizedVariableDebt
// to get actual balance. For liquidation sizing we fetch actual via the breakdown result
// and the oracle prices. The key use is detecting which assets are relevant.
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
export const MULTICALL3_ABI = [
  "function aggregate(tuple(address target, bytes callData)[] calls) external view returns (uint256 blockNumber, bytes[] returnData)",
  "function tryAggregate(bool requireSuccess, tuple(address target, bytes callData)[] calls) external view returns (tuple(bool success, bytes returnData)[] results)",
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
