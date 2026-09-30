// svrSimulate.ts — runs AaveSvrSolver's whole solver flow against LIVE Arbitrum
// state with nothing deployed and nothing sent (eth_call with state overrides).
//
//   npx tsx src/svrSimulate.ts [borrower]
//
// What is faked, and why:
//   * the contract: its runtime code is obtained by executing the creation code in
//     an eth_call, then injected at a throwaway address (immutables included);
//   * the WETH/USD price source: replaced by a stub returning a crashed price, so a
//     healthy borrower becomes liquidatable, which is what an SVR update does;
//   * Atlas: replaced by a stub returning zeros, so shortfall()/reconcile() work
//     outside a real metacall.
// What is real: Aave (flashloan, liquidationCall), Uniswap V3 pools, WETH, the
// borrower's actual positions, and every line of the solver contract.
//
// Scenarios checked: a liquidation that pays its bid, a bid the profit cannot
// cover (must revert), a wrong signer, a caller that is not Atlas, and a bundle
// where one item is not liquidatable (must be skipped, not fatal).

import * as fs from "fs";
import * as path from "path";
import { ethers } from "ethers";
import { ATLAS, encodeSolverItems, type SolverItem } from "./svrAtlas";

const RPCS = [process.env.SIM_RPC, "https://arbitrum.drpc.org"].filter(Boolean) as string[];
const ROUTER = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45";
const POOL   = "0x794a61358D6845594F94dc1DB02A252b5b4814aD";
const ORACLE = "0xb56c2F0B653B2e0b10C9b928C8580Ac5Df02C7C7";
const WETH   = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";
const USDC   = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const WETH_PROXY = "0xbD41b1548a5A06544cBcf87c0c54864312842C00";
const SOLVER = "0x00000000000000000000000000000000000050a1";   // throwaway
const OWNER  = "0x00000000000000000000000000000000000000b0";   // plays the bonded searcher
const EE     = "0x000000000000000000000000000000000000dEaD";   // plays the execution environment

const ARTIFACT = path.resolve(__dirname, "..", "artifacts", "AaveSvrSolver.json");
const borrower = process.argv[2] ?? "0x9C40B75a3A180C1cc39fe68563E90ca7541619Af";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
}

// A contract whose every call returns the same 32-byte word: PUSH32 w, PUSH1 0,
// MSTORE, PUSH1 32, PUSH1 0, RETURN.
const constWord = (w: bigint) => "0x7f" + w.toString(16).padStart(64, "0") + "6000526020" + "6000" + "f3";
// Returns 64 zero bytes for any call — enough for shortfall() and reconcile().
const ZEROS = "0x60406000f3";

async function rpc(method: string, params: unknown[]): Promise<any> {
  let lastErr = "";
  for (const url of RPCS) {
    const r: any = await fetch(url, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }).then(x => x.json()).catch(e => ({ error: { message: String(e) } }));
    if (!r.error) return r.result;
    lastErr = r.error.data ?? r.error.message;
    if (!/override|not supported/i.test(String(r.error.message))) break;
  }
  throw new Error(typeof lastErr === "string" ? lastErr : JSON.stringify(lastErr));
}

async function runtimeCode(): Promise<string> {
  if (!fs.existsSync(ARTIFACT)) throw new Error("artifacts/AaveSvrSolver.json missing - run: npm run svr -- compile");
  const a = JSON.parse(fs.readFileSync(ARTIFACT, "utf8"));
  const args = ethers.AbiCoder.defaultAbiCoder().encode(["address", "address"], [ROUTER, ATLAS]);
  // No `to`: the node executes the creation code and returns the runtime code.
  return rpc("eth_call", [{ from: OWNER, data: a.bytecode + args.slice(2) }, "latest"]);
}

// Node errors arrive as raw revert data; turn Error(string) into its message.
function decodeRevert(raw: string): string {
  const m = raw.match(/0x08c379a0[0-9a-fA-F]+/);
  if (!m) return raw;
  try { return ethers.AbiCoder.defaultAbiCoder().decode(["string"], "0x" + m[0].slice(10))[0]; } catch { return raw; }
}

const iface = new ethers.Interface([
  "function atlasSolverCall(address solverOpFrom,address executionEnvironment,address bidToken,uint256 bidAmount,bytes solverOpData,bytes forwardedData) payable",
]);

function pathOf(a: string, fee: number, b: string): string {
  return ethers.solidityPacked(["address", "uint24", "address"], [a, fee, b]);
}

async function main(): Promise<void> {
  const code = await runtimeCode();
  check("runtime code obtained from creation code", code.length > 1000, `(${(code.length - 2) / 2} bytes)`);

  const priceNow = BigInt(await rpc("eth_call", [{ to: ORACLE, data: ethers.id("getAssetPrice(address)").slice(0, 10) + ethers.zeroPadValue(WETH, 32).slice(2) }, "latest"]));
  // Crash ETH by 55%: enough to put any WETH-backed borrower well under 1.0.
  const crashed = (priceNow * 45n) / 100n;
  console.log(`WETH price: $${Number(priceNow) / 1e8} -> simulated $${Number(crashed) / 1e8}`);

  const overrides = {
    [SOLVER]:     { code },
    [WETH_PROXY]: { code: constWord(crashed) },
    [ATLAS]:      { code: ZEROS },
  };

  const item: SolverItem = {
    collateralAsset: WETH, debtAsset: USDC, borrower,
    debtToCover: 3_000_000_000n,                       // 3,000 USDC
    swapPath: pathOf(WETH, 500, USDC),
    amountOutMinimum: 3_001_500_000n,                  // repayment incl. 5 bps premium
    profitPath: pathOf(USDC, 500, WETH),
  };

  const call = async (from: string, signer: string, bid: bigint, items: SolverItem[]) => {
    const data = iface.encodeFunctionData("atlasSolverCall", [signer, EE, ethers.ZeroAddress, bid, encodeSolverItems(items), "0x"]);
    return rpc("eth_call", [{ from, to: SOLVER, data, gas: "0x" + (8_000_000).toString(16) }, "latest", overrides]);
  };
  const estimate = async (bid: bigint, items: SolverItem[]) => {
    const data = iface.encodeFunctionData("atlasSolverCall", [OWNER, EE, ethers.ZeroAddress, bid, encodeSolverItems(items), "0x"]);
    return BigInt(await rpc("eth_estimateGas", [{ from: ATLAS, to: SOLVER, data }, "latest", overrides]));
  };
  const reverts = async (fn: () => Promise<unknown>): Promise<string | null> => {
    try { await fn(); return null; } catch (e: any) { return decodeRevert(String(e?.message ?? e)); }
  };

  // HF of the borrower under the crashed price, to choose a crash that works.
  {
    const d = ethers.id("getUserAccountData(address)").slice(0, 10) + ethers.zeroPadValue(borrower, 32).slice(2);
    const r: string = await rpc("eth_call", [{ to: POOL, data: d }, "latest", overrides]);
    const w = ethers.AbiCoder.defaultAbiCoder().decode(["uint256","uint256","uint256","uint256","uint256","uint256"], r);
    console.log(`borrower under simulated price: collateral ${Number(w[0]) / 1e8}, debt ${Number(w[1]) / 1e8}, HF ${Number(w[5]) / 1e18}`);
  }

  // 0. Run one item directly (from the contract itself) to surface its own revert.
  if (process.env.SIM_DEBUG) {
    const runItem = new ethers.Interface(["function runItem((address collateralAsset,address debtAsset,address borrower,uint256 debtToCover,bytes swapPath,uint256 amountOutMinimum,bytes profitPath) it)"]);
    const d = runItem.encodeFunctionData("runItem", [item]);
    const r = await reverts(() => rpc("eth_call", [{ from: SOLVER, to: SOLVER, data: d, gas: "0x" + (8_000_000).toString(16) }, "latest", overrides]));
    console.log("runItem directly ->", r === null ? "ok" : r);
  }

  // 1. The happy path.
  const ok = await reverts(() => call(ATLAS, OWNER, ethers.parseEther("0.05"), [item]));
  check("liquidation runs end to end and pays a 0.05 ETH bid", ok === null, ok ? `(${ok.slice(0, 160)})` : "");
  if (ok === null) {
    const gas = await estimate(ethers.parseEther("0.05"), [item]).catch(() => 0n);
    console.log(`      gas for one item (incl. profit swap): ${gas}`);
  }

  // 2. A bid the profit cannot cover must revert, not underpay.
  const big = await reverts(() => call(ATLAS, OWNER, ethers.parseEther("500"), [item]));
  check("a bid larger than the profit reverts", big !== null && /Profit below bid|revert/i.test(big), big ? `(${big.slice(0, 90)})` : "");

  // 3. Access control.
  const notAtlas = await reverts(() => call(OWNER, OWNER, ethers.parseEther("0.01"), [item]));
  check("caller other than Atlas is refused", notAtlas !== null && /Only Atlas/i.test(notAtlas), notAtlas ? `(${notAtlas.slice(0, 60)})` : "");
  const badSigner = await reverts(() => call(ATLAS, "0x00000000000000000000000000000000000000c1", ethers.parseEther("0.01"), [item]));
  check("operation signed by anyone but the owner is refused", badSigner !== null && /Bad signer/i.test(badSigner), badSigner ? `(${badSigner.slice(0, 60)})` : "");

  // 4. A bundle with one bad item: the good one must still go through.
  const dead: SolverItem = { ...item, borrower: "0x000000000000000000000000000000000000dEaD" };
  const mixed = await reverts(() => call(ATLAS, OWNER, ethers.parseEther("0.05"), [dead, item]));
  check("a non-liquidatable item is skipped without failing the bundle", mixed === null, mixed ? `(${mixed.slice(0, 160)})` : "");
  const onlyDead = await reverts(() => call(ATLAS, OWNER, ethers.parseEther("0.001"), [dead]));
  check("a bundle where nothing liquidates reverts", onlyDead !== null && /Nothing liquidated/i.test(onlyDead), onlyDead ? `(${onlyDead.slice(0, 60)})` : "");

  console.log(failed === 0 ? "\nAll simulations behaved correctly." : `\n${failed} simulation(s) FAILED.`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => { console.error(e?.message ?? e); process.exit(1); });
