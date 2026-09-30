// svrAtlas.ts — Chainlink SVR / Atlas protocol primitives (Arbitrum).
//
// Aave's Arbitrum oracle prices most reserves off Chainlink SVR feeds. Those
// feeds are updated through an Atlas auction: the oracle network bundles the
// price update (`transmitSecondary`) with the winning searcher's operation into
// one transaction, so a position becomes liquidatable only inside that bundle.
//
// Everything here is pure encoding and signing, with no I/O, so it can be checked
// against real on-chain operations (see `svrTool selftest`).
//
// Sources: https://docs.chain.link/data-feeds/svr-feeds/searcher-onboarding-atlas
// and the Atlas v1.6.4 contracts (SolverOperation.sol, AtlasVerification).

import { ethers } from "ethers";

export const ARBITRUM_CHAIN_ID = 42161;

// Atlas v1.6.4 deployment on Arbitrum.
export const ATLAS              = "0x8ad1aE9D97C79aA68A0a151E83ff3942f68F86C1";
export const ATLAS_VERIFICATION = "0xAC116AbB948E26B023c9C4815ab001845Fbf54fF";
// The Chainlink SVR DappControl for this chain. Auctions for any other control
// belong to other protocols and are ignored.
export const DAPP_CONTROL       = "0xe15BBa987C002ecc3586e81244517877D294d291";
export const ATLAS_VERSION      = "1.6.4";

// Topic0 of the log a SVR aggregator emits when a secondary (auction) transmit
// lands. Observed on-chain (block 503713365, WETH/USD aggregator); it is NOT
// AnswerUpdated, which is why the trigger engine needs to listen for it too.
export const SVR_ROUND_TOPIC = "0x8d530b9ddc4b318d28fdd4c3a21fcfecece54c1a72a824f262985b99afef009b";

// Atlas charges the bonded balance for the whole bundle's gas plus a surcharge.
// getAtlasSurchargeRate() returned 1000 on a 10_000 scale, i.e. 10%.
export const ATLAS_SURCHARGE_BPS = 1000n;

export const ATLAS_ABI = [
  "function balanceOfBonded(address account) view returns (uint256)",
  "function balanceOfUnbonding(address account) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function unbondingCompleteBlock(address account) view returns (uint256)",
  "function ESCROW_DURATION() view returns (uint256)",
  "function depositAndBond(uint256 amountToBond) payable",
  "function unbond(uint256 amount)",
  "function redeem(uint256 amount)",
];

export const DAPP_CONTROL_ABI = [
  "function getSolverGasLimit() view returns (uint256)",
  "function getDAppGasLimit() view returns (uint256)",
];

// ── Solver operation ─────────────────────────────────────────────────────────

export interface SolverOp {
  from:         string;   // bonded searcher EOA (signer)
  to:           string;   // Atlas
  value:        bigint;
  gas:          bigint;
  maxFeePerGas: bigint;   // must equal the auction's gas price exactly
  deadline:     bigint;   // block number
  solver:       string;   // our AaveSvrSolver contract
  control:      string;
  userOpHash:   string;
  bidToken:     string;   // address(0) = ETH
  bidAmount:    bigint;
  data:         string;
}

// Field order and types mirror SOLVER_TYPEHASH in Atlas's SolverOperation.sol.
const SOLVER_OP_TYPES = {
  SolverOperation: [
    { name: "from",         type: "address" },
    { name: "to",           type: "address" },
    { name: "value",        type: "uint256" },
    { name: "gas",          type: "uint256" },
    { name: "maxFeePerGas", type: "uint256" },
    { name: "deadline",     type: "uint256" },
    { name: "solver",       type: "address" },
    { name: "control",      type: "address" },
    { name: "userOpHash",   type: "bytes32" },
    { name: "bidToken",     type: "address" },
    { name: "bidAmount",    type: "uint256" },
    { name: "data",         type: "bytes"   },
  ],
};

const SOLVER_DOMAIN = {
  name:              "AtlasVerification",
  version:           ATLAS_VERSION,
  chainId:           ARBITRUM_CHAIN_ID,
  verifyingContract: ATLAS_VERIFICATION,
};

export async function signSolverOp(signer: ethers.Signer, op: SolverOp): Promise<string> {
  return signer.signTypedData(SOLVER_DOMAIN, SOLVER_OP_TYPES, op);
}

export function recoverSolverOpSigner(op: SolverOp, signature: string): string {
  return ethers.verifyTypedData(SOLVER_DOMAIN, SOLVER_OP_TYPES, op, signature);
}

// JSON shape the gateway expects: quantities as 0x-hex, addresses checksummed.
export function solverOpToWire(op: SolverOp, signature: string): Record<string, string> {
  const q = (v: bigint) => "0x" + v.toString(16);
  return {
    from:         ethers.getAddress(op.from),
    to:           ethers.getAddress(op.to),
    value:        q(op.value),
    gas:          q(op.gas),
    maxFeePerGas: q(op.maxFeePerGas),
    deadline:     q(op.deadline),
    solver:       ethers.getAddress(op.solver),
    control:      ethers.getAddress(op.control),
    userOpHash:   op.userOpHash,
    bidToken:     ethers.getAddress(op.bidToken),
    bidAmount:    q(op.bidAmount),
    data:         op.data,
    signature,
  };
}

// EIP-191 message the query API wants to see signed (NOT the bid signature).
export function queryPayload(auctionId: string, userOpHash: string, solverOpFrom: string): string {
  return `${auctionId}:${userOpHash}:${ethers.getAddress(solverOpFrom)}`;
}

// ── Solver-call data ─────────────────────────────────────────────────────────

export interface SolverItem {
  collateralAsset:  string;
  debtAsset:        string;
  borrower:         string;
  debtToCover:      bigint;
  swapPath:         string;   // collateral -> debt, "0x" if same asset
  amountOutMinimum: bigint;
  profitPath:       string;   // debt -> WETH, "0x" if debt is WETH
}

const ITEM_TUPLE =
  "tuple(address collateralAsset,address debtAsset,address borrower,uint256 debtToCover," +
  "bytes swapPath,uint256 amountOutMinimum,bytes profitPath)[]";

export function encodeSolverItems(items: SolverItem[]): string {
  return ethers.AbiCoder.defaultAbiCoder().encode([ITEM_TUPLE], [items]);
}

// ── Bond sizing ──────────────────────────────────────────────────────────────

// What Atlas requires the searcher to have bonded before it will run the op
// (Escrow._validateSolverOpGasAndValue): the gas of everything the searcher could
// be charged for, at the auction's gas price, plus the surcharge. That is the
// oracle update itself (userOp.gas) and the dApp hooks as well as our own op.
//
// `overheadGas` covers metacall bookkeeping and calldata gas; it is an estimate,
// so callers should treat the result as a floor and keep some headroom.
export function requiredBond(
  userOpGas: bigint, dappGasLimit: bigint, solverGas: bigint,
  overheadGas: bigint, gasPrice: bigint,
): bigint {
  const gas = userOpGas + dappGasLimit + solverGas + overheadGas;
  return (gas * gasPrice * (10_000n + ATLAS_SURCHARGE_BPS)) / 10_000n;
}

// ── Notification payload ─────────────────────────────────────────────────────

export interface SvrAuction {
  auctionId:    string;
  chainId:      number;
  atlas:        string;   // `to` of the userOp — the Atlas contract
  control:      string;
  userOpHash:   string;
  userOpGas:    bigint;
  maxFeePerGas: bigint;   // the gas price the oracle network chose; we must sign for exactly this
  deadline:     bigint;
  aggregator:   string;   // lowercase; the feed being updated
  medianPrice:  bigint;   // the new answer, in the aggregator's decimals
  receivedAt:   number;   // Date.now()
}

const hexBig = (v: unknown): bigint => {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]*$/.test(v)) throw new Error("bad hex");
  return v === "0x" ? 0n : BigInt(v);
};

// Parse one solver_subscription message. Returns null for anything that is not
// an auction we could bid on, including malformed messages.
export function parseAuction(msg: any): SvrAuction | null {
  try {
    if (msg?.method !== "solver_subscription") return null;
    const r = msg.params?.result;
    const u = r?.partial_user_operation;
    if (!r?.auction_id || !u) return null;
    const hints = u.hints;
    if (!hints?.aggregator || !hints?.medianPrice) return null;
    return {
      auctionId:    String(r.auction_id),
      chainId:      Number(hexBig(u.chainId)),
      atlas:        String(u.to),
      control:      String(u.control),
      userOpHash:   String(u.userOpHash),
      userOpGas:    hexBig(u.gas),
      maxFeePerGas: hexBig(u.maxFeePerGas),
      deadline:     hexBig(u.deadline),
      aggregator:   String(hints.aggregator).toLowerCase(),
      medianPrice:  hexBig(hints.medianPrice),
      receivedAt:   Date.now(),
    };
  } catch {
    return null;
  }
}

export function isOurAuction(a: SvrAuction): boolean {
  return a.chainId === ARBITRUM_CHAIN_ID
    && a.control.toLowerCase() === DAPP_CONTROL.toLowerCase()
    && a.atlas.toLowerCase()   === ATLAS.toLowerCase();
}
