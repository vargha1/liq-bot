// trigger.ts — event-driven liquidation trigger engine.
//
// The polling cycle discovers liquidatable positions only when its sweep happens
// to fetch a fresh HF AFTER the triggering price move — that alone costs seconds.
// The real trigger for most liquidations is an oracle price update: a Chainlink
// feed pushes a new answer, Aave's oracle picks it up, and many HFs move at once
// (no borrower-side event fires).
//
// This engine subscribes to AnswerUpdated events on the underlying Chainlink
// aggregators of every Aave reserve. On each update it:
//   1. Estimates the new Aave price instantly (cached price × answer ratio),
//      then confirms with one authoritative getAssetPrice call in the background.
//   2. Recomputes HF LOCALLY for every watched position holding that asset,
//      using cached per-asset breakdowns (no RPC).
//   3. Builds and submits opportunities immediately for anything below the local
//      HF ceiling. The contract's on-chain guards (deadline, amountOutMinimum,
//      flashloan repayment check) make a wrong guess revert cheaply.
//
// Result: detection latency drops from seconds to the block propagation time.
//
// ── Feed resolution (this is the subtle part) ────────────────────────────────
// AaveOracle.getSourceOfAsset() does NOT return an address that emits events.
// It returns one of:
//   a) an EACAggregatorProxy (WETH, ARB, WBTC, LINK …) — a pure forwarder that
//      emits nothing; the real emitter is proxy.aggregator().
//   b) an Aave CAPO price-cap adapter (USDC, wstETH, weETH, ezETH …) — also
//      emits nothing; it wraps ASSET_TO_USD_AGGREGATOR() (stable adapters) or
//      BASE_TO_USD_AGGREGATOR() (LST ratio adapters), each of which is itself a
//      proxy that must then be walked to .aggregator().
// So resolution is a walk: follow aggregator() / ASSET_TO_USD_AGGREGATOR() /
// BASE_TO_USD_AGGREGATOR() until nothing resolves; that terminal node is the
// OCR aggregator that actually emits AnswerUpdated.
//
// The mapping is many-to-one in the other direction too: the single ETH/USD
// aggregator drives WETH, wstETH, weETH, ezETH, rsETH and rETH. feeds is
// therefore feed → Set<asset>, not feed → asset.

import { ethers } from "ethers";
import { logger } from "./logger";
import {
  CONFIG, RESERVES, AAVE_ORACLE, ORACLE_ABI, MULTICALL3, MULTICALL3_ABI,
} from "./config";
import type { PositionTracker } from "./positions";
import type { AaveOracle } from "./oracle";
import type { Evaluator } from "./evaluator";
import type { Executor } from "./executor";
import { metrics } from "./metrics";
import { SequencerFeedWatcher, type FeedHint } from "./sequencerFeed";
import { ModelErrorTracker } from "./modelError";
import { SVR_ROUND_TOPIC } from "./svrAtlas";
import type { LiquidationOpportunity } from "./types";

// Chainlink AggregatorInterface — roundId is uint256, NOT int256. The canonical
// signature decides the topic hash, so getting this wrong silently matches zero
// logs (topic 0xc947… instead of 0x0559…) and the whole engine goes quiet.
const ANSWER_UPDATED_IFACE = new ethers.Interface([
  "event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt)",
]);
const ANSWER_UPDATED_TOPIC = ANSWER_UPDATED_IFACE.getEvent("AnswerUpdated")!.topicHash;

// Accessors used to walk from an Aave price source down to the OCR aggregator
// that emits AnswerUpdated. Order matters: aggregator() identifies a Chainlink
// proxy, the two CAPO accessors identify an Aave price-cap adapter.
const FEED_WALK_FNS = ["aggregator", "ASSET_TO_USD_AGGREGATOR", "BASE_TO_USD_AGGREGATOR"] as const;
const FEED_WALK_IFACE = new ethers.Interface([
  "function aggregator() view returns (address)",
  "function ASSET_TO_USD_AGGREGATOR() view returns (address)",
  "function BASE_TO_USD_AGGREGATOR() view returns (address)",
]);
const FEED_WALK_MAX_DEPTH = 4;

// Chainlink rotates aggregators behind a proxy on upgrades; re-resolve
// periodically so a rotated feed doesn't silently stop delivering events.
const FEED_RERESOLVE_MS = 6 * 60 * 60_000;  // 6 hours

// Fire only when the locally-recomputed HF is genuinely below 1.0 — Aave's own
// liquidation threshold.
//
// This was 1.01, on the theory that the local estimate erred high and should
// submit at "the first plausible crossing". That reasoning belonged to the old
// model, which used stale cached breakdowns and static thresholds. The current
// model reads scaled balances against live indices and e-mode categories and
// agrees with getUserAccountData exactly given the same prices, so anything at
// or above 1.0 is simply not liquidatable: Aave reverts with
// HealthFactorNotBelowThreshold()
// after burning ~350k gas on the flashloan. Every fire in the first live run
// (HF 1.0007 … 1.0075) was a guaranteed revert for this reason.
//
// The pre-block edge is unaffected: prices from the sequencer feed are applied
// before the block lands, so a position crossing on that price is already below
// 1.0 here while competitors are still waiting for the log.
const TRIGGER_HF_CEILING = 10n ** 18n; // 1.0 — findLocalCandidates treats this as exclusive

// Dedupe window per borrower — a single price move can land as several feed
// events in the same block.
const FIRE_DEDUPE_MS = 2_000;

// Ceiling on a credible sequencer-feed head start. The feed sees a transmit as
// it is sequenced, so the lead is bounded by how long that takes to appear in a
// published block — a couple of Arbitrum blocks at most. Anything larger is a
// hint that never got its log, not a lead. Also bounds how long an unmatched
// hint may sit in feedSeenAt before it is discarded.
const MAX_PLAUSIBLE_FEED_LEAD_MS = 3_000;

// How long to trust a "not liquidatable" verdict from the chain, and how far the
// model health factor must move to override it early. 5 bps is well under the
// ~13 bps these positions would have to travel to cross, so a genuine move
// always re-confirms while a stationary one costs nothing.
const NOT_LIQUIDATABLE_COOLDOWN_MS = 30_000;
const NOT_LIQUIDATABLE_HF_DELTA    = 5n * 10n ** 14n;   // 0.0005 HF

// How long an SVR auction's announced price may stand in for the answer of the
// secondary-transmit log that follows it. The update lands within a block or two
// of the auction closing (about 2s), so anything older is some other update.
const SVR_HINT_MAX_AGE_MS = 10_000;

// Re-anchor the price estimates against the chain this often. SVR feeds emit no
// AnswerUpdated, so nothing else keeps the (price, answer) pair fresh between
// updates, and an anchor older than BASIS_MAX_AGE_MS is refused.
const BASIS_RESEED_MS = 4 * 60_000;

// One liquidation the bot would bundle into an SVR bid.
export interface SvrCandidate {
  opp:     LiquidationOpportunity;
  hfLocal: number;
  // Below 1.0 on the modelled post-update price: the bid may be sized on these.
  // Candidates at or above 1.0 are bonus items that may not be liquidatable.
  sure:    boolean;
}

interface BuiltOpp {
  key:     string;
  hfLocal: number;
  // The exact model health factor, captured at BUILD time. Two reasons it is
  // carried rather than derived from hfLocal: the confidence comparison used to
  // round-trip an exact bigint through a float and back, and confirmHealthFactors
  // overwrites pos.healthFactor in place, so by the time a confirmation returns
  // the original model value is gone — which is precisely the value the error
  // measurement needs.
  hfE18:   bigint;
  // True when ANY price feeding this position's health factor was inferred from
  // a Chainlink answer ratio rather than read from Aave's oracle. Such a health
  // factor is a prediction of what the chain will say, not a reading of it.
  usedEstimate: boolean;
  opp:     ReturnType<Evaluator["buildFromLocal"]>;
}

export class TriggerEngine {
  // aggregator address (lowercase) → reserve asset addresses (lowercase) it prices
  private feeds        = new Map<string, Set<string>>();
  private lastAnswers  = new Map<string, bigint>();   // feed → last raw answer (baseline for ratio)
  private firedAt      = new Map<string, number>();   // borrower → last dispatch ts (dedupe window)
  // feed → performance.now() when the sequencer feed reported it, cleared by the
  // matching log. The gap between the two IS the pre-block lead (trig.feedLead).
  private feedSeenAt   = new Map<string, number>();
  private refreshThrottle = new Map<string, number>();// asset → last forced-refresh ts
  // asset → an AUTHORITATIVE price together with the raw feed answer in force at
  // the block it was read at (reads are pinned to the event's block, so that
  // answer is the event's own). Estimates are then price × newAnswer / answer,
  // anchored to a real reading, instead of chaining off the previous estimate —
  // which is how a confirmation landing between two events used to leave the
  // cache one full update out of step with the ratio applied next.
  private basis = new Map<string, { price: bigint; answer: bigint; at: number }>();
  // Beyond this a basis is not trusted: CAPO ratio adapters drift slowly, so the
  // longer the anchor the larger the error that "cancels in the ratio" assumption
  // hides.
  private static readonly BASIS_MAX_AGE_MS = 10 * 60_000;
  // borrower → the chain said "not liquidatable" at this model health factor,
  // hold off re-confirming until this time unless the model figure moves.
  private notLiquidatable = new Map<string, { until: number; hf: bigint }>();
  // feed → the price its latest SVR auction announced. The secondary-transmit log
  // carries a round id but no price, so this is what lets the log be acted on
  // without a read round-trip.
  private svrAnswers = new Map<string, { answer: bigint; at: number }>();
  private reseedTimer: ReturnType<typeof setInterval> | null = null;

  // What the engine has actually seen. In trigger-only mode the heartbeat's
  // `liquidatable` counter is permanently zero — it is incremented by the
  // polling cycle, which no longer runs — so without these there is no way to
  // tell a trigger that is finding and correctly rejecting near-threshold
  // borrowers from one that has silently stopped looking.
  private statCandidates = 0;   // model put them under 1.0
  private statConfirmRejected = 0;  // chain disagreed
  private statFired = 0;

  triggerStats(): { candidates: number; rejected: number; fired: number } {
    return { candidates: this.statCandidates, rejected: this.statConfirmRejected, fired: this.statFired };
  }

  // Measured model-vs-chain disagreement, fed by every confirmation. Replaces
  // the hardcoded TRIGGER_CONFIRM_HF as the basis for the fire decision.
  readonly modelError = new ModelErrorTracker();

  // Model-vs-chain error measured from the POLLING SWEEP, where the model is fed
  // prices the cycle has just refreshed authoritatively.
  //
  // Kept strictly apart from modelError and deliberately NOT used by
  // shouldFireBlind. It reads near zero — 0.0 bps p50, under 1.2 bps worst —
  // because with fresh prices on both sides it measures arithmetic agreement,
  // which the bit-exact GenericLogic work already made near-perfect. The
  // trigger's real exposure is 4-11.5 bps, all of it price-path: staleness and
  // ratio estimates in the snapshot dispatch reads. Feeding these optimistic
  // samples into the fire decision would tell it that firing a hair under 1.0 is
  // safe when it is not, producing exactly the reverts confirmation exists to
  // prevent. Useful as a regression check on the arithmetic, nothing more.
  readonly arithmeticError = new ModelErrorTracker();

  private activeProvider: ethers.Provider | null = null;
  private logFilter: ethers.Filter | null = null;
  private reresolveTimer: ReturnType<typeof setInterval> | null = null;
  private seqFeed: SequencerFeedWatcher | null = null;

  constructor(
    private tracker:    PositionTracker,
    private oracle:     AaveOracle,
    private evaluator:  Evaluator,
    private executor:   Executor,
    private getGasPrice: () => bigint,
    private canFire:     () => boolean,
    private getProvider: () => ethers.Provider,       // WS — used only for log subscriptions
    private getReadProvider: () => ethers.Provider,   // HTTP — used for all eth_call reads
  ) {}

  // Resolve each reserve's underlying Chainlink aggregator, then subscribe to
  // AnswerUpdated on all of them.
  async start(): Promise<void> {
    if (!CONFIG.triggerEnabled) {
      logger.info("Trigger engine disabled (TRIGGER_ENABLED=false)");
      return;
    }
    try {
      this.feeds = await this.resolveFeeds();
    } catch (e: any) {
      logger.warn(`Trigger engine: feed resolution failed (${e?.message ?? e}) — running poll-only`);
      return;
    }
    if (this.feeds.size === 0) {
      logger.warn("Trigger engine: no resolvable Chainlink feeds — running poll-only");
      return;
    }
    await this.subscribe(this.getProvider());
    logger.info(`Trigger engine: watching ${this.feeds.size} Chainlink aggregators for AnswerUpdated`);

    // Anchor the price estimates to the chain now, rather than waiting for the
    // first event per feed. SVR feeds never emit AnswerUpdated, so without this
    // they would have no anchor at all.
    await this.seedBasis().catch(e => logger.debug(`Trigger engine: basis seed failed: ${e?.message ?? e}`));
    if (this.reseedTimer === null) {
      this.reseedTimer = setInterval(() => {
        this.seedBasis().catch(e => logger.debug(`Trigger engine: basis reseed failed: ${e?.message ?? e}`));
      }, BASIS_RESEED_MS);
    }

    if (this.reresolveTimer === null) {
      this.reresolveTimer = setInterval(() => {
        this.reresolveFeeds().catch(e => logger.debug(`Feed re-resolve failed: ${e?.message ?? e}`));
      }, FEED_RERESOLVE_MS);
    }

    this.startSequencerFeed();
  }

  // ── Sequencer feed accelerator ─────────────────────────────────────────────
  // Optional pre-block signal. The log subscription above stays authoritative;
  // this only lets us act earlier when it works.
  private startSequencerFeed(): void {
    if (!CONFIG.sequencerFeedEnabled) return;
    this.seqFeed = new SequencerFeedWatcher(CONFIG.sequencerFeedUrl, hint => this.onFeedHint(hint));
    this.seqFeed.setWatchedFeeds(this.feeds.keys());
    this.seqFeed.start();
  }

  // A transmit() for a watched aggregator was just sequenced — ahead of the
  // block that will carry it.
  private onFeedHint(hint: FeedHint): void {
    const assets = this.feeds.get(hint.feed);
    if (!assets || assets.size === 0) return;

    // Dedupe against the log path: whichever arrives first wins, the other is a
    // no-op. The feed normally wins, which is the entire point.
    const prev = this.lastAnswers.get(hint.feed) ?? null;
    if (hint.answer !== null && hint.answer > 0n) {
      if (prev !== null && prev === hint.answer) return;   // already processed
      if (prev !== null && prev > 0n) {
        const touched = new Set<string>();
        for (const asset of assets) {
          const est = this.estimate(asset, hint.answer, prev);
          if (est === null) continue;
          this.oracle.pokePrice(asset, est);
          touched.add(asset);
        }
        this.lastAnswers.set(hint.feed, hint.answer);
        if (touched.size > 0) {
          // Was `metrics.record("trig.feedLead", 1)` — a constant, so the
          // reporter dutifully printed p50=1ms p95=1ms max=1ms forever and told
          // us nothing about the one thing this metric exists to measure: how
          // far ahead of the block the sequencer feed actually saw the price.
          // That lead is what justifies the whole sequencer-feed path, so
          // record the real figure and let it be judged.
          const seenNow = performance.now();
          // Drop hints whose log never arrived, so they cannot be paired with a
          // much later one and reported as an implausible lead.
          for (const [f, t] of this.feedSeenAt) {
            if (seenNow - t > MAX_PLAUSIBLE_FEED_LEAD_MS) this.feedSeenAt.delete(f);
          }
          this.feedSeenAt.set(hint.feed, seenNow);
          logger.debug(`⚡⚡ Sequencer feed: pre-block price for ${hint.feed.slice(0, 10)}… — dispatching early`);
          this.dispatch(touched);
          return;
        }
      } else {
        this.lastAnswers.set(hint.feed, hint.answer);
      }
    }

    // No usable answer — we still know this feed is moving. Re-evaluate the
    // affected positions at the current cached price so anything already at the
    // edge is submitted now rather than after the block lands.
    this.dispatch(new Set(assets));
  }

  // Re-subscribe after a WS reconnect (aggregator set itself is static between
  // re-resolves, so only the socket changes here).
  attach(provider: ethers.Provider): void {
    if (!CONFIG.triggerEnabled || this.feeds.size === 0) return;
    this.unsubscribe();
    this.subscribe(provider).catch(e =>
      logger.warn(`Trigger engine: re-subscribe failed: ${e?.message ?? e}`)
    );
  }

  private unsubscribe(): void {
    if (!this.activeProvider || !this.logFilter) return;
    // ethers v6 off() is async; a rejection here is never actionable (the old
    // socket is usually already destroyed), so swallow it explicitly rather
    // than leaving an unhandled rejection.
    try {
      const r = this.activeProvider.off(this.logFilter, this._onLog) as unknown;
      if (r && typeof (r as Promise<void>).catch === "function") (r as Promise<void>).catch(() => {});
    } catch { /* ignore */ }
    this.activeProvider = null;
    this.logFilter = null;
  }

  // provider.on() is ASYNC in ethers v6 — it returns a Promise that rejects if
  // eth_subscribe fails. A synchronous try/catch around it catches nothing and
  // the failure surfaces as an unhandled rejection instead.
  private async subscribe(provider: ethers.Provider): Promise<void> {
    // Two topics, OR-ed: a public transmit emits AnswerUpdated, but an SVR
    // (auction) transmit emits SVR_ROUND_TOPIC instead. Aave reads SVR feeds, so
    // listening for AnswerUpdated alone leaves the bot blind to every price move
    // that lands through an auction.
    const filter: ethers.Filter = {
      address: [...this.feeds.keys()],
      topics:  [[ANSWER_UPDATED_TOPIC, SVR_ROUND_TOPIC]],
    };
    try {
      await provider.on(filter, this._onLog);
      this.activeProvider = provider;
      this.logFilter = filter;
      logger.info("Trigger engine: subscribed to AnswerUpdated aggregator events");
    } catch (e: any) {
      logger.warn(`Trigger engine: subscription failed: ${e?.message ?? e}`);
    }
  }

  // ── Feed resolution ────────────────────────────────────────────────────────

  private async resolveFeeds(): Promise<Map<string, Set<string>>> {
    const provider    = this.getReadProvider();
    const mc          = new ethers.Contract(MULTICALL3, MULTICALL3_ABI, provider);
    const oracleIface = new ethers.Interface(ORACLE_ABI);
    const assets      = Object.values(RESERVES);

    // Step 1 — asset → Aave price source (proxy or CAPO adapter)
    const srcResults: Array<{ success: boolean; returnData: string }> = await mc.tryAggregate(
      false,
      assets.map(r => ({
        target:   AAVE_ORACLE,
        callData: oracleIface.encodeFunctionData("getSourceOfAsset", [r.address]),
      })),
    );

    // assetLower → address currently being walked
    let frontier = new Map<string, string>();
    for (let i = 0; i < assets.length; i++) {
      const r = srcResults[i];
      if (!r?.success || r.returnData === "0x") continue;
      try {
        const src = oracleIface.decodeFunctionResult("getSourceOfAsset", r.returnData)[0] as string;
        if (src && src !== ethers.ZeroAddress) frontier.set(assets[i]!.address.toLowerCase(), src);
      } catch { /* unresolvable source */ }
    }

    const feeds = new Map<string, Set<string>>();
    const addFeed = (node: string, asset: string) => {
      const key = node.toLowerCase();
      let set = feeds.get(key);
      if (!set) { set = new Set(); feeds.set(key, set); }
      set.add(asset);
    };

    // Step 2 — walk each source down to a node that exposes none of the
    // forwarding accessors. That terminal node is the OCR aggregator.
    for (let depth = 0; depth < FEED_WALK_MAX_DEPTH && frontier.size > 0; depth++) {
      const nodes = [...new Set(frontier.values())];
      const calls = nodes.flatMap(node =>
        FEED_WALK_FNS.map(fn => ({ target: node, callData: FEED_WALK_IFACE.encodeFunctionData(fn, []) })),
      );
      const results: Array<{ success: boolean; returnData: string }> = await mc.tryAggregate(false, calls);

      const child = new Map<string, string>();  // node → next node in the walk
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i]!;
        for (let k = 0; k < FEED_WALK_FNS.length; k++) {
          const r = results[i * FEED_WALK_FNS.length + k];
          if (!r?.success || r.returnData === "0x") continue;
          try {
            const next = FEED_WALK_IFACE.decodeFunctionResult(FEED_WALK_FNS[k]!, r.returnData)[0] as string;
            if (!next || next === ethers.ZeroAddress) continue;
            if (next.toLowerCase() === node.toLowerCase()) continue;  // self-reference guard
            child.set(node, next);
            break;  // aggregator() first — a proxy is never also a CAPO adapter
          } catch { /* not this accessor */ }
        }
      }

      const nextFrontier = new Map<string, string>();
      for (const [asset, node] of frontier) {
        const next = child.get(node);
        if (next) nextFrontier.set(asset, next);
        else addFeed(node, asset);   // terminal — this is the event emitter
      }
      frontier = nextFrontier;
    }

    // Anything still walking at max depth: use whatever we reached. Better to
    // subscribe to a probably-wrong address than to drop the asset silently.
    for (const [asset, node] of frontier) addFeed(node, asset);

    const covered = [...feeds.values()].reduce((n, s) => n + s.size, 0);
    logger.info(
      `Trigger engine: resolved ${covered}/${assets.length} reserves to ${feeds.size} distinct aggregators`
    );
    return feeds;
  }

  // Periodic re-resolution — picks up Chainlink aggregator rotations. Only
  // re-subscribes when the aggregator set actually changed.
  private async reresolveFeeds(): Promise<void> {
    const fresh = await this.resolveFeeds();
    if (fresh.size === 0) return;
    const before = [...this.feeds.keys()].sort().join(",");
    const after  = [...fresh.keys()].sort().join(",");
    this.feeds = fresh;
    if (before === after) return;
    logger.info("Trigger engine: aggregator set changed — re-subscribing");
    const provider = this.activeProvider ?? this.getProvider();
    this.unsubscribe();
    await this.subscribe(provider);
    this.seqFeed?.setWatchedFeeds(this.feeds.keys());
  }

  // ── SVR support ────────────────────────────────────────────────────────────

  // Anchor every asset's (Aave price, raw feed answer) pair to ONE block. Both
  // reads go through a single Multicall3 call, so they describe the same state.
  // An estimate is then basis.price × newAnswer / basis.answer, which for a
  // direct feed is exactly the new answer and for a CAPO-wrapped asset carries the
  // slowly-moving exchange rate along unchanged.
  private async seedBasis(): Promise<void> {
    if (this.feeds.size === 0) return;
    const t0 = Date.now();
    const mc = new ethers.Contract(MULTICALL3, MULTICALL3_ABI, this.getReadProvider());
    const oracleIface = new ethers.Interface(ORACLE_ABI);
    const answerIface = new ethers.Interface(["function latestAnswer() view returns (int256)"]);

    const calls: Array<{ target: string; callData: string }> = [];
    const meta:  Array<{ feed: string; asset?: string }> = [];
    for (const [feed, assets] of this.feeds) {
      calls.push({ target: feed, callData: answerIface.encodeFunctionData("latestAnswer", []) });
      meta.push({ feed });
      for (const asset of assets) {
        calls.push({ target: AAVE_ORACLE, callData: oracleIface.encodeFunctionData("getAssetPrice", [asset]) });
        meta.push({ feed, asset });
      }
    }
    const res: Array<{ success: boolean; returnData: string }> = await mc.tryAggregate(false, calls);

    const answers = new Map<string, bigint>();
    for (let i = 0; i < calls.length; i++) {
      const m = meta[i]!;
      const r = res[i];
      if (m.asset !== undefined || !r?.success || r.returnData === "0x") continue;
      try {
        const a = BigInt(answerIface.decodeFunctionResult("latestAnswer", r.returnData)[0]);
        if (a > 0n) answers.set(m.feed, a);
      } catch { /* feed without latestAnswer */ }
    }
    let seeded = 0;
    for (let i = 0; i < calls.length; i++) {
      const m = meta[i]!;
      const r = res[i];
      if (m.asset === undefined || !r?.success || r.returnData === "0x") continue;
      const answer = answers.get(m.feed);
      if (answer === undefined) continue;
      try {
        const price = BigInt(oracleIface.decodeFunctionResult("getAssetPrice", r.returnData)[0]);
        if (price <= 0n) continue;
        // An event that landed while this call was in flight produced a fresher
        // anchor, pinned to its own block. Never overwrite that with this.
        const existing = this.basis.get(m.asset);
        if (existing && existing.at >= t0) continue;
        this.basis.set(m.asset, { price, answer, at: Date.now() });
        seeded++;
      } catch { /* undecodable price */ }
    }
    for (const [feed, answer] of answers) {
      if (!this.lastAnswers.has(feed)) this.lastAnswers.set(feed, answer);
    }
    logger.debug(`Trigger engine: anchored ${seeded} price estimates to the chain`);
  }

  // Remember the price an SVR auction announced for `feed`, so the secondary
  // transmit log that follows can be acted on without a read round-trip.
  noteSvrAnswer(feed: string, answer: bigint): void {
    this.svrAnswers.set(feed.toLowerCase(), { answer, at: Date.now() });
  }

  // Liquidations that would become available if `feed` moved to `answer`. Pure
  // computation over the in-memory model: nothing is written to the price cache,
  // and nothing is fired.
  //
  // The price is deliberately kept OUT of the shared cache. It is not on-chain
  // yet, and every other path in this engine treats a cached price as something
  // the chain holds; poking it in would send the public executor after positions
  // Aave's oracle still says are healthy, which is precisely the revert this
  // whole SVR path exists to avoid. Null when the feed is unknown or no asset
  // behind it has an anchor to estimate from.
  svrPreview(feed: string, answer: bigint, gasPrice: bigint): { candidates: SvrCandidate[]; ethPrice: number } | null {
    const assets = this.feeds.get(feed.toLowerCase());
    if (!assets || assets.size === 0 || answer <= 0n) return null;

    const prev   = this.lastAnswers.get(feed.toLowerCase()) ?? null;
    const prices = this.oracle.snapshotAllPrices();
    const touched = new Set<string>();
    for (const asset of assets) {
      const est = this.estimate(asset, answer, prev);
      if (est === null) continue;
      prices.set(asset, est);
      touched.add(asset);
    }
    if (touched.size === 0) return null;

    const ceiling = BigInt(Math.round(Math.max(1, CONFIG.svrScanCeiling) * 1e18));
    const found   = this.tracker.findLocalCandidates(touched, prices, ceiling, 32, true);
    if (found.length === 0) return { candidates: [], ethPrice: this.evaluator.ethPriceCached() || 3000 };

    const ethPrice = this.evaluator.ethPriceCached() || 3000;
    const out: SvrCandidate[] = [];
    for (const c of found) {
      const opp = this.evaluator.buildFromLocal(c.pos, c.collaterals, c.debts, prices, gasPrice, ethPrice);
      if (!opp) continue;
      out.push({ opp, hfLocal: c.hfLocal, sure: c.pos.healthFactor < TRIGGER_HF_CEILING });
    }
    out.sort((a, b) => b.opp.netProfitUsd - a.opp.netProfitUsd);
    return { candidates: out, ethPrice };
  }

  // ── Hot path ───────────────────────────────────────────────────────────────

  // Arrow property so `this` binds correctly as a provider listener.
  private _onLog = async (log: ethers.Log): Promise<void> => {
    try {
      if (log.removed) return;
      const feed   = log.address.toLowerCase();
      const assets = this.feeds.get(feed);
      if (!assets || assets.size === 0) return;

      // The authoritative log for a price the sequencer feed already gave us:
      // the elapsed time is exactly how much head start that path bought.
      //
      // Only if the two genuinely correspond. A hint whose transmit never landed
      // — dropped, re-orged, or a decode that did not match — leaves an entry
      // that the NEXT log for that feed then pairs with, minutes later. That is
      // how this metric reported max=89784ms: a 90-second "head start" on a
      // chain with 250ms blocks, which is not a lead, it is a stale entry. A
      // real pre-block lead cannot exceed a block time by much, so anything
      // past the ceiling is discarded rather than recorded.
      const seenAt = this.feedSeenAt.get(feed);
      if (seenAt !== undefined) {
        const lead = performance.now() - seenAt;
        this.feedSeenAt.delete(feed);
        if (lead <= MAX_PLAUSIBLE_FEED_LEAD_MS) metrics.record("trig.feedLead", lead);
      }

      let current: bigint;
      if (log.topics[0] === SVR_ROUND_TOPIC) {
        // An auction transmit's log has a round id and no price. The auction
        // announced the price moments ago; use it as the estimate input when it
        // is fresh, else leave the answer unknown and take the read path below.
        const hint = this.svrAnswers.get(feed);
        current = hint && Date.now() - hint.at < SVR_HINT_MAX_AGE_MS ? hint.answer : 0n;
      } else {
        const parsed = ANSWER_UPDATED_IFACE.parseLog({ topics: log.topics as string[], data: log.data });
        if (!parsed) return;
        current = BigInt(parsed.args[0]);
      }

      const prev = this.lastAnswers.get(feed) ?? null;
      // A zero means "price unknown", never a real answer: storing it would wipe
      // the baseline every later ratio is computed from.
      if (current > 0n) this.lastAnswers.set(feed, current);

      // Fast path: cached Aave price × raw-answer ratio. Every asset behind this
      // aggregator moves proportionally (a CAPO ratio adapter multiplies by a
      // slow-moving LST exchange rate, which cancels in the ratio).
      const touched = new Set<string>();
      const estimated: string[]   = [];
      const needsConfirm: string[] = [];
      const block = log.blockNumber;

      for (const asset of assets) {
        const est = current > 0n ? this.estimate(asset, current, prev) : null;
        if (est !== null) {
          // pokePrice refuses when an authoritative read at this block or later
          // is already cached; the asset still counts as touched (its price is
          // current) but needs no further confirmation.
          if (this.oracle.pokePrice(asset, est, block)) estimated.push(asset);
          touched.add(asset);
        } else {
          needsConfirm.push(asset);
        }
      }

      // Slow path: no usable baseline for these assets — they need an
      // authoritative read before they can contribute to a local HF. Batched:
      // this aggregator may back six reserves, and six separate getAssetPrice
      // calls per event would dominate the rate-limit budget during volatility.
      if (needsConfirm.length > 0) {
        const confirmed = await this.throttledRefreshMany(needsConfirm, block, current);
        for (const [a, p] of confirmed) if (p > 0n) touched.add(a);
      }

      if (touched.size === 0) return;

      // Dispatch on the estimates FIRST — the whole point is to act before a
      // confirmation round-trip. The confirmation runs behind it and corrects
      // the cache for the next event.
      this.dispatch(touched, block);
      if (estimated.length > 0) this.throttledRefreshMany(estimated, block, current).catch(() => {});
    } catch { /* never throw from a log handler */ }
  };

  // New Aave price for `asset` given the feed's new raw answer.
  // Preferred: anchor to the last authoritative reading (price × new / answerAtRead).
  // Fallback: chain off the cached price using the previous answer. null when
  // neither is available, meaning the asset needs an authoritative read.
  private estimate(asset: string, answer: bigint, prevAnswer: bigint | null): bigint | null {
    const b = this.basis.get(asset);
    if (b && b.answer > 0n && Date.now() - b.at < TriggerEngine.BASIS_MAX_AGE_MS) {
      const est = (b.price * answer) / b.answer;
      if (est > 0n) return est;
    }
    if (prevAnswer !== null && prevAnswer > 0n) {
      const cached = this.oracle.peekPrice(asset);
      if (cached !== null && cached > 0n) return (cached * answer) / prevAnswer;
    }
    return null;
  }

  // Batched authoritative refresh with a per-asset throttle, PINNED to the
  // block of the event that prompted it. Assets still inside their throttle
  // window are served from cache and cost nothing; the rest go out as ONE
  // multicall on the hot provider. When the read lands on exactly the event's
  // block, the result is recorded as the new estimation basis together with the
  // answer that event carried.
  private async throttledRefreshMany(
    assets: string[], block?: number, answer?: bigint,
  ): Promise<Array<readonly [string, bigint]>> {
    const now = Date.now();
    const out: Array<readonly [string, bigint]> = [];
    const toFetch: string[] = [];

    for (const asset of assets) {
      const last = this.refreshThrottle.get(asset) ?? 0;
      if (now - last < 500) out.push([asset, this.oracle.peekPrice(asset) ?? 0n] as const);
      else { this.refreshThrottle.set(asset, now); toFetch.push(asset); }
    }

    if (toFetch.length > 0) {
      try {
        const { block: readBlock, prices } = await this.oracle.refreshPrices(toFetch, block);
        const pinned = block !== undefined && readBlock === block && answer !== undefined && answer > 0n;
        for (const asset of toFetch) {
          const p = prices.get(asset) ?? 0n;
          out.push([asset, p] as const);
          if (pinned && p > 0n) this.basis.set(asset, { price: p, answer: answer!, at: Date.now() });
        }
      } catch {
        for (const asset of toFetch) out.push([asset, this.oracle.peekPrice(asset) ?? 0n] as const);
      }
    }
    return out;
  }

  // Pure-computation hot path: snapshot prices → find crossed positions → build
  // and submit opportunities. No RPC before submission.
  private dispatch(assetsLower: Set<string>, block?: number): void {
    if (!this.canFire()) return;

    const stop = metrics.startTimer("trig.dispatch");
    try {
      // snapshotAllPrices reads the same cache _onLog just poked, so the
      // estimated prices are already in here.
      const prices = this.oracle.snapshotAllPrices();

      // No blanket dormant wake here. findLocalCandidates evaluates dormant
      // positions straight from the in-memory model and reactivates only the
      // ones that actually cross the ceiling.
      //
      // The old call woke EVERY dormant holder of the moved asset on EVERY
      // feed update, up or down. With ETH/USD updating about once a minute and
      // pricing six reserves, that churned thousands of positions back into the
      // active set for nothing and defeated the dormant tier outright.
      // Scan ABOVE 1.0 deliberately. The model's error runs in both directions,
      // so a borrower genuinely under 1.0 can be modelled just above it; cutting
      // candidate generation at exactly 1.0 discarded those before anything
      // could look at them. Everything between 1.0 and the scan ceiling is
      // routed to confirmation — shouldFireBlind rejects anything at or above
      // 1.0 outright — so only an authoritative chain read gets one through.
      const scanCeiling = BigInt(Math.round(Math.max(1, CONFIG.triggerScanCeiling) * 1e18));
      // 32, ranked by value inside findLocalCandidates: building is pure CPU and
      // the profit sort below picks what the scarce executor slots go to. Cutting
      // to the 10 lowest health factors first let dust crowd out the big ones.
      const candidates = this.tracker.findLocalCandidates(assetsLower, prices, scanCeiling, 32);

      // Audit BEFORE the early return below. This sits here and not further down
      // for a reason that cost a whole run to learn: findLocalCandidates only
      // returns positions already under 1.0, so on a healthy book it returns
      // nothing and dispatch exits immediately. Placed after that return, the
      // audit was unreachable on exactly the days when nothing is liquidatable —
      // which is most of them — and model-err stayed at zero samples while
      // arith-err filled to 500. The measurement that gates blind firing must not
      // depend on there being something to fire at.
      if (Math.random() < CONFIG.triggerAuditRate) this.auditSample();

      if (candidates.length === 0) return;

      for (const c of candidates) {
        if (c.pos.healthFactor < TRIGGER_HF_CEILING) this.statCandidates++;
      }

      const gasPrice = this.getGasPrice();
      const ethPrice = this.evaluator.ethPriceCached() || 3000; // gas-cost input only

      const now = Date.now();

      // Build EVERY opportunity first, then dispatch most-profitable-first.
      //
      // findLocalCandidates returns candidates ordered by health factor, which
      // is the wrong order to spend a scarce executor slot on: a single price
      // move produced $0.89, $2.34, $954.00, $22.85 and $155.34 simultaneously,
      // and firing in HF order burned all three slots before reaching the large
      // ones. Building an opportunity is pure computation, so ordering by value
      // costs nothing.
      const built: BuiltOpp[] = [];
      for (const cand of candidates) {
        const key = cand.pos.address;
        const lastFire = this.firedAt.get(key);
        if (lastFire && now - lastFire < FIRE_DEDUPE_MS) continue;  // dedupe multi-feed bursts

        // Skip borrowers the chain recently reported as not liquidatable, unless
        // their model health factor has actually moved since. The escape hatch is
        // what makes this safe: prices moving is the only way one of these can
        // cross, and that necessarily changes the model figure.
        const nl = this.notLiquidatable.get(key);
        if (nl) {
          if (now >= nl.until) {
            this.notLiquidatable.delete(key);
          } else if (cand.pos.healthFactor >= TRIGGER_HF_CEILING) {
            // Only a position the model still puts AT OR ABOVE the threshold may
            // be suppressed. Gating on movement alone was wrong and a brute-force
            // check caught it: a borrower recorded at 1.0000 that falls to 0.9996
            // has moved four basis points — under any sane delta — yet it has
            // crossed, and suppressing it would discard the exact event this
            // engine exists to catch. Anything the model now reads below 1.0 goes
            // to confirmation regardless of how little it moved.
            const moved = cand.pos.healthFactor > nl.hf
              ? cand.pos.healthFactor - nl.hf
              : nl.hf - cand.pos.healthFactor;
            if (moved < NOT_LIQUIDATABLE_HF_DELTA) continue;
          }
        }

        // Captured before buildFromLocal or any later confirmation can mutate it.
        const hfE18 = cand.pos.healthFactor;
        const usedEstimate = this.oracle.anyEstimated([
          ...cand.collaterals.map(c => c.address),
          ...cand.debts.map(d => d.address),
        ]);

        const opp = this.evaluator.buildFromLocal(
          cand.pos, cand.collaterals, cand.debts, prices, gasPrice, ethPrice,
        );
        if (!opp) continue;
        built.push({ key, hfLocal: cand.hfLocal, hfE18, usedEstimate, opp });
      }
      built.sort((a, b) => b.opp!.netProfitUsd - a.opp!.netProfitUsd);

      // Split by confidence — see shouldFireBlind for the decision rule. The
      // old split was a single hardcoded health-factor cut applied to every
      // candidate regardless of what it was worth; a $954 opportunity and a
      // $0.89 one were treated identically even though a revert costs the same
      // couple of cents in both cases.
      const confident: BuiltOpp[] = [];
      const marginal:  BuiltOpp[] = [];
      for (const b of built) (this.shouldFireBlind(b) ? confident : marginal).push(b);

      const fired = this.fireAll(confident, now);
      if (marginal.length > 0) {
        // Claim the dedupe window BEFORE the confirmation round-trip. firedAt is
        // documented as "last dispatch ts", but only fireAll was writing it, so a
        // borrower sent for confirmation stayed unmarked for the whole ~50-100ms
        // the multicall took. Any feed event arriving in that window rebuilt the
        // same candidate and issued a second confirmation for it — observed live
        // as the identical LINK/LINK evaluation twice, 31ms apart. Marking here
        // costs nothing when the candidate survives, since fireAll refreshes the
        // timestamp on the way out.
        for (const m of marginal) this.firedAt.set(m.key, now);
        this.confirmThenFire(marginal, now, block);
      }


      this.pruneFiredAt(now);
      logger.debug(
        `trigger: ${candidates.length} local candidates, ${fired} fired immediately, ` +
        `${marginal.length} awaiting confirmation`
      );
    } finally {
      stop();
    }
  }

  // Should this opportunity be fired without an authoritative confirmation?
  //
  // Two quantities decide it, and neither is a fixed health-factor cut.
  //
  // 1. How likely the fire is to LAND. A blind fire at localHF succeeds exactly
  //    when localHF·(1+e) < 1, i.e. when the model error e is below the headroom
  //    1/localHF − 1. ModelErrorTracker holds the empirical distribution of e
  //    measured from real confirmations, so that probability is read directly
  //    rather than assumed.
  //
  // 2. What a miss actually costs. On Arbitrum a revert is ~350k gas — cents —
  //    against bonuses in dollars, so on pure expected value a large opportunity
  //    is worth firing at surprisingly low confidence. What makes reverts
  //    genuinely expensive is not the gas but the executor slot: with only
  //    maxConcurrentExecutions in flight, a reverting transaction during a
  //    cascade displaces a real liquidation. That cost is zero when the executor
  //    is idle and severe when it is saturated, so it is priced from live
  //    occupancy instead of being baked into a constant.
  //
  // Fire blind when P(land) clears the break-even probability
  //     cost / (net + cost),  cost = gas + slotPressure·net
  // which collapses to "almost always" for a valuable opportunity on an idle
  // executor, and to "confirm first" for a marginal one when slots are scarce.
  private shouldFireBlind(b: BuiltOpp): boolean {
    const hfLocal = b.hfLocal;
    // At or above Aave's own threshold nothing is liquidatable, so a blind fire
    // is a guaranteed revert. Candidates up here exist only because the scan
    // ceiling deliberately reaches past 1.0 to catch positions the model reads
    // high; they belong to the confirmation path, never to this one.
    if (!(hfLocal > 0) || b.hfE18 >= TRIGGER_HF_CEILING) return false;

    // Never commit gas on a price the chain has not confirmed.
    //
    // The first live fire made this concrete. The model read HF 0.9971 from a
    // ratio-estimated price and fired without confirming; the transaction landed
    // at block 503713360 and reverted inside validateLiquidationCall, and a
    // competitor liquidated the same borrower five blocks later. Being FIRST and
    // still failing rules out losing a race: Aave's oracle simply had not crossed
    // yet at our block. The estimate was a prediction of a price the chain did
    // not hold, and liquidationCall is evaluated against the price it does hold.
    //
    // The estimate is confirmed within about a second by throttledRefreshMany, so
    // this costs the blind path only on the very first tick after a feed moves —
    // exactly the tick where the model is guessing. Everything after it still
    // fires blind at full speed.
    if (b.usedEstimate && CONFIG.triggerRequireConfirmedPrice) return false;

    // Absolute rail, independent of statistics. A degenerate sample window
    // (every observation identical, say) must not be able to authorise a fire
    // arbitrarily close to the threshold.
    if (hfLocal > CONFIG.triggerBlindMaxHf) return false;

    const headroom = 1 / hfLocal - 1;
    const pLand = this.modelError.cdf(headroom);
    if (pLand === null) {
      // Too few samples to trust the distribution — fall back to the static
      // threshold this mechanism replaces.
      return hfLocal < CONFIG.triggerConfirmHf;
    }

    const net = Math.max(b.opp!.netProfitUsd, 0);
    if (net <= 0) return false;
    const gas = Math.max(b.opp!.gasCostUsd, 0.01);
    const slotPressure = CONFIG.maxConcurrentExecutions > 0
      ? Math.min(1, this.executor.inFlightCount / CONFIG.maxConcurrentExecutions)
      : 0;
    const costOfRevert = gas + slotPressure * net;
    const breakEvenP   = costOfRevert / (net + costOfRevert);

    return pLand >= breakEvenP;
  }

  // Confirm one near-threshold position purely to record an error sample.
  // Never fires anything.
  //
  // This used to sample only from candidates that had just been fired blind,
  // which sounds right and is useless in practice: firing requires crossing 1.0,
  // that is rare, and the result was ONE sample in thirteen hours of live
  // running — far short of the 30 the distribution needs before it may be
  // trusted, so the engine stayed pinned to the fallback constant forever.
  //
  // It now samples the closest-to-threshold positions the dispatch evaluated,
  // whether or not any of them crossed. Those are computed from the same price
  // snapshot the fire decision reads, so they measure the right quantity, and
  // they exist on every dispatch rather than only on the rare ones that fire.
  private auditSample(): void {
    const pool = this.tracker.takeLocalEvalSamples();
    if (pool.length === 0) return;
    const pick = pool[Math.floor(Math.random() * pool.length)]!;
    this.tracker.confirmHealthFactors([pick.addr])
      .then(confirmed => {
        const hf = confirmed.get(pick.addr);
        if (hf !== undefined) this.modelError.record(pick.hf, hf);
      })
      .catch(() => { /* sampling is best-effort */ });
  }

  // Dispatch a pre-sorted list, respecting executor capacity.
  private fireAll(built: BuiltOpp[], now: number): number {
    let fired = 0;
    for (let i = 0; i < built.length; i++) {
      const { key, hfLocal, opp } = built[i]!;
        // Check capacity BEFORE announcing. Previously every candidate logged
        // "firing" and the executor then silently dropped the ones over capacity,
        // so the log claimed to be acting on opportunities it never submitted.
        if (this.executor.isExecuting) {
          logger.warn(
            `  → executor at capacity (${this.executor.inFlightCount}/${CONFIG.maxConcurrentExecutions}) — ` +
            `${built.length - i} lower-value opportunities dropped this tick`
          );
          break;
        }
        this.firedAt.set(key, now);
        fired++;
        this.statFired++;
        logger.info(
          `⚡ Trigger: ${key.slice(0,10)}… localHF=${hfLocal.toFixed(4)} ` +
          `${opp!.collateralSymbol}->>${opp!.debtSymbol} net=$${opp!.netProfitUsd.toFixed(2)} — firing`
        );
      // Executor still enforces cooldown / in-flight guards internally.
      this.executor.execute(opp!).catch(e =>
        logger.error(`Trigger exec error: ${e?.shortMessage ?? e?.message ?? e}`)
      );
    }
    return fired;
  }

  // Marginal candidates: confirm against Aave's own getUserAccountData before
  // committing gas. Anything the chain reports at or above 1.0 is dropped —
  // liquidationCall would revert with HealthFactorNotBelowThreshold().
  private confirmThenFire(marginal: BuiltOpp[], now: number, block?: number): void {
    const addresses = marginal.map(m => m.key);
    // dispatch() claimed the dedupe window for these before the round-trip. A
    // verdict of "not liquidatable" (or no verdict at all) must not keep it: the
    // next feed event may be the one that genuinely crosses, and blocking it for
    // FIRE_DEDUPE_MS forfeits a race that is decided in milliseconds. fireAll
    // re-stamps the ones that do go out.
    const release = () => { for (const m of marginal) this.firedAt.delete(m.key); };
    this.tracker.confirmHealthFactors(addresses, block)
      .then(confirmed => {
        release();
        // Every confirmation is a free, perfectly-matched observation of how far
        // the model was from the chain. This is the only place such pairs exist,
        // and they used to be discarded the moment the fire/skip decision was made.
        for (const m of marginal) {
          const hf = confirmed.get(m.key);
          if (hf !== undefined) this.modelError.record(m.hfE18, hf);
        }

        // An empty result means the multicall failed, not that every candidate
        // is healthy. Silently dropping the whole batch at debug level hid that
        // completely — and RPC backpressure makes it reachable during exactly
        // the load spike a cascade produces.
        if (confirmed.size === 0 && marginal.length > 0) {
          logger.warn(
            `trigger: confirmation returned nothing for ${marginal.length} marginal ` +
            `candidate(s) — dropping them unfired (RPC failure or shed call)`
          );
          return;
        }
        if (!this.canFire()) return;
        const survivors: BuiltOpp[] = [];
        for (const m of marginal) {
          const hf = confirmed.get(m.key);
          if (hf === undefined) continue;             // unknown — do not gamble gas
          if (hf >= 10n ** 18n) {
            // Remember the verdict. These positions are not transient: a live
            // run showed the same four borrowers at chain HF 1.0002-1.0014
            // being re-confirmed on every dispatch that touched their assets,
            // for ten minutes straight, each one costing a multicall to reach
            // the answer already known. A health factor only moves when prices
            // move or interest accrues, so an unchanged model figure cannot
            // have crossed.
            this.statConfirmRejected++;
            this.notLiquidatable.set(m.key, { until: Date.now() + NOT_LIQUIDATABLE_COOLDOWN_MS, hf: m.hfE18 });
            logger.debug(
              `  trigger: ${m.key.slice(0,10)}… localHF=${m.hfLocal.toFixed(4)} but chain HF=` +
              `${(Number(hf) / 1e18).toFixed(6)} — not liquidatable, skipping`
            );
            continue;
          }
          this.notLiquidatable.delete(m.key);
          survivors.push(m);
        }
        if (survivors.length > 0) this.fireAll(survivors, Date.now());
      })
      .catch(e => { release(); logger.debug(`trigger confirm failed: ${e?.message ?? e}`); });
  }

  // firedAt only exists to dedupe within FIRE_DEDUPE_MS; without this it grows
  // one entry per borrower ever triggered and never shrinks.
  private pruneFiredAt(now: number): void {
    // The not-liquidatable map is keyed the same way and expires on its own
    // schedule; sweep it here so it cannot grow one entry per borrower ever seen.
    for (const [k, v] of this.notLiquidatable) {
      if (now >= v.until) this.notLiquidatable.delete(k);
    }
    if (this.firedAt.size < 512) return;
    for (const [k, ts] of this.firedAt) {
      if (now - ts > FIRE_DEDUPE_MS * 10) this.firedAt.delete(k);
    }
  }
}
