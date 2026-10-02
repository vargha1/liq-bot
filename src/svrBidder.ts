// svrBidder.ts — bids in Chainlink SVR auctions for the right to liquidate behind
// an Aave oracle update.
//
// Why this exists. Aave's Arbitrum oracle reads SVR feeds. Their price updates
// are not broadcast: the oracle network sells the right to be bundled with the
// update, and the bundle lands as ONE transaction (update, then the winner's
// liquidation). Until that transaction a position is simply not liquidatable, so
// firing early — however fast — reverts with HealthFactorNotBelowThreshold.
//
// What it does, per auction the gateway announces:
//   1. The announcement includes the exact new price (`medianPrice`). Feed it
//      through the in-memory model, WITHOUT touching the shared price cache, to
//      see which borrowers that price pushes under 1.0.
//   2. Size a bid out of the profit those liquidations would make.
//   3. Sign a SolverOperation (EIP-712) whose data tells AaveSvrSolver which
//      liquidations to run, and submit it to the gateway.
//
// Capital: none of the bid or the liquidation is funded from the wallet. The debt
// is flashloaned and the bid is paid from the liquidation's own profit, inside the
// same transaction; if the profit does not cover the bid the solver reverts. The
// only standing balance is the gas bond Atlas charges against (see requiredBond).
//
// Dry-run (the default) runs steps 1 and 2 against live auctions and only logs.

import * as fs from "fs";
import * as path from "path";
import axios from "axios";
import { ethers } from "ethers";
import { logger } from "./logger";
import { CONFIG, RESERVES, AAVE_POOL, AAVE_POOL_ABI } from "./config";
import { SvrFeed } from "./svrFeed";
import type { TriggerEngine, SvrCandidate } from "./trigger";
import { encodeHeuristicPath, getCachedRoute, hopsFromPath, scheduleRouteRefresh } from "./uniswap";
import {
  ATLAS, ATLAS_ABI, DAPP_CONTROL, DAPP_CONTROL_ABI,
  signSolverOp, solverOpToWire, queryPayload, encodeSolverItems, requiredBond,
  type SolverOp, type SolverItem, type SvrAuction,
} from "./svrAtlas";

const WETH = RESERVES.WETH!.address;
const QUERY_API = "https://solver-query-api-fra.fastlane-labs.xyz/";
const QUERY_DELAY_MS = 3_500;           // an auction lasts ~2s; results settle a little after
const BOND_REFRESH_MS = 30_000;
const PROBE_EVERY_MS  = 10 * 60_000;
const SVR_PROBE_MAX_PCT = 20;   // mirrors SVR_PROBE_MAX_BPS in trigger.ts
const SVR_LOG = path.resolve(__dirname, "..", "logs", "svr-auctions.jsonl");

// Gas the oracle update itself is charged to the searcher for, on success. Used
// only to estimate the cost of winning; the bond check uses the auction's own
// userOp gas limit instead.
const ORACLE_UPDATE_GAS = 350_000n;
// Measured with svrSimulate.ts against live Aave and Uniswap state: one
// liquidation with a single-hop collateral swap and the profit -> WETH swap costs
// about 826k gas inside the solver call. Split into the parts that scale:
const ITEM_BASE_GAS  = 550_000n;   // flashloan, liquidationCall, bookkeeping
const SWAP_HOP_GAS   = 150_000n;   // per Uniswap hop on the collateral -> debt leg
const PROFIT_SWAP_GAS = 150_000n;  // debt -> WETH, skipped when the debt is WETH

const hopsOf = hopsFromPath;

export interface SvrBidderDeps {
  trigger:         TriggerEngine;
  wallet:          ethers.Wallet;
  getReadProvider: () => ethers.Provider;
  canBid:          () => boolean;
  onBid?:          (borrower: string) => void;
}

type Decision =
  | { kind: "skip"; reason: string }
  | { kind: "bid"; items: SolverItem[]; chosen: SvrCandidate[]; bidWei: bigint; bidUsd: number;
      netUsd: number; solverGas: bigint };

export class SvrBidder {
  private feed: SvrFeed;
  private bondedWei   = 0n;
  private dappGasLimit = 2_000_000n;
  private bondTimer: ReturnType<typeof setInterval> | null = null;
  private probeTimer: ReturnType<typeof setInterval> | null = null;

  stats = { auctions: 0, untracked: 0, unanchored: 0, noOpportunity: 0, skipped: 0, wouldBid: 0, submitted: 0, rejected: 0, included: 0, solverFailed: 0, updateGone: 0, suspect: 0 };

  constructor(private deps: SvrBidderDeps) {
    this.feed = new SvrFeed(CONFIG.svrWsUrl, a => this.onAuction(a), logger);
  }

  async start(): Promise<void> {
    const live = !CONFIG.svrDryRun;
    if (live && !ethers.isAddress(CONFIG.svrSolverAddress)) {
      throw new Error("SVR_DRY_RUN=false needs SVR_SOLVER_ADDRESS (the deployed AaveSvrSolver)");
    }
    await this.refreshBond().catch(e => logger.warn(`SVR: bond read failed: ${e?.message ?? e}`));
    this.bondTimer = setInterval(() => {
      this.refreshBond().catch(() => { /* keep the last figure */ });
    }, BOND_REFRESH_MS);
    this.feed.start();
    // First probe after the trigger engine has had time to anchor, then regularly.
    setTimeout(() => this.probe(), 90_000);
    this.probeTimer = setInterval(() => this.probe(), PROBE_EVERY_MS);
    logger.info(
      `SVR bidder started — ${live ? "LIVE" : "DRY-RUN (logs only)"}, ` +
      `bid fraction ${CONFIG.svrBidFraction}, bonded ${ethers.formatEther(this.bondedWei)} ETH`
    );
    if (live && this.bondedWei === 0n) {
      logger.warn("SVR: nothing is bonded with Atlas for this wallet — every bid will be refused until it is (npm run svr -- bond <eth> --yes)");
    }
  }

  stop(): void {
    this.feed.stop();
    if (this.bondTimer) clearInterval(this.bondTimer);
    this.bondTimer = null;
    if (this.probeTimer) clearInterval(this.probeTimer);
    this.probeTimer = null;
  }

  summary(): string {
    const s = this.stats;
    const f = this.feed.stats;
    return `svr: ${s.auctions} auctions (${f.connects} conn), ${s.untracked} not-aave, ${s.unanchored} NO-ANCHOR, ` +
      `${s.noOpportunity} no-opp, ${s.skipped} skipped, ${s.wouldBid} would-bid, ` +
      `${s.submitted} submitted, ${s.rejected} rejected, ${s.included} included, ` +
      `${s.solverFailed} solver-failed, ${s.updateGone} update-gone, ${s.suspect} suspect`;
  }

  private async refreshBond(): Promise<void> {
    const provider = this.deps.getReadProvider();
    const atlas = new ethers.Contract(ATLAS, ATLAS_ABI, provider);
    this.bondedWei = await atlas.balanceOfBonded(this.deps.wallet.address);
    try {
      const dc = new ethers.Contract(DAPP_CONTROL, DAPP_CONTROL_ABI, provider);
      const g = await dc.getDAppGasLimit();
      if (g > 0n) this.dappGasLimit = g;
    } catch { /* keep the default */ }
  }

  // Positive evidence that detection works. A quiet market yields no real
  // opportunities for hours, so "0 would-bid" proves nothing by itself. This feeds
  // small hypothetical drops through the same path a live auction uses and logs how
  // many borrowers would cross. If every row shows 0 crossing even at -5%, or an
  // Aave feed shows as unanchored, the pipeline is broken.
  private async probe(): Promise<void> {
    if (!this.deps.canBid()) return;
    try {
      const rows = await this.deps.trigger.svrProbe();
      const lines: string[] = [];
      let anyCross = false, unanchored = 0;
      for (const r of rows) {
        if (r.status === "unanchored") { unanchored++; lines.push(`  ${r.assets.join("/")}: NO ANCHOR`); continue; }
        if (r.status !== "ok" || r.shocks.length === 0) continue;
        if (r.minDropBps !== null || r.minRiseBps !== null) anyCross = true;
        const pct = (bps: number | null, net: number, sign: string) =>
          bps === null ? `${sign}none≤${SVR_PROBE_MAX_PCT}%` : `${sign}${(bps / 100).toFixed(2)}% ($${net.toFixed(0)})`;
        const name = `${r.assets.slice(0, 3).join("/")}${r.assets.length > 3 ? "+" + (r.assets.length - 3) : ""}`;
        lines.push(`  ${name.padEnd(22)} first bid at ${pct(r.minDropBps, r.minDropNetUsd, "-")}  or ${pct(r.minRiseBps, r.minRiseNetUsd, "+")}`);
      }
      logger.info(
        `🔬 SVR probe — smallest feed move that would make the bot bid ($ = best net profit there): ` +
        `${anyCross ? "detection path OK" : "NOTHING crosses even at ±20% — check the model"}${unanchored ? `, ${unanchored} feed(s) UNANCHORED` : ""}\n` +
        lines.join("\n")
      );
    } catch (e: any) {
      logger.warn(`SVR probe failed: ${e?.message ?? e}`);
    }
  }

  // ── Per-auction decision ───────────────────────────────────────────────────

  private onAuction(a: SvrAuction): void {
    this.stats.auctions++;
    // Always record the announced price: the secondary-transmit log that follows
    // the auction has no price of its own, so the trigger engine needs this even
    // when we are not bidding.
    this.deps.trigger.noteSvrAnswer(a.aggregator, a.medianPrice);
    if (!this.deps.canBid()) return;

    const t0 = performance.now();
    const d = this.decide(a);
    const ms = performance.now() - t0;

    if (d.kind === "skip") {
      // The two routine outcomes (most auctions move a feed nobody is exposed to,
      // or cross no one) would be nearly every line of the file; keep the ones
      // that show a decision being made.
      const routine = d.reason.startsWith("feed not tracked") || d.reason.startsWith("no borrower crosses");
      if (d.reason.startsWith("Aave feed has no price anchor")) {
        logger.warn(`SVR ${a.auctionId.slice(0, 8)}: ${d.reason} (${a.aggregator.slice(0, 10)}…) — cannot evaluate this auction`);
      }
      if (!routine) this.log(a, { decision: "skip", reason: d.reason, ms });
      logger.debug(`SVR ${a.auctionId.slice(0, 8)} skip: ${d.reason} (${ms.toFixed(1)}ms)`);
      return;
    }

    // The model proposes; the chain disposes. Nothing is bid on until every
    // borrower in it has been read from the chain and found to match the model.
    this.verified(a, d).then(final => {
      if (final) this.proceed(a, final, performance.now() - t0);
    }).catch(e => logger.warn(`SVR ${a.auctionId.slice(0, 8)}: verification failed, not bidding: ${e?.message ?? e}`));
  }

  private proceed(a: SvrAuction, d: Extract<Decision, { kind: "bid" }>, ms: number): void {
    this.log(a, {
      decision: CONFIG.svrDryRun ? "would-bid" : "bid",
      items: d.chosen.length, bidEth: ethers.formatEther(d.bidWei), bidUsd: d.bidUsd, netUsd: d.netUsd,
      gas: d.solverGas.toString(), borrowers: d.chosen.map(c => c.opp.borrower), ms,
    });
    logger.info(
      `💰 SVR ${CONFIG.svrDryRun ? "DRY-RUN would bid" : "bidding"} ${ethers.formatEther(d.bidWei)} ETH ` +
      `($${d.bidUsd.toFixed(2)}) for ${d.chosen.length} liquidation(s), ` +
      `est. net $${d.netUsd.toFixed(2)} [${a.auctionId.slice(0, 8)}, ${ms.toFixed(0)}ms]`
    );
    for (const c of d.chosen) {
      logger.info(
        `     ${c.opp.borrower.slice(0, 10)}… ${c.opp.collateralSymbol}->${c.opp.debtSymbol} ` +
        `HF=${c.hfLocal.toFixed(4)}${c.sure ? "" : " (bonus)"} debt=$${c.opp.debtToCoverUsd.toFixed(2)} ` +
        `profit=$${c.opp.expectedBonusUsd.toFixed(2)}`
      );
    }

    if (CONFIG.svrDryRun) { this.stats.wouldBid++; return; }
    for (const c of d.chosen) this.deps.onBid?.(c.opp.borrower);
    this.submit(a, d).catch(e => logger.error(`SVR submit failed: ${e?.message ?? e}`));
  }

  // Check each chosen borrower against Pool.getUserAccountData. A borrower passes
  // when the model's health factor at the CURRENT chain prices matches the chain's
  // within SVR_VERIFY_TOLERANCE and, for items the bid is sized on, the chain's HF
  // carried through the model's own price effect still lands under 1.0. Failures
  // are dropped and the bid re-sized without them; null when nothing survives.
  private async verified(
    a: SvrAuction, first: Extract<Decision, { kind: "bid" }>,
  ): Promise<Extract<Decision, { kind: "bid" }> | null> {
    const ok = new Set<string>();
    const failed = new Set<string>();
    let cur = first;
    for (let round = 0; round < 3; round++) {
      const todo = cur.chosen.filter(c => !ok.has(c.opp.borrower.toLowerCase()));
      if (todo.length === 0) return cur;
      const results = await this.checkAgainstChain(todo);
      let anyFailed = false;
      for (const [c, reason] of results) {
        const key = c.opp.borrower.toLowerCase();
        if (reason === null) { ok.add(key); continue; }
        failed.add(key);
        anyFailed = true;
        logger.warn(`SVR ${a.auctionId.slice(0, 8)}: dropping ${c.opp.borrower.slice(0, 10)}… — ${reason}`);
      }
      if (!anyFailed) return cur;

      // Re-size without the rejected borrowers. decide() counts auctions in the
      // stats, and this one has already been counted.
      const saved = { ...this.stats };
      const next = this.decide(a, failed);
      this.stats = saved;
      if (next.kind === "skip") {
        this.stats.suspect++;
        this.log(a, { decision: "skip", reason: `verification: ${next.reason}`, dropped: [...failed] });
        return null;
      }
      cur = next;
    }
    return null;
  }

  // null per candidate = matches the chain; otherwise the reason it does not.
  private async checkAgainstChain(cands: SvrCandidate[]): Promise<Array<[SvrCandidate, string | null]>> {
    const pool = new ethers.Contract(AAVE_POOL, AAVE_POOL_ABI, this.deps.getReadProvider());
    return Promise.all(cands.map(async (c): Promise<[SvrCandidate, string | null]> => {
      if (c.hfPre === null) return [c, "model has no health factor for it at current prices"];
      let chainHf: number;
      try {
        const r = await pool.getUserAccountData(c.opp.borrower);
        chainHf = Number(r[5]) / 1e18;
      } catch (e: any) {
        return [c, `chain read failed (${e?.shortMessage ?? e?.message ?? e})`];
      }
      if (!(chainHf > 0) || chainHf > 1e6) return [c, `chain health factor ${chainHf} (no debt?)`];
      const off = Math.abs(chainHf - c.hfPre) / chainHf;
      if (off > CONFIG.svrVerifyTolerance) {
        return [c, `model HF ${c.hfPre.toFixed(4)} vs chain ${chainHf.toFixed(4)} (${(off * 100).toFixed(2)}% off) — stale model`];
      }
      if (c.sure) {
        const corrected = chainHf * (c.hfLocal / c.hfPre);
        if (corrected >= 1) {
          return [c, `chain-corrected post-update HF ${corrected.toFixed(4)} is not under 1.0`];
        }
      }
      return [c, null];
    }));
  }

  private decide(a: SvrAuction, exclude: Set<string> = new Set()): Decision {
    const preview = this.deps.trigger.svrPreview(a.aggregator, a.medianPrice, a.maxFeePerGas);
    if (preview === "untracked") { this.stats.untracked++; return { kind: "skip", reason: "feed not tracked (not an Aave feed)" }; }
    // An Aave feed with nothing to estimate from means the detection path is blind
    // for it. That is a fault, not a routine skip, so it is logged and recorded.
    if (preview === "unanchored") {
      this.stats.unanchored++;
      return { kind: "skip", reason: "Aave feed has no price anchor yet" };
    }

    const candidates = exclude.size === 0
      ? preview.candidates
      : preview.candidates.filter(c => !exclude.has(c.opp.borrower.toLowerCase()));
    const sure = candidates.filter(c => c.sure);
    if (sure.length === 0) { this.stats.noOpportunity++; return { kind: "skip", reason: "no borrower crosses 1.0" }; }

    // A jump this large in one update is, in practice, the model's fault (a bad
    // anchor or scale), not the market's. Do not size a bid on it.
    if (preview.movePct !== null && Math.abs(preview.movePct) > CONFIG.svrMaxMovePct) {
      this.stats.suspect++;
      logger.warn(
        `SVR ${a.auctionId.slice(0, 8)}: announced answer is ${preview.movePct.toFixed(2)}% from the last seen ` +
        `(limit ${CONFIG.svrMaxMovePct}%) on ${a.aggregator.slice(0, 10)}… — not bidding`
      );
      return { kind: "skip", reason: `announced move ${preview.movePct.toFixed(2)}% exceeds SVR_MAX_MOVE_PCT` };
    }

    // Sure items first (the bid is sized on them), then bonus items, all within the
    // gas the operation is allowed to use.
    const ordered = [...sure, ...candidates.filter(c => !c.sure)];
    const chosen: SvrCandidate[] = [];
    let gas = 150_000n;    // solver-call overhead: decode, unwrap, pay bid, reconcile
    for (const c of ordered) {
      if (chosen.length >= CONFIG.svrMaxItems) break;
      const g = this.itemGas(c);
      if (gas + g > CONFIG.svrSolverGas) continue;
      chosen.push(c);
      gas += g;
    }
    const chosenSure = chosen.filter(c => c.sure);
    if (chosenSure.length === 0) { this.stats.skipped++; return { kind: "skip", reason: "no crossing borrower fits the gas cap" }; }

    // Profit the bid may rely on: only items the model is confident cross 1.0.
    // Bonus items add upside but are never counted, so a bonus item failing
    // on-chain cannot leave the bid uncovered.
    const grossUsd = chosenSure.reduce((s, c) => s + c.opp.expectedBonusUsd, 0);
    const solverGas = gas + gas / 5n;    // 20% headroom on the limit we sign for
    const cappedGas = solverGas > CONFIG.svrSolverGas ? CONFIG.svrSolverGas : solverGas;

    // Cost of winning: Atlas bills the oracle update plus this operation's gas to
    // the bond, at the auction's gas price plus its surcharge.
    const billedGas = ORACLE_UPDATE_GAS + gas;
    const gasUsd = Number((billedGas * a.maxFeePerGas * 11_000n) / 10_000n) / 1e18 * preview.ethPrice;
    const netUsd = grossUsd - gasUsd - CONFIG.svrExtraCostUsd;
    if (netUsd < CONFIG.svrMinNetUsd) {
      this.stats.skipped++;
      return { kind: "skip", reason: `net $${netUsd.toFixed(3)} below SVR_MIN_NET_USD` };
    }

    const bidUsd = netUsd * CONFIG.svrBidFraction;
    const bidWei = BigInt(Math.floor((bidUsd / preview.ethPrice) * 1e18));
    if (bidWei <= 0n) { this.stats.skipped++; return { kind: "skip", reason: "bid rounds to zero" }; }

    const need = requiredBond(a.userOpGas, this.dappGasLimit, cappedGas, CONFIG.svrOverheadGas, a.maxFeePerGas);
    if (this.bondedWei < need) {
      this.stats.skipped++;
      return {
        kind: "skip",
        reason: `bond ${ethers.formatEther(this.bondedWei)} ETH < required ${ethers.formatEther(need)} ETH`,
      };
    }

    // The profit -> WETH swap runs with no on-chain floor and a failure there is
    // swallowed, leaving the profit in the debt token and the whole operation
    // reverting on "Profit below bid". Only bid with a QUOTED route for it; a
    // guessed fee tier is how that happens. Kick off the quote and skip this one.
    for (const c of chosen) {
      const debt = c.opp.debtAsset;
      if (debt.toLowerCase() === WETH.toLowerCase()) continue;
      if (!getCachedRoute(debt, WETH)) {
        scheduleRouteRefresh(debt, WETH, c.opp.debtToCover / 20n + 1n, this.deps.getReadProvider(), true);
        this.stats.skipped++;
        return { kind: "skip", reason: `no verified ${c.opp.debtSymbol}->WETH route yet (quote requested)` };
      }
    }

    const premiumBps = BigInt(CONFIG.flashloanPremiumBps);
    const items: SolverItem[] = chosen.map(c => {
      const o = c.opp;
      const isSame = o.collateralAsset.toLowerCase() === o.debtAsset.toLowerCase();
      const debtIsWeth = o.debtAsset.toLowerCase() === WETH.toLowerCase();
      // Floor = flashloan repayment only. The bot's normal floor also adds this
      // tx's own gas; here gas comes out of the bond, and the aggregate
      // "profit covers the bid" check in the contract is the real guard.
      const repay = o.debtToCover + (o.debtToCover * premiumBps) / 10_000n;
      return {
        collateralAsset:  o.collateralAsset,
        debtAsset:        o.debtAsset,
        borrower:         o.borrower,
        debtToCover:      o.debtToCover,
        swapPath:         isSame ? "0x" : (o.swapPath && o.swapPath !== "0x" ? o.swapPath : encodeHeuristicPath(o.collateralAsset, o.debtAsset)),
        amountOutMinimum: isSame ? 0n : repay,
        profitPath:       debtIsWeth ? "0x" : (getCachedRoute(o.debtAsset, WETH)!.path),
      };
    });

    return { kind: "bid", items, chosen, bidWei, bidUsd, netUsd, solverGas: cappedGas };
  }

  private itemGas(c: SvrCandidate): bigint {
    const o = c.opp;
    const isSame = o.collateralAsset.toLowerCase() === o.debtAsset.toLowerCase();
    const liquidation = isSame ? ITEM_BASE_GAS : ITEM_BASE_GAS + SWAP_HOP_GAS * BigInt(Math.max(1, hopsOf(o.swapPath)));
    const profitSwap = o.debtAsset.toLowerCase() === WETH.toLowerCase() ? 0n : PROFIT_SWAP_GAS;
    return liquidation + profitSwap;
  }

  // ── Submission ─────────────────────────────────────────────────────────────

  private async submit(a: SvrAuction, d: Extract<Decision, { kind: "bid" }>): Promise<void> {
    const op: SolverOp = {
      from:         this.deps.wallet.address,
      to:           a.atlas,
      value:        0n,
      gas:          d.solverGas,
      maxFeePerGas: a.maxFeePerGas,      // must equal the oracle's gas price exactly
      deadline:     a.deadline,
      solver:       CONFIG.svrSolverAddress,
      control:      a.control,
      userOpHash:   a.userOpHash,
      bidToken:     ethers.ZeroAddress,
      bidAmount:    d.bidWei,
      data:         encodeSolverItems(d.items),
    };
    const signature = await signSolverOp(this.deps.wallet, op);
    const wire = solverOpToWire(op, signature);

    this.stats.submitted++;
    try {
      await this.feed.submit(a.auctionId, wire);
    } catch (e: any) {
      this.stats.rejected++;
      logger.warn(`SVR ${a.auctionId.slice(0, 8)}: gateway rejected the bid: ${e?.message ?? e}`);
      return;
    }
    logger.info(`SVR ${a.auctionId.slice(0, 8)}: bid accepted by the gateway`);
    setTimeout(() => {
      this.queryOutcome(a).catch(e => logger.debug(`SVR outcome query failed: ${e?.message ?? e}`));
    }, QUERY_DELAY_MS);
  }

  // Ask FastLane what became of the bid. Purely informational.
  private async queryOutcome(a: SvrAuction): Promise<void> {
    const from = this.deps.wallet.address;
    const signature = await this.deps.wallet.signMessage(queryPayload(a.auctionId, a.userOpHash, from));
    const res = await axios.post(QUERY_API, {
      jsonrpc: "2.0", id: 1, method: "solver_getSolverOperationResult",
      params: [{ auctionId: a.auctionId, userOperationHash: a.userOpHash, solverOperationFrom: ethers.getAddress(from), signature }],
    }, { timeout: 5_000 });
    const result = res.data?.result?.result ?? res.data?.error?.message ?? "unknown";
    const text = String(result);
    if (text === "included") this.stats.included++;
    // The gateway accepts a bid before simulating it, so a failed simulation
    // never shows as "rejected". UserOpSimFail: the oracle update itself no longer
    // applies (someone else's bundle landed it first). SolverSimFail: the update
    // applied and our operation reverted.
    else if (/UserOpSimFail/.test(text)) this.stats.updateGone++;
    else if (/SolverSimFail|SolverOpReverted/.test(text)) this.stats.solverFailed++;
    // The gateway echoes the whole simulated calldata (several KB); keep the head,
    // which carries the outcome codes, and put the full text in the jsonl.
    const shown = text.length > 200 ? `${text.slice(0, 200)}… (+${text.length - 200} chars, full text in svr-auctions.jsonl)` : text;
    logger.info(`SVR ${a.auctionId.slice(0, 8)}: outcome = ${shown}`);
    this.log(a, { decision: "outcome", outcome: text });
  }

  // One JSON line per auction, so a dry run can be analysed afterwards against
  // what actually won on-chain.
  private log(a: SvrAuction, extra: Record<string, unknown>): void {
    try {
      fs.mkdirSync(path.dirname(SVR_LOG), { recursive: true });
      fs.appendFileSync(SVR_LOG, JSON.stringify({
        t: new Date().toISOString(), auction: a.auctionId, feed: a.aggregator,
        price: a.medianPrice.toString(), gasPrice: a.maxFeePerGas.toString(), ...extra,
      }) + "\n");
    } catch { /* logging must never break bidding */ }
  }
}
