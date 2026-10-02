// simulateLiquidation.ts — runs AaveLiquidator's whole flow against LIVE chain state
// with nothing deployed and nothing sent (eth_call with state overrides).
//
//   CHAIN=base npx tsx src/simulateLiquidation.ts [borrower]
//
// What is faked:
//   * the contract: its runtime code is obtained by executing the creation code in an
//     eth_call, then injected at a throwaway address (constructor args and
//     immutables included, so the CHAIN's Pool and router are what get exercised);
//   * the collateral price source: replaced by a stub returning a crashed price, so a
//     healthy borrower becomes liquidatable.
// What is real: Aave (flashloan, liquidationCall, health factor), the Uniswap V3 pools
// the route goes through, the borrower's actual positions, and every line of the
// contract.
//
// Without a borrower argument it looks for one with WETH collateral and USDC debt in
// the most recent Borrow events.
//
// Scenarios: the liquidation succeeds; the swap output (hence real profit) is found
// by bisecting amountOutMinimum; a floor above the output reverts; a non-owner and an
// expired deadline are refused.
import * as fs from "fs";
import * as path from "path";
import { ethers } from "ethers";
import { PROFILE } from "./chains";

const RPCS = [process.env.SIM_RPC, process.env.RPC_URL, ...(PROFILE.key === "base"
  ? ["https://base.drpc.org", "https://base-rpc.publicnode.com"]
  : ["https://arbitrum.drpc.org", "https://arbitrum-one-rpc.publicnode.com"])].filter(Boolean) as string[];

const CONTRACT = "0x00000000000000000000000000000000000050a1";   // throwaway address
const OWNER    = "0x00000000000000000000000000000000000000b0";   // plays the bot wallet
const ARTIFACT = path.resolve(__dirname, "..", "artifacts", `AaveLiquidator.${PROFILE.key}.json`);

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
}

// A contract whose every call returns the same 32-byte word.
const constWord = (w: bigint) => "0x7f" + w.toString(16).padStart(64, "0") + "6000526020" + "6000" + "f3";

let rpcUrl = "";
async function rpc(method: string, params: unknown[]): Promise<any> {
  let lastErr = "";
  for (const url of RPCS) {
    const r: any = await fetch(url, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }).then(x => x.json()).catch(e => ({ error: { message: String(e) } }));
    if (!r.error) { rpcUrl = url; return r.result; }
    lastErr = r.error.data ?? r.error.message;
    if (!/override|not supported|403|forbidden|rate|limit|range/i.test(String(r.error.message))) break;
  }
  throw new Error(typeof lastErr === "string" ? lastErr : JSON.stringify(lastErr));
}

function decodeRevert(raw: string): string {
  const m = raw.match(/0x08c379a0[0-9a-fA-F]+/);
  if (!m) return raw;
  try { return ethers.AbiCoder.defaultAbiCoder().decode(["string"], "0x" + m[0].slice(10))[0]; } catch { return raw; }
}

const abi = ethers.AbiCoder.defaultAbiCoder();
const sel = (sig: string) => ethers.id(sig).slice(0, 10);
const addr32 = (a: string) => ethers.zeroPadValue(a, 32).slice(2);

async function ethCall(to: string, data: string, overrides?: object): Promise<string> {
  return rpc("eth_call", overrides ? [{ to, data }, "latest", overrides] : [{ to, data }, "latest"]);
}

async function runtimeCode(): Promise<string> {
  if (!fs.existsSync(ARTIFACT)) throw new Error(`${path.relative(process.cwd(), ARTIFACT)} missing - run: CHAIN=${PROFILE.key} npm run deploy-liquidator`);
  const a = JSON.parse(fs.readFileSync(ARTIFACT, "utf8"));
  const args = abi.encode(["address", "address"], [PROFILE.uniswap.router, PROFILE.aave.pool]);
  // No `to`: the node executes the creation code and returns the runtime code.
  return rpc("eth_call", [{ from: OWNER, data: a.bytecode + args.slice(2) }, "latest"]);
}

const weth = PROFILE.routing.weth;
const usdc = PROFILE.routing.usdc;

// A borrower with WETH collateral and USDC variable debt, from recent Borrow events.
async function findBorrower(): Promise<string> {
  const head = Number(BigInt(await rpc("eth_blockNumber", [])));
  const topic = ethers.id("Borrow(address,address,address,uint256,uint8,uint256,uint16)");
  const reserveTopic = "0x" + addr32(usdc);
  const seen = new Set<string>();
  for (let to = head, tries = 0; tries < 40 && seen.size < 60; to -= 1500, tries++) {
    let logs: any[] = [];
    try { logs = await rpc("eth_getLogs", [{ address: PROFILE.aave.pool, topics: [topic, reserveTopic], fromBlock: "0x" + (to - 1499).toString(16), toBlock: "0x" + to.toString(16) }]); }
    catch { continue; }
    for (const l of logs) seen.add("0x" + String(l.topics[2]).slice(26));
  }
  for (const b of seen) {
    const dp = PROFILE.aave.dataProvider;
    const g = (asset: string) => ethCall(dp, sel("getUserReserveData(address,address)") + addr32(asset) + addr32(b));
    const [w, u] = await Promise.all([g(weth), g(usdc)]);
    const wd = abi.decode(["uint256","uint256","uint256","uint256","uint256","uint256","uint256","uint40","bool"], w);
    const ud = abi.decode(["uint256","uint256","uint256","uint256","uint256","uint256","uint256","uint40","bool"], u);
    // collateral enabled in WETH worth > 0.5 WETH, USDC debt > $500
    if (wd[8] && wd[0] > 5n * 10n ** 17n && ud[2] > 500_000_000n) return ethers.getAddress(b);
  }
  throw new Error("no suitable borrower found in recent Borrow events - pass one as an argument");
}

async function main(): Promise<void> {
  const borrower = process.argv[2] ?? await findBorrower();
  console.log(`Chain ${PROFILE.name} | borrower ${borrower} | rpc ${rpcUrl.split("/")[2]}`);

  const code = await runtimeCode();
  check("runtime code obtained from creation code", code.length > 1000, `(${(code.length - 2) / 2} bytes)`);

  const oracle = PROFILE.aave.oracle;
  const priceNow = BigInt(await ethCall(oracle, sel("getAssetPrice(address)") + addr32(weth)));
  const source = abi.decode(["address"], await ethCall(oracle, sel("getSourceOfAsset(address)") + addr32(weth)))[0] as string;
  // Crash WETH by 40%: enough to push a typical WETH-backed borrower under 1.0.
  const crashed = (priceNow * 60n) / 100n;
  console.log(`WETH price: $${Number(priceNow) / 1e8} -> simulated $${Number(crashed) / 1e8} (source ${source})`);

  const overrides = { [CONTRACT]: { code }, [source]: { code: constWord(crashed) } };

  const acct = abi.decode(["uint256","uint256","uint256","uint256","uint256","uint256"],
    await ethCall(PROFILE.aave.pool, sel("getUserAccountData(address)") + addr32(borrower), overrides));
  const hf = Number(acct[5]) / 1e18;
  console.log(`borrower under simulated price: collateral $${Number(acct[0]) / 1e8}, debt $${Number(acct[1]) / 1e8}, HF ${hf.toFixed(4)}`);
  check("borrower is liquidatable under the simulated price", hf < 1, `(HF ${hf.toFixed(4)})`);

  // Repay a modest slice of the USDC debt so the pool route stays shallow.
  const debtToCover = 300_000_000n;   // 300 USDC
  const swapPath = ethers.solidityPacked(["address", "uint24", "address"], [weth, 500, usdc]);
  const iface = new ethers.Interface(["function liquidate(address,address,address,uint256,bytes,uint256,uint256)"]);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const call = (from: string, minOut: bigint, dl = deadline) => rpc("eth_call", [{
    from, to: CONTRACT, gas: "0x" + (8_000_000).toString(16),
    data: iface.encodeFunctionData("liquidate", [weth, usdc, borrower, debtToCover, swapPath, minOut, dl]),
  }, "latest", overrides]);
  const reverts = async (fn: () => Promise<unknown>): Promise<string | null> => {
    try { await fn(); return null; } catch (e: any) { return decodeRevert(String(e?.message ?? e)); }
  };

  const repay = debtToCover + (debtToCover * 5n) / 10_000n;   // incl. 5 bps premium
  const ok = await reverts(() => call(OWNER, repay));
  check("liquidation runs end to end (flashloan -> liquidationCall -> swap -> repay)", ok === null, ok ? `(${ok.slice(0, 200)})` : "");

  if (ok === null) {
    // Bisect the largest floor that still passes: that is the real swap output.
    let lo = repay, hi = repay * 2n;
    for (let i = 0; i < 28 && hi - lo > 1n; i++) {
      const mid = (lo + hi) / 2n;
      (await reverts(() => call(OWNER, mid))) === null ? (lo = mid) : (hi = mid);
    }
    const profit = Number(lo - repay) / 1e6;
    console.log(`      swap output ${Number(lo) / 1e6} USDC for ${Number(debtToCover) / 1e6} repaid -> profit ${profit.toFixed(4)} USDC (bonus - fees - impact)`);
    check("the profit is positive", lo > repay);
    const gas = BigInt(await rpc("eth_estimateGas", [{
      from: OWNER, to: CONTRACT,
      data: iface.encodeFunctionData("liquidate", [weth, usdc, borrower, debtToCover, swapPath, repay, deadline]),
    }, "latest", overrides]).catch(() => "0x0"));
    console.log(`      gas used: ${gas}  (evaluator assumes ${550_000 + 150_000} for a one-hop swap)`);
    check("gas stays inside the evaluator's estimate", gas > 0n && gas <= 700_000n * 13n / 10n, `(${gas})`);

    const tooHigh = await reverts(() => call(OWNER, lo + lo / 20n));
    check("a swap floor above the real output reverts", tooHigh !== null, tooHigh ? `(${tooHigh.slice(0, 60)})` : "");
  }

  const nonOwner = await reverts(() => call("0x00000000000000000000000000000000000000c1", repay));
  check("a caller other than the owner is refused", nonOwner !== null && /Not owner/i.test(nonOwner), nonOwner ? `(${nonOwner.slice(0, 60)})` : "");
  const expired = await reverts(() => call(OWNER, repay, 1n));
  check("an expired deadline is refused", expired !== null && /expired/i.test(expired), expired ? `(${expired.slice(0, 60)})` : "");

  console.log(failed === 0 ? "\nAll simulations behaved correctly." : `\n${failed} simulation(s) FAILED.`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => { console.error(e?.message ?? e); process.exit(1); });
