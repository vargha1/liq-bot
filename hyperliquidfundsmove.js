// hyperliquidfundsmove.js
/**
 * Hyperliquid: Move USDC from Spot → HyperEVM
 *
 * Unified accounts don't need usdClassTransfer — spot and perp share one balance.
 * Just spotSend directly to the USDC system address to bridge to HyperEVM.
 */

import { ethers } from "ethers";
import * as dotenv from "dotenv";
dotenv.config();

function req(k) { const v = process.env[k]; if (!v) throw new Error(`Missing env var: ${k}`); return v; }

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const PRIVATE_KEY = req("PRIVATE_KEY");
const AMOUNT_USDC = "8.45076";
// ─────────────────────────────────────────────────────────────────────────────

const USDC_SYSTEM_ADDRESS = "0x2000000000000000000000000000000000000000";
const USDC_TOKEN = "USDC:0x6d1e7cde53ba9467b783cb7c530ce054";
const HL_API = "https://api.hyperliquid.xyz/exchange";

const DOMAIN = {
  name: "HyperliquidSignTransaction",
  version: "1",
  chainId: 42161,
  verifyingContract: "0x0000000000000000000000000000000000000000",
};

async function sendSpotSend(wallet, destination, token, amount) {
  const timestamp = Date.now();

  const types = {
    "HyperliquidTransaction:SpotSend": [
      { name: "hyperliquidChain", type: "string" },
      { name: "destination",      type: "string" },
      { name: "token",            type: "string" },
      { name: "amount",           type: "string" },
      { name: "time",             type: "uint64" },
    ],
  };
  const value = {
    hyperliquidChain: "Mainnet",
    destination,
    token,
    amount,
    time: timestamp,
  };

  const signature = await wallet.signTypedData(DOMAIN, types, value);
  const { r, s, v } = ethers.Signature.from(signature);

  const payload = {
    action: {
      type:              "spotSend",
      hyperliquidChain:  "Mainnet",
      signatureChainId:  "0xa4b1",
      destination,
      token,
      amount,
      time:              timestamp,
    },
    nonce:        timestamp,
    signature:    { r, s, v },
    vaultAddress: null,
  };

  const res = await fetch(HL_API, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(payload),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

async function checkBalances(address) {
  const spotRes = await fetch("https://api.hyperliquid.xyz/info", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ type: "spotClearinghouseState", user: address }),
  });
  const spotData = await spotRes.json();
  const usdcSpot = spotData?.balances?.find(b => b.coin === "USDC");
  console.log(`Spot USDC balance: ${usdcSpot?.total ?? "0"}`);
  return usdcSpot?.total ?? "0";
}

async function main() {
  const wallet = new ethers.Wallet(PRIVATE_KEY);
  console.log(`\nWallet: ${wallet.address}`);
  console.log(`Amount: ${AMOUNT_USDC} USDC\n`);

  console.log("── Checking balances ──────────────────────────────────────────");
  const spotBalance = await checkBalances(wallet.address);

  if (parseFloat(spotBalance) < parseFloat(AMOUNT_USDC)) {
    console.error(`❌ Insufficient spot balance (${spotBalance} < ${AMOUNT_USDC}). Aborting.`);
    process.exit(1);
  }

  console.log("\n── Spot → HyperEVM (spotSend to system address) ───────────────");
  console.log(`   Destination: ${USDC_SYSTEM_ADDRESS} (USDC system address)`);
  console.log(`   Your HyperEVM wallet will receive USDC at: ${wallet.address}`);

  const bridgeResult = await sendSpotSend(wallet, USDC_SYSTEM_ADDRESS, USDC_TOKEN, AMOUNT_USDC);
  console.log("Result:", JSON.stringify(bridgeResult, null, 2));

  if (bridgeResult?.status !== "ok") {
    console.error("❌ Spot → HyperEVM bridge failed.");
    process.exit(1);
  }

  console.log(`\n✅ Done! ${AMOUNT_USDC} USDC should appear on HyperEVM at:`);
  console.log(`   ${wallet.address}`);
  console.log(`\n   Verify: https://explorer.hyperlend.finance/address/${wallet.address}`);
  console.log(`   Native USDC on HyperEVM: 0xb88339CB7199b77E23DB6E890353E22632Ba630f`);
}

main().catch(err => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
