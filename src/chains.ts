// Per-chain facts. One bot process serves ONE chain, chosen with CHAIN=<key>
// (default "arbitrum"); run a second process with its own .env for another chain.
//
// Everything that differs between chains lives here and nowhere else: protocol
// addresses, block time, how transaction fees are charged, whether the sequencer
// takes a direct broadcast, and how collateral is routed through Uniswap. The rest
// of the code reads PROFILE and never branches on a chain name.
//
// All addresses are EIP-55 checksummed — config.ts verifies that at load, because
// ethers v6 throws on a wrong-case address before any RPC call is made.
import "dotenv/config";

export interface ReserveConfig {
  symbol:               string;
  address:              string;
  decimals:             number;
  liquidationBonus:     number;
  liquidationThreshold: number;
}

export type ChainKey = "arbitrum" | "base";

export interface HubConfig { token: string; fees: readonly number[] }

export interface ChainProfile {
  key:          ChainKey;
  name:         string;
  chainId:      number;
  nativeSymbol: string;                 // gas token, priced through the WETH reserve
  explorer:     string;
  // Suffix for per-chain state files (caches, denylist). Empty for the original
  // chain so existing files keep working.
  stateSuffix:  string;

  aave: {
    pool:              string;
    dataProvider:      string;
    oracle:            string;
    addressesProvider: string;
    uiPoolDataProvider: string;
    deployBlock:       bigint;          // first block of the Pool, for the historical Borrow scan
    subgraphId:        string;          // The Graph deployment id, "" if none is known
  };
  uniswap: { router: string; quoter: string };
  multicall3: string;

  blockTimeMs: number;
  // eth_getLogs range per request during the historical scan (halved on failure).
  scanChunk:   bigint;

  // How a transaction's data is charged on top of L2 execution gas.
  //   arbitrum : ArbGasInfo.getL1BaseFeeEstimate() x calldata gas
  //   op-stack : GasPriceOracle.getL1FeeUpperBound(size)
  l1Fee: { kind: "arbitrum" | "op-stack"; overheadBytes: number };
  // Where an L2 block number can be read inside a Multicall3 batch.
  //   arbsys    : Arbitrum precompile (block.number there is the L1 number)
  //   multicall : Multicall3.getBlockNumber() (block.number is the L2 number)
  blockNumberSource: "arbsys" | "multicall";

  gas: {
    maxGasWei: bigint;                  // above this a gas price is treated as bogus
    tipGwei:   number;                  // default priority tip
    // fcfs: arrival time orders transactions, a tip buys nothing.
    // priority-fee: the sequencer orders by tip, so the tip raises maxFeePerGas.
    ordering:  "fcfs" | "priority-fee";
  };
  sequencerRpc:     string;             // direct-broadcast endpoint, "" if none
  sequencerFeedUrl: string;             // pre-block transaction feed, "" if none
  svrSupported:     boolean;            // Chainlink SVR / Atlas auctions (Arbitrum only)

  routing: {
    weth:           string;
    usdc:           string;
    hubs:           HubConfig[];                          // one-bridge-token routes
    twoHub:         Array<[string, string]>;              // two-bridge-token routes
    twoHubTailFees: readonly number[];                    // fee tiers of the last leg
    stables:        string[];                             // lowercase
    warmCollaterals: string[];
    warmDebts:      string[];
  };

  // Bootstrap values only — ReserveRegistry reads the real configuration (and any
  // reserve missing here) from the Pool at startup.
  reserves: Record<string, ReserveConfig>;
}

// ─── Arbitrum One ────────────────────────────────────────────────────────────
// Sources (verified Feb 2026): https://aave.com/docs/resources/addresses
// liquidationBonus: 10000 = 0%, 10500 = 5%, 10750 = 7.5%, 11000 = 10%
// Values were verified against AaveProtocolDataProvider.getReserveConfigurationData.
const ARB_WETH  = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";
const ARB_USDC  = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const ARB_USDCE = "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8";
const ARB_WBTC  = "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f";

const ARBITRUM: ChainProfile = {
  key: "arbitrum",
  name: "Arbitrum One",
  chainId: 42161,
  nativeSymbol: "ETH",
  explorer: "https://arbiscan.io",
  stateSuffix: "",
  aave: {
    pool:               "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
    dataProvider:       "0x69FA688f1Dc47d4B5d8029D5a35FB7a548310654",
    oracle:             "0xb56c2F0B653B2e0b10C9b928C8580Ac5Df02C7C7",
    addressesProvider:  "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb",
    // The earlier address had a wrong EIP-55 checksum, which made every
    // getUserReservesData call throw and silently pushed the breakdown onto the
    // slow all-reserves scan. This is the deployed UiPoolDataProviderV3.
    uiPoolDataProvider: "0x13c833256BD767da2320d727a3691BAff3770E39",
    deployBlock:        7742429n,
    subgraphId:         "4xyasjQeREe7PxnF6wVdobZvCw5mhoHZq3T7guRpuNPf",
  },
  uniswap: {
    router: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",   // SwapRouter02
    quoter: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",   // QuoterV2
  },
  multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11",
  blockTimeMs: 250,
  scanChunk: 3_000n,
  l1Fee: { kind: "arbitrum", overheadBytes: 0 },
  blockNumberSource: "arbsys",
  gas: { maxGasWei: 2_000_000_000n, tipGwei: 0.1, ordering: "fcfs" },
  // Arbitrum One's public sequencer RPC accepts eth_sendRawTransaction directly,
  // which skips the forwarding hop a general-purpose provider adds.
  sequencerRpc: "https://arb1-sequencer.arbitrum.io/rpc",
  sequencerFeedUrl: "wss://arb1.arbitrum.io/feed",
  svrSupported: true,
  routing: {
    weth: ARB_WETH,
    usdc: ARB_USDC,
    // The old candidate list guessed ONE fee per leg, which missed the deepest
    // pool whenever it was a different tier (a live probe quoted wstETH->USDC at
    // $2.6k of a $5k trade through [3000,500] while wstETH-[100]->WETH-[500]->USDC
    // returns ~$5k). Every tier pair per hub is cheap now that candidates go out
    // as batched eth_calls; 10000 is only worth quoting on direct pools.
    hubs: [
      { token: ARB_WETH,  fees: [100, 500, 3000] },
      { token: ARB_USDC,  fees: [100, 500] },
      { token: ARB_USDCE, fees: [100, 500] },
      { token: ARB_WBTC,  fees: [100, 500] },
    ],
    twoHub: [[ARB_WETH, ARB_USDC], [ARB_WETH, ARB_USDCE], [ARB_USDC, ARB_WETH]],
    twoHubTailFees: [100, 500],
    stables: [
      ARB_USDC, ARB_USDCE,
      "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", // USDT
      "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1", // DAI
      "0x93b346b6BC2548dA6A1E7d98E9a421B42541425b", // LUSD
      "0x17FC002b466eEc40DaE837Fc4bE5c67993ddBd6F", // FRAX
      "0x7dfF72693f6A4149b17e7C6314655f6A9F7c8B33", // GHO
      "0xD22a58f79e9481D1a88e00c343885A588b34b68B", // EURS
      "0x3F56e0c36d275367b8C502090EDF38289b3dEa0d", // MAI
    ].map(a => a.toLowerCase()),
    warmCollaterals: ["WETH", "wstETH", "WBTC", "weETH", "ARB", "LINK", "rETH", "tBTC", "AAVE", "USDC", "USDT", "DAI", "USDC.e"],
    warmDebts:       ["USDC", "USDT", "DAI", "WETH", "USDC.e", "WBTC", "GHO"],
  },
  reserves: {
    // ── Stablecoins ────────────────────────────────────────────────────────────
    USDC:     { symbol: "USDC",   address: ARB_USDC,  decimals: 6,  liquidationBonus: 10500, liquidationThreshold: 7800 },
    "USDC.e": { symbol: "USDC.e", address: ARB_USDCE, decimals: 6,  liquidationBonus: 10500, liquidationThreshold: 7800 },
    USDT: { symbol: "USDT", address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", decimals: 6,  liquidationBonus: 10500, liquidationThreshold: 7800 },
    DAI:  { symbol: "DAI",  address: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1", decimals: 18, liquidationBonus: 10500, liquidationThreshold: 7700 },
    // LUSD, GHO: LT 0 / usageAsCollateral false on-chain — borrowable, but they
    // contribute nothing to a borrower's collateral side.
    LUSD: { symbol: "LUSD", address: "0x93b346b6BC2548dA6A1E7d98E9a421B42541425b", decimals: 18, liquidationBonus: 10500, liquidationThreshold: 0 },
    FRAX: { symbol: "FRAX", address: "0x17FC002b466eEc40DaE837Fc4bE5c67993ddBd6F", decimals: 18, liquidationBonus: 10600, liquidationThreshold: 7200 },
    GHO:  { symbol: "GHO",  address: "0x7dfF72693f6A4149b17e7C6314655f6A9F7c8B33", decimals: 18, liquidationBonus: 10500, liquidationThreshold: 0 },
    // ── Major volatile assets ──────────────────────────────────────────────────
    WETH: { symbol: "WETH", address: ARB_WETH, decimals: 18, liquidationBonus: 10500, liquidationThreshold: 8400 },
    WBTC: { symbol: "WBTC", address: ARB_WBTC, decimals: 8,  liquidationBonus: 10700, liquidationThreshold: 7800 },
    // Threshold Bitcoin — onboarded Q1 2025 (ARFC 2025-02-27)
    tBTC: { symbol: "tBTC", address: "0x6c84a8f1c29108F47a79964b5Fe888D4f4D0dE40", decimals: 18, liquidationBonus: 10750, liquidationThreshold: 7800 },
    ARB:  { symbol: "ARB",  address: "0x912CE59144191C1204E64559FE8253a0e49E6548", decimals: 18, liquidationBonus: 11000, liquidationThreshold: 6300 },
    LINK: { symbol: "LINK", address: "0xf97f4df75117a78c1A5a0DBb814Af92458539FB4", decimals: 18, liquidationBonus: 11000, liquidationThreshold: 7500 },
    AAVE: { symbol: "AAVE", address: "0xba5DdD1f9d7F570dc94a51479a000E3BCE967196", decimals: 18, liquidationBonus: 11000, liquidationThreshold: 7300 },
    // GMX removed: its Aave oracle feed was deprecated and reverts, which failed
    // any batch that included it (Feb 2026).
    // ── Liquid staking tokens ──────────────────────────────────────────────────
    wstETH: { symbol: "wstETH", address: "0x5979D7b546E38E414F7E9822514be443A4800529", decimals: 18, liquidationBonus: 10720, liquidationThreshold: 7900 },
    rETH:   { symbol: "rETH",   address: "0xEC70Dcb4A1EFa46b8F2D97C310C9c4790ba5ffA8", decimals: 18, liquidationBonus: 10750, liquidationThreshold: 7400 },
    weETH:  { symbol: "weETH",  address: "0x35751007a407ca6FEFfE80b3cB397736D2cf4dbe", decimals: 18, liquidationBonus: 10750, liquidationThreshold: 7700 },
    // ezETH / rsETH: LT cut to 10 bps on-chain (being offboarded). Positions holding
    // them get almost no collateral credit, which is what the real HF does too.
    ezETH:  { symbol: "ezETH",  address: "0x2416092f143378750bb29b79eD961ab195CcEea5", decimals: 18, liquidationBonus: 10750, liquidationThreshold: 10 },
    rsETH:  { symbol: "rsETH",  address: "0x4186BFC76E2E237523CBC30FD220FE055156b41F", decimals: 18, liquidationBonus: 10750, liquidationThreshold: 10 },
    // EURS: frozen on-chain, but existing positions stay liquidatable.
    EURS:   { symbol: "EURS",   address: "0xD22a58f79e9481D1a88e00c343885A588b34b68B", decimals: 2,  liquidationBonus: 10750, liquidationThreshold: 6700 },
    // MAI: frozen and being wound down (LT 100 bps), but existing MAI DEBT is still
    // liquidatable. Its feed reverted in Feb 2026 and prices again (checked Oct
    // 2026). The oracle reads each asset in isolation, so if it dies again only MAI
    // is blacklisted, not the whole batch.
    MAI:    { symbol: "MAI",    address: "0x3F56e0c36d275367b8C502090EDF38289b3dEa0d", decimals: 18, liquidationBonus: 10500, liquidationThreshold: 100 },
    // USDe was removed — its feed reverts (deprecated). Reserves listed after this
    // table was written need no edit: ReserveRegistry registers them at startup.
  },
};

// ─── Base ────────────────────────────────────────────────────────────────────
// Addresses: bgd-labs/aave-address-book (AaveV3Base), re-verified on-chain
// (Pool revision 11, flashloan premium 5 bps, 15 reserves, no price-oracle
// sentinel). Uniswap V3 deployment: https://docs.uniswap.org (Base).
const BASE_WETH  = "0x4200000000000000000000000000000000000006";
const BASE_USDC  = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const BASE_CBBTC = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf";

const BASE: ChainProfile = {
  key: "base",
  name: "Base",
  chainId: 8453,
  nativeSymbol: "ETH",
  explorer: "https://basescan.org",
  stateSuffix: ".base",
  aave: {
    pool:               "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
    dataProvider:       "0x0F43731EB8d45A581f4a36DD74F5f358bc90C73A",
    oracle:             "0x2Cc0Fc26eD4563A5ce5e8bdcfe1A2878676Ae156",
    addressesProvider:  "0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D",
    uiPoolDataProvider: "0x0C6BC4a12039788be08F87e87Cff87FEDbd1D386",
    deployBlock:        2_357_134n,     // first block with code at the Pool (binary-searched on an archive node)
    // The Graph deployment of the Aave V3 Base subgraph. NOT verified against a
    // live API key; if it is wrong the schema probe fails and the bot falls back
    // to the on-chain Borrow scan. Override with AAVE_SUBGRAPH_ID.
    subgraphId:         "GQFbb95cE6d8mV989mL5figjaGaKCQB3xqYrr1bRyXqF",
  },
  uniswap: {
    router: "0x2626664c2603336E57B271c5C0b26F421741e481",   // SwapRouter02
    quoter: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",   // QuoterV2
  },
  multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11",
  blockTimeMs: 2000,
  scanChunk: 10_000n,
  // Fjord GasPriceOracle: fee scales linearly with the unsigned transaction size.
  // overheadBytes covers the signature/nonce/gas fields the calldata estimate omits.
  l1Fee: { kind: "op-stack", overheadBytes: 110 },
  blockNumberSource: "multicall",
  // Base's sequencer orders by priority fee, so unlike Arbitrum a tip buys position.
  // Base fee is ~0.005 gwei, so even 0.05 gwei is a few cents on a liquidation.
  gas: { maxGasWei: 2_000_000_000n, tipGwei: 0.05, ordering: "priority-fee" },
  sequencerRpc: "https://mainnet-sequencer.base.org",
  sequencerFeedUrl: "",
  svrSupported: false,
  routing: {
    weth: BASE_WETH,
    usdc: BASE_USDC,
    // Probed against the live QuoterV2: WETH/USDC is deepest at 500, cbBTC pairs at
    // 500/3000, the LSTs at 100 against WETH, GHO and cbETH only at 3000 against
    // USDC. The LSTs are thin above ~$50k, which only matters for large positions.
    hubs: [
      { token: BASE_WETH,  fees: [100, 500, 3000] },
      { token: BASE_USDC,  fees: [100, 500, 3000] },
      { token: BASE_CBBTC, fees: [500, 3000] },
    ],
    twoHub: [[BASE_WETH, BASE_USDC], [BASE_USDC, BASE_WETH], [BASE_CBBTC, BASE_WETH]],
    twoHubTailFees: [100, 500, 3000],
    stables: [
      BASE_USDC,
      "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA", // USDbC
      "0x6Bb7a212910682DCFdbd5BCBb3e28FB4E8da10Ee", // GHO
      "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42", // EURC
      "0x660975730059246A68521a3e2FBD4740173100f5", // syrupUSDC
    ].map(a => a.toLowerCase()),
    warmCollaterals: ["WETH", "cbBTC", "cbETH", "wstETH", "weETH", "USDC", "AAVE", "EURC", "LBTC"],
    warmDebts:       ["USDC", "WETH", "cbBTC", "EURC", "GHO"],
  },
  reserves: {
    WETH:   { symbol: "WETH",   address: BASE_WETH,  decimals: 18, liquidationBonus: 10500, liquidationThreshold: 8300 },
    USDC:   { symbol: "USDC",   address: BASE_USDC,  decimals: 6,  liquidationBonus: 10500, liquidationThreshold: 7800 },
    cbBTC:  { symbol: "cbBTC",  address: BASE_CBBTC, decimals: 8,  liquidationBonus: 10750, liquidationThreshold: 7800 },
    cbETH:  { symbol: "cbETH",  address: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22", decimals: 18, liquidationBonus: 10750, liquidationThreshold: 7900 },
    wstETH: { symbol: "wstETH", address: "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452", decimals: 18, liquidationBonus: 10600, liquidationThreshold: 7900 },
    weETH:  { symbol: "weETH",  address: "0x04C0599Ae5A44757c0af6F9eC3b93da8976c150A", decimals: 18, liquidationBonus: 10750, liquidationThreshold: 7700 },
    // Frozen on-chain; existing positions stay liquidatable.
    USDbC:  { symbol: "USDbC",  address: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA", decimals: 6,  liquidationBonus: 10500, liquidationThreshold: 7800 },
    EURC:   { symbol: "EURC",   address: "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42", decimals: 6,  liquidationBonus: 10500, liquidationThreshold: 7800 },
    LBTC:   { symbol: "LBTC",   address: "0xecAc9C5F704e954931349Da37F60E39f515c11c1", decimals: 8,  liquidationBonus: 10850, liquidationThreshold: 7300 },
    AAVE:   { symbol: "AAVE",   address: "0x63706e401c06ac8513145b7687A14804d17f814b", decimals: 18, liquidationBonus: 11000, liquidationThreshold: 6500 },
    tBTC:   { symbol: "tBTC",   address: "0x236aa50979D5f3De3Bd1Eeb40E81137F22ab794b", decimals: 18, liquidationBonus: 10750, liquidationThreshold: 7800 },
    // ezETH / wrsETH: frozen, LT 10 bps — being offboarded.
    ezETH:  { symbol: "ezETH",  address: "0x2416092f143378750bb29b79eD961ab195CcEea5", decimals: 18, liquidationBonus: 10750, liquidationThreshold: 10 },
    wrsETH: { symbol: "wrsETH", address: "0xEDfa23602D0EC14714057867A78d01e94176BEA0", decimals: 18, liquidationBonus: 10750, liquidationThreshold: 10 },
    // Borrow-only (LT 0 on-chain): contribute nothing to a borrower's collateral.
    GHO:       { symbol: "GHO",       address: "0x6Bb7a212910682DCFdbd5BCBb3e28FB4E8da10Ee", decimals: 18, liquidationBonus: 10500, liquidationThreshold: 0 },
    syrupUSDC: { symbol: "syrupUSDC", address: "0x660975730059246A68521a3e2FBD4740173100f5", decimals: 6,  liquidationBonus: 10500, liquidationThreshold: 0 },
  },
};

const PROFILES: Record<ChainKey, ChainProfile> = { arbitrum: ARBITRUM, base: BASE };

export function selectChain(raw: string | undefined): ChainProfile {
  const key = (raw ?? "arbitrum").trim().toLowerCase();
  const p = (PROFILES as Record<string, ChainProfile | undefined>)[key];
  if (!p) throw new Error(`Unknown CHAIN="${raw}" — supported: ${Object.keys(PROFILES).join(", ")}`);
  return p;
}

export const PROFILE: ChainProfile = selectChain(process.env.CHAIN);
export const ALL_PROFILES = PROFILES;
