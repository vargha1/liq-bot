// svrSelftest.ts — checks the SVR signing/encoding code against REAL on-chain data.
//
//   npx tsx src/svrSelftest.ts
//
// Free and read-only. It fetches a winning Atlas metacall from Arbitrum, decodes
// its SolverOperations, and recovers each operation's signer with our EIP-712
// implementation. If the domain, typehash or field order were wrong, the
// recovered address would not match `from`, so a pass here is strong evidence
// the bids we sign will be accepted.

import { ethers } from "ethers";
import {
  ATLAS, recoverSolverOpSigner, solverOpToWire, signSolverOp, requiredBond,
  parseAuction, isOurAuction, encodeSolverItems, type SolverOp,
} from "./svrAtlas";

const UO = "(address from,address to,uint256 value,uint256 gas,uint256 maxFeePerGas,uint256 nonce,uint256 deadline,address dapp,address control,uint32 callConfig,uint32 dappGasLimit,uint32 solverGasLimit,uint24 bundlerSurchargeRate,address sessionKey,bytes data,bytes signature)";
const SO = "(address from,address to,uint256 value,uint256 gas,uint256 maxFeePerGas,uint256 deadline,address solver,address control,bytes32 userOpHash,address bidToken,uint256 bidAmount,bytes data,bytes signature)";
const DO = "(address from,address to,uint256 nonce,uint256 deadline,address control,address bundler,bytes32 userOpHash,bytes32 callChainHash,bytes signature)";
const METACALL = new ethers.Interface([
  `function metacall(${UO} userOp, ${SO}[] solverOps, ${DO} dAppOp, address gasRefundBeneficiary) payable returns (bool)`,
]);

// A real winning SVR liquidation: Arbitrum block 503713365, tx index 11.
const SAMPLE_TX = "0x12dabe47d3adc460ad5a14500521a1410399eebe9505fc07e73986f1011c8fb3";
const PUBLIC_RPCS = ["https://arbitrum.drpc.org", "https://arbitrum-one-rpc.publicnode.com"];

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
}

async function fetchTx(): Promise<ethers.TransactionResponse> {
  const urls = [process.env.RPC_URL, ...PUBLIC_RPCS].filter(Boolean) as string[];
  for (const url of urls) {
    try {
      const p = new ethers.JsonRpcProvider(url, 42161, { staticNetwork: true });
      const tx = await p.getTransaction(SAMPLE_TX);
      if (tx) return tx;
    } catch { /* try the next endpoint */ }
  }
  throw new Error("could not fetch the sample transaction from any RPC");
}

async function main(): Promise<void> {
  const tx = await fetchTx();
  check("sample tx targets Atlas", tx.to?.toLowerCase() === ATLAS.toLowerCase());

  const parsed = METACALL.parseTransaction({ data: tx.data })!;
  const ops = parsed.args[1] as any[];
  check("sample tx carries solver operations", ops.length > 0, `(${ops.length})`);

  for (const [i, o] of ops.entries()) {
    const op: SolverOp = {
      from: o.from, to: o.to, value: o.value, gas: o.gas, maxFeePerGas: o.maxFeePerGas,
      deadline: o.deadline, solver: o.solver, control: o.control, userOpHash: o.userOpHash,
      bidToken: o.bidToken, bidAmount: o.bidAmount, data: o.data,
    };
    let recovered = "";
    try { recovered = recoverSolverOpSigner(op, o.signature); } catch { /* reported below */ }
    check(`EIP-712 signature of solver op #${i} recovers its 'from'`,
      recovered.toLowerCase() === String(o.from).toLowerCase(),
      `(from ${o.from}, recovered ${recovered || "n/a"})`);
  }

  // Round trip with a throwaway key: sign -> recover.
  const w = ethers.Wallet.createRandom();
  const base = ops[0]!;
  const mine: SolverOp = {
    from: w.address, to: ATLAS, value: 0n, gas: 1_500_000n, maxFeePerGas: 57_224_200n,
    deadline: 503_713_455n, solver: base.solver, control: base.control,
    userOpHash: base.userOpHash, bidToken: ethers.ZeroAddress, bidAmount: 12345n,
    data: encodeSolverItems([]),
  };
  const sig = await signSolverOp(w, mine);
  check("sign -> recover round trip", recoverSolverOpSigner(mine, sig).toLowerCase() === w.address.toLowerCase());
  const wire = solverOpToWire(mine, sig);
  check("wire format uses hex quantities", wire.gas === "0x16e360" && wire.value === "0x0", `(gas ${wire.gas})`);

  // Bond sizing against the numbers seen on-chain: a 6M-gas op at 0.0572 gwei
  // needed roughly this much bonded ETH in the winning bundle's terms.
  const bond = requiredBond(500_000n, 2_000_000n, 1_500_000n, 600_000n, 57_224_200n);
  check("bond estimate is sane", bond > 0n && bond < ethers.parseEther("0.001"), `(${ethers.formatEther(bond)} ETH)`);

  // Notification parsing, using a real captured message shape.
  const msg = {
    jsonrpc: "2.0", method: "solver_subscription",
    params: { result: {
      auction_id: "128ba9ed-170d-49e9-8d02-cce6e6ecbcf2",
      partial_user_operation: {
        chainId: "0xa4b1", control: "0xe15bba987c002ecc3586e81244517877d294d291",
        dapp: "0xe15bba987c002ecc3586e81244517877d294d291", deadline: "0x1e6b8c70",
        from: ethers.ZeroAddress, gas: "0x7a120",
        hints: { aggregator: "0xa5E1a36938769cbd5a26f5e19D8FCB379f597c83", medianPrice: "0x3ef990f8c0" },
        maxFeePerGas: "0x248fe98", to: "0x8ad1ae9d97c79aa68a0a151e83ff3942f68f86c1",
        userOpHash: "0xd7894b2cfb2f40f99c570bc8984895647547d05fac9a74734487cea8278b4f88",
      },
    } },
  };
  const a = parseAuction(msg);
  check("auction parses", !!a && a.medianPrice === 0x3ef990f8c0n && a.maxFeePerGas === 0x248fe98n);
  check("auction recognised as ours", !!a && isOurAuction(a));
  check("garbage does not parse", parseAuction({ foo: 1 }) === null && parseAuction(null) === null);

  console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) FAILED.`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => { console.error(e?.message ?? e); process.exit(1); });
