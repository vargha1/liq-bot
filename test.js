/**
 * verify_path.js
 * Calls QuoterV2.quoteExactInput on Arbitrum for all WETH→EURS path candidates.
 * Run with: node verify_path.js
 * Requires: npm install ethers   (v6)
 */

const { ethers } = require('ethers');

// ── Addresses ────────────────────────────────────────────────────────────────
const WETH   = '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1';
const USDC_E = '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8'; // USDC.e (bridged)
const USDC_N = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'; // native USDC
const EURS   = '0xD22a58f79e9481D1a88e00c343885A588b34b68B';

const QUOTER_V2 = '0x61fFE014bA17989E743c5F6cB21bF9697530B21e';

// ── From bot log ──────────────────────────────────────────────────────────────
const AMOUNT_IN     = 762345632705161069n;  // WETH in (18 dec)
const REPAY_NEEDED  = 97980n;               // raw EURS (2 dec): debtToCover + 0.05% premium

// ── QuoterV2 ABI (only what we need) ─────────────────────────────────────────
const QUOTER_ABI = [
  'function quoteExactInput(bytes path, uint256 amountIn) external returns (uint256 amountOut, uint160[] sqrtPriceX96After, uint32[] initializedTicksCrossed, uint256 gasEstimate)'
];

// ── Path encoding ─────────────────────────────────────────────────────────────
function encodePath(tokens, fees) {
  let packed = tokens[0].slice(2).toLowerCase();
  for (let i = 0; i < fees.length; i++) {
    packed += fees[i].toString(16).padStart(6, '0');
    packed += tokens[i + 1].slice(2).toLowerCase();
  }
  return '0x' + packed;
}

// ── Candidates ────────────────────────────────────────────────────────────────
const PATHS = [
  { label: 'WETH -[500]→ USDC.e -[500]→ EURS',  path: encodePath([WETH, USDC_E, EURS], [500,  500]) },
  { label: 'WETH -[500]→ USDC.e -[100]→ EURS',  path: encodePath([WETH, USDC_E, EURS], [500,  100]) },
  { label: 'WETH -[500]→ nUSDC  -[500]→ EURS',  path: encodePath([WETH, USDC_N, EURS], [500,  500]) },
  { label: 'WETH -[500]→ nUSDC  -[100]→ EURS',  path: encodePath([WETH, USDC_N, EURS], [500,  100]) },
  { label: 'WETH -[3000]→ USDC.e -[500]→ EURS', path: encodePath([WETH, USDC_E, EURS], [3000, 500]) },
  { label: 'WETH -[3000]→ nUSDC  -[500]→ EURS', path: encodePath([WETH, USDC_N, EURS], [3000, 500]) },
];

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  // swap your RPC URL below if needed
  const provider = new ethers.JsonRpcProvider(
    process.env.ARB_RPC || 'https://arb1.arbitrum.io/rpc'
  );
  const quoter = new ethers.Contract(QUOTER_V2, QUOTER_ABI, provider);

  console.log(`\namountIn:     ${AMOUNT_IN} wei WETH (${ethers.formatEther(AMOUNT_IN)} WETH)`);
  console.log(`repayNeeded:  ${REPAY_NEEDED} raw EURS (€${(Number(REPAY_NEEDED)/100).toFixed(2)})\n`);
  console.log('─'.repeat(72));

  let bestPath = null;
  let bestOut  = 0n;

  for (const { label, path } of PATHS) {
    try {
      const result = await quoter.quoteExactInput.staticCall(path, AMOUNT_IN);
      const amountOut = result[0]; // uint256
      const eurs = Number(amountOut) / 100;
      const profitable = amountOut >= REPAY_NEEDED;
      const profit = profitable ? `profit ~€${((Number(amountOut - REPAY_NEEDED))/100).toFixed(2)}` : `SHORT by €${((Number(REPAY_NEEDED - amountOut))/100).toFixed(2)}`;
      console.log(`${profitable ? '✅' : '❌'} ${label}`);
      console.log(`   out=${amountOut} raw (€${eurs.toFixed(2)})  ${profit}`);
      console.log(`   path: ${path}\n`);
      if (profitable && amountOut > bestOut) {
        bestOut  = amountOut;
        bestPath = { label, path, amountOut };
      }
    } catch (e) {
      console.log(`❌ ${label}`);
      console.log(`   REVERTED — likely no pool / no liquidity`);
      console.log(`   path: ${path}\n`);
    }
  }

  console.log('─'.repeat(72));
  if (bestPath) {
    console.log(`\n🏆 Best path: ${bestPath.label}`);
    console.log(`   amountOut = ${bestPath.amountOut} raw`);
    console.log(`\n── liquidate() call args ────────────────────────────────────────────`);
    console.log(`collateralAsset : "${WETH}"`);
    console.log(`debtAsset       : "${EURS}"`);
    console.log(`borrower        : "<FULL_ADDRESS>"`);
    console.log(`debtToCover     : 97931n`);
    console.log(`swapPath        : "${bestPath.path}"`);
    console.log(`amountOutMinimum: ${REPAY_NEEDED}n  // covers flashloan repayment`);
    console.log(`deadline        : BigInt(Math.floor(Date.now()/1000) + 120)`);
  } else {
    console.log('\n⚠️  No profitable path found. EURS liquidity may be too thin right now.');
    console.log('   Consider waiting for liquidity or try a 3-hop path via WETH→USDC→USDT→EURS.');
  }
}

main().catch(console.error);
