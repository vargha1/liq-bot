// svrTool.ts — command-line helper for the SVR integration.
//
//   npm run svr -- listen [seconds]   watch live auctions (free, needs no keys)
//   npm run svr -- compile            build the solver contract into artifacts/
//   npm run svr -- status             wallet, bond and solver state (read-only)
//   npm run svr -- deploy  --yes      deploy AaveSvrSolver        (spends gas)
//   npm run svr -- bond <eth> --yes   bond ETH with Atlas         (moves funds)
//   npm run svr -- unbond <eth> --yes start withdrawing a bond
//   npm run svr -- redeem <eth> --yes finish withdrawing a bond
//
// Every command that spends or moves funds prints exactly what it is about to do
// and refuses to proceed without --yes. Nothing here runs automatically.

import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import { ethers } from "ethers";
import {
  ATLAS, ATLAS_ABI, DAPP_CONTROL, DAPP_CONTROL_ABI, requiredBond,
} from "./svrAtlas";
import { SvrFeed } from "./svrFeed";

dotenv.config();

const ROOT      = path.resolve(__dirname, "..");
const SOURCE    = path.join(ROOT, "SvrSolver.sol");
const ARTIFACT  = path.join(ROOT, "artifacts", "AaveSvrSolver.json");
const SWAP_ROUTER02 = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45";

const args = process.argv.slice(2);
const cmd  = args[0];
const YES  = args.includes("--yes");
const pos  = args.filter(a => !a.startsWith("--"));

function die(msg: string): never { console.error(msg); process.exit(1); }

function wallet(): ethers.Wallet {
  const rpc = process.env.RPC_URL;
  const pk  = process.env.PRIVATE_KEY;
  if (!rpc || !pk) die("RPC_URL and PRIVATE_KEY must be set (in .env or the environment)");
  return new ethers.Wallet(pk, new ethers.JsonRpcProvider(rpc, 42161, { staticNetwork: true }));
}

function confirmOrExit(what: string): void {
  console.log(what);
  if (!YES) die("\nNothing sent. Re-run with --yes to proceed.");
}

// ── listen ───────────────────────────────────────────────────────────────────

async function listen(): Promise<void> {
  const seconds = Number(pos[1] ?? 60);
  const started = Date.now();
  const names = new Map<string, string>();
  const provider = process.env.RPC_URL
    ? new ethers.JsonRpcProvider(process.env.RPC_URL, 42161, { staticNetwork: true })
    : null;
  const nameOf = async (agg: string): Promise<string> => {
    if (names.has(agg)) return names.get(agg)!;
    let n = agg.slice(0, 10) + "…";
    if (provider) {
      try {
        const c = new ethers.Contract(agg, ["function description() view returns (string)"], provider);
        n = await c.description();
      } catch { /* keep the address */ }
    }
    names.set(agg, n);
    return n;
  };

  let count = 0;
  const feed = new SvrFeed("wss://svr-bid-endpoint.chain.link/ws/solver", a => {
    count++;
    nameOf(a.aggregator).then(n => {
      console.log(
        `${new Date().toISOString().slice(11, 23)}  ${n.padEnd(14)} ` +
        `price=${(Number(a.medianPrice) / 1e8).toFixed(4).padStart(12)}  ` +
        `gas=${(Number(a.maxFeePerGas) / 1e9).toFixed(4)} gwei  auction=${a.auctionId.slice(0, 8)}`
      );
    });
  }, { info: m => console.log(m), warn: m => console.log(m), error: m => console.error(m) });
  feed.start();
  console.log(`Listening for Arbitrum SVR auctions for ${seconds}s…`);
  await new Promise(r => setTimeout(r, seconds * 1000));
  feed.stop();
  console.log(`\n${count} auctions in ${((Date.now() - started) / 1000).toFixed(0)}s (${feed.stats.connects} connection(s))`);
  process.exit(0);
}

// ── compile ──────────────────────────────────────────────────────────────────

function compile(): { abi: unknown[]; bytecode: string } {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const solc = require("solc");
  const out = JSON.parse(solc.compile(JSON.stringify({
    language: "Solidity",
    sources:  { "SvrSolver.sol": { content: fs.readFileSync(SOURCE, "utf8") } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
    },
  })));
  const errors = (out.errors ?? []).filter((e: any) => e.severity === "error");
  for (const e of out.errors ?? []) console.log(`${e.severity}: ${String(e.formattedMessage).split("\n")[0]}`);
  if (errors.length) die("Compilation failed.");
  const c = out.contracts["SvrSolver.sol"].AaveSvrSolver;
  const artifact = { abi: c.abi, bytecode: "0x" + c.evm.bytecode.object };
  fs.mkdirSync(path.dirname(ARTIFACT), { recursive: true });
  fs.writeFileSync(ARTIFACT, JSON.stringify(artifact, null, 2));
  console.log(`Compiled AaveSvrSolver → ${path.relative(ROOT, ARTIFACT)} (${(artifact.bytecode.length - 2) / 2} bytes)`);
  return artifact;
}

// ── status ───────────────────────────────────────────────────────────────────

async function status(): Promise<void> {
  const w = wallet();
  const p = w.provider!;
  const atlas = new ethers.Contract(ATLAS, ATLAS_ABI, p);
  const dc    = new ethers.Contract(DAPP_CONTROL, DAPP_CONTROL_ABI, p);
  const [bal, bonded, unbonding, fee, dappGas, solverLimit] = await Promise.all([
    p.getBalance(w.address),
    atlas.balanceOfBonded(w.address),
    atlas.balanceOfUnbonding(w.address),
    p.getFeeData(),
    dc.getDAppGasLimit(),
    dc.getSolverGasLimit(),
  ]);
  const solverGas = BigInt(process.env.SVR_SOLVER_GAS ?? "2000000");
  // Use the gas price SVR auctions actually carry (~0.04-0.06 gwei), not the
  // network's current price, which is what a bundle would be billed at instead.
  const auctionGas = 60_000_000n;
  const need = requiredBond(500_000n, dappGas, solverGas, BigInt(process.env.SVR_OVERHEAD_GAS ?? "700000"), auctionGas);

  console.log(`Wallet            ${w.address}`);
  console.log(`ETH balance       ${ethers.formatEther(bal)}`);
  console.log(`Bonded with Atlas ${ethers.formatEther(bonded)}`);
  console.log(`Unbonding         ${ethers.formatEther(unbonding)}`);
  console.log(`Network gas price ${(Number(fee.gasPrice ?? 0n) / 1e9).toFixed(4)} gwei`);
  console.log(`Bond needed       ~${ethers.formatEther(need)} ETH (${solverGas} solver gas at 0.06 gwei; scales with the auction's gas price)`);
  console.log(`DappControl       solver gas limit ${solverLimit}, hook gas ${dappGas}`);
  console.log(bonded >= need ? "Bond is sufficient." : "Bond is BELOW the estimate — bids would be refused.");

  const solver = process.env.SVR_SOLVER_ADDRESS;
  if (solver && ethers.isAddress(solver)) {
    const code = await p.getCode(solver);
    console.log(`Solver contract   ${solver} ${code === "0x" ? "— NO CODE (not deployed)" : "— deployed"}`);
  } else {
    console.log("Solver contract   SVR_SOLVER_ADDRESS not set");
  }
}

// ── deploy ───────────────────────────────────────────────────────────────────

async function deploy(): Promise<void> {
  const w = wallet();
  const artifact = compile();
  const factory = new ethers.ContractFactory(artifact.abi as any, artifact.bytecode, w);
  const tx = await factory.getDeployTransaction(SWAP_ROUTER02, ATLAS);
  const [gas, fee, bal] = await Promise.all([
    w.provider!.estimateGas({ ...tx, from: w.address }),
    w.provider!.getFeeData(),
    w.provider!.getBalance(w.address),
  ]);
  const price = fee.maxFeePerGas ?? fee.gasPrice ?? 0n;
  // The L1 data fee is added by Arbitrum on top and is not in estimateGas's
  // price × gas product, so leave room for it.
  const cost = gas * price;
  console.log(`Deploy AaveSvrSolver(router=${SWAP_ROUTER02}, atlas=${ATLAS})`);
  console.log(`  from            ${w.address} (owner and the only account that can sign bids)`);
  console.log(`  estimated gas   ${gas}`);
  console.log(`  L2 cost         ~${ethers.formatEther(cost)} ETH, plus an L1 data fee`);
  console.log(`  balance         ${ethers.formatEther(bal)} ETH`);
  if (bal < cost * 2n) die("\nBalance is under twice the estimated L2 cost; refusing so the L1 fee cannot strand the deploy.");
  confirmOrExit("");
  const c = await factory.deploy(SWAP_ROUTER02, ATLAS);
  console.log(`tx ${c.deploymentTransaction()?.hash} — waiting…`);
  await c.waitForDeployment();
  console.log(`\nDeployed at ${await c.getAddress()}\nSet SVR_SOLVER_ADDRESS to this address.`);
}

// ── bond / unbond / redeem ───────────────────────────────────────────────────

async function moveBond(kind: "bond" | "unbond" | "redeem"): Promise<void> {
  const raw = pos[1];
  if (!raw) die(`usage: svr ${kind} <eth> --yes`);
  const amount = ethers.parseEther(raw);
  if (amount <= 0n) die("amount must be positive");
  const w = wallet();
  const atlas = new ethers.Contract(ATLAS, ATLAS_ABI, w);
  const bal = await w.provider!.getBalance(w.address);

  if (kind === "bond") {
    console.log(`Bond ${ethers.formatEther(amount)} ETH with Atlas from ${w.address}`);
    console.log(`  wallet balance ${ethers.formatEther(bal)} ETH — it stays bonded until you unbond (and wait ESCROW_DURATION blocks, then redeem)`);
    console.log("  Atlas charges each winning or failed bid's gas against this balance.");
    if (bal < amount) die("\nInsufficient ETH.");
    confirmOrExit("");
    const tx = await atlas.depositAndBond(amount, { value: amount });
    console.log(`tx ${tx.hash}`);
    await tx.wait();
  } else if (kind === "unbond") {
    confirmOrExit(`Start unbonding ${ethers.formatEther(amount)} ETH (redeemable after ESCROW_DURATION blocks)`);
    const tx = await atlas.unbond(amount);
    console.log(`tx ${tx.hash}`);
    await tx.wait();
  } else {
    confirmOrExit(`Redeem ${ethers.formatEther(amount)} ETH of unbonded balance`);
    const tx = await atlas.redeem(amount);
    console.log(`tx ${tx.hash}`);
    await tx.wait();
  }
  console.log("Done.");
}

async function main(): Promise<void> {
  switch (cmd) {
    case "listen":  return listen();
    case "compile": compile(); return;
    case "status":  return status();
    case "deploy":  return deploy();
    case "bond":
    case "unbond":
    case "redeem":  return moveBond(cmd);
    default:
      die("usage: svr <listen [seconds] | compile | status | deploy --yes | bond <eth> --yes | unbond <eth> --yes | redeem <eth> --yes>");
  }
}

main().catch(e => { console.error(e?.shortMessage ?? e?.message ?? e); process.exit(1); });
