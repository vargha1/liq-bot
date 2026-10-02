// Compile and deploy LiquidatorContract.sol to the chain selected by CHAIN.
//
//   CHAIN=base npm run deploy-liquidator            compile + dry run (no transaction)
//   CHAIN=base npm run deploy-liquidator -- --yes   broadcast the deployment
//   CHAIN=base npm run deploy-liquidator -- --compile   only build artifacts/ (no RPC, no key)
//
// Needs RPC_URL and PRIVATE_KEY (the deployer becomes the contract's owner).
// Deliberately does not import config.ts: that module also demands CONTRACT_ADDRESS,
// which is exactly what this script produces.
import * as fs from "fs";
import * as path from "path";
import { ethers } from "ethers";
import { PROFILE } from "./chains";

const ROOT     = path.resolve(__dirname, "..");
const SOURCE   = path.join(ROOT, "LiquidatorContract.sol");
const ARTIFACT = path.join(ROOT, "artifacts", `AaveLiquidator.${PROFILE.key}.json`);

function die(msg: string): never { console.error(msg); process.exit(1); }

// The contract only compiles through the IR pipeline: the legacy one fails with
// "Stack too deep" in executeOperation, so viaIR is required, not an optimisation.
function compile(): { abi: unknown[]; bytecode: string } {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const solc = require("solc");
  const out = JSON.parse(solc.compile(JSON.stringify({
    language: "Solidity",
    sources:  { "LiquidatorContract.sol": { content: fs.readFileSync(SOURCE, "utf8") } },
    settings: {
      viaIR: true,
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
    },
  })));
  for (const e of out.errors ?? []) console.log(`${e.severity}: ${String(e.formattedMessage).split("\n")[0]}`);
  if ((out.errors ?? []).some((e: any) => e.severity === "error")) die("Compilation failed.");
  const c = out.contracts["LiquidatorContract.sol"].AaveLiquidator;
  const artifact = { abi: c.abi, bytecode: "0x" + c.evm.bytecode.object };
  fs.mkdirSync(path.dirname(ARTIFACT), { recursive: true });
  fs.writeFileSync(ARTIFACT, JSON.stringify(artifact, null, 2));
  console.log(`Compiled AaveLiquidator -> ${path.relative(ROOT, ARTIFACT)} (${(artifact.bytecode.length - 2) / 2} bytes)`);
  return artifact;
}

async function main(): Promise<void> {
  if (process.argv.includes("--compile")) { compile(); return; }
  const rpc = process.env.RPC_URL;
  const pk  = process.env.PRIVATE_KEY;
  if (!rpc || !pk) die("Set RPC_URL and PRIVATE_KEY in the environment or .env");

  const provider = new ethers.JsonRpcProvider(rpc, PROFILE.chainId, { staticNetwork: true });
  const net = await provider.getNetwork();
  if (net.chainId !== BigInt(PROFILE.chainId)) {
    die(`RPC reports chain ${net.chainId} but CHAIN=${PROFILE.key} expects ${PROFILE.chainId}`);
  }
  const wallet = new ethers.Wallet(pk, provider);

  const artifact = compile();
  const factory  = new ethers.ContractFactory(artifact.abi as any, artifact.bytecode, wallet);
  const router   = PROFILE.uniswap.router;
  const pool     = PROFILE.aave.pool;

  // The deployment is only meaningful against the real Aave Pool and router: check
  // both have code on this chain before spending anything.
  for (const [label, addr] of [["Aave Pool", pool], ["Uniswap SwapRouter02", router]] as const) {
    if ((await provider.getCode(addr)) === "0x") die(`${label} ${addr} has no code on ${PROFILE.name} - wrong chain or address?`);
  }

  const tx   = await factory.getDeployTransaction(router, pool);
  const [gas, fee, bal] = await Promise.all([
    provider.estimateGas({ ...tx, from: wallet.address }),
    provider.getFeeData(),
    provider.getBalance(wallet.address),
  ]);
  const gasPrice = fee.maxFeePerGas ?? fee.gasPrice ?? 0n;
  const cost     = gas * gasPrice;

  console.log(`Chain             ${PROFILE.name} (${PROFILE.chainId})`);
  console.log(`Deployer / owner  ${wallet.address}`);
  console.log(`Aave Pool         ${pool}`);
  console.log(`Swap router       ${router}`);
  console.log(`Gas estimate      ${gas} (~${ethers.formatEther(cost)} ${PROFILE.nativeSymbol} at ${Number(gasPrice) / 1e9} gwei, L1 data fee extra)`);
  console.log(`Balance           ${ethers.formatEther(bal)} ${PROFILE.nativeSymbol}`);
  if (bal < cost) die("Balance below the estimated deployment cost.");

  if (!process.argv.includes("--yes")) {
    console.log("\nDry run only. Re-run with --yes to broadcast.");
    return;
  }

  const contract = await factory.deploy(router, pool);
  console.log(`Deploy tx         ${contract.deploymentTransaction()?.hash}`);
  await contract.waitForDeployment();
  const address = await contract.getAddress();

  const check = new ethers.Contract(address, [
    "function owner() view returns (address)",
    "function AAVE_POOL() view returns (address)",
    "function SWAP_ROUTER() view returns (address)",
  ], provider);
  const [o, p, r] = await Promise.all([check.owner(), check.AAVE_POOL(), check.SWAP_ROUTER()]);
  if (o !== wallet.address || p !== pool || r !== router) die(`Post-deploy check FAILED: owner=${o} pool=${p} router=${r}`);

  console.log(`\nDeployed and verified: ${address}`);
  console.log(`Set CONTRACT_ADDRESS=${address} in the ${PROFILE.name} bot's .env`);
  console.log(`${PROFILE.explorer}/address/${address}`);
}

main().catch(e => die(`Deploy failed: ${e?.shortMessage ?? e?.message ?? e}`));
