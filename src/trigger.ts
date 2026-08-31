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

// Fire when locally-recomputed HF falls below this. Slightly above 1.0 so we
// submit at the first plausible crossing; static LTs + e-mode uncertainty mean
// our estimate errs high (under-firing), never dangerously low.
const TRIGGER_HF_CEILING = 101n * 10n ** 16n; // 1.01

// Dedupe window per borrower — a single price move can land as several feed
// events in the same block.
const FIRE_DEDUPE_MS = 2_000;

export class TriggerEngine {
  // aggregator address (lowercase) → reserve asset addresses (lowercase) it prices
  private feeds        = new Map<string, Set<string>>();
  private lastAnswers  = new Map<string, bigint>();   // feed → last raw answer (baseline for ratio)
  private firedAt      = new Map<string, number>();   // borrower → last dispatch ts (dedupe window)
  private refreshThrottle = new Map<string, number>();// asset → last forced-refresh ts

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
          const cached = this.oracle.peekPrice(asset);
          if (cached === null || cached <= 0n) continue;
          this.oracle.pokePrice(asset, (cached * hint.answer) / prev);
          touched.add(asset);
        }
        this.lastAnswers.set(hint.feed, hint.answer);
        if (touched.size > 0) {
          metrics.record("trig.feedLead", 1);
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
    const filter: ethers.Filter = {
      address: [...this.feeds.keys()],
      topics:  [ANSWER_UPDATED_TOPIC],
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

  // ── Hot path ───────────────────────────────────────────────────────────────

  // Arrow property so `this` binds correctly as a provider listener.
  private _onLog = async (log: ethers.Log): Promise<void> => {
    try {
      if (log.removed) return;
      const feed   = log.address.toLowerCase();
      const assets = this.feeds.get(feed);
      if (!assets || assets.size === 0) return;

      const parsed = ANSWER_UPDATED_IFACE.parseLog({ topics: log.topics as string[], data: log.data });
      if (!parsed) return;
      const current = BigInt(parsed.args[0]);

      const prev = this.lastAnswers.get(feed) ?? null;
      this.lastAnswers.set(feed, current);

      // Fast path: cached Aave price × raw-answer ratio. Every asset behind this
      // aggregator moves proportionally (a CAPO ratio adapter multiplies by a
      // slow-moving LST exchange rate, which cancels in the ratio).
      const touched = new Set<string>();
      const estimated: string[]   = [];
      const needsConfirm: string[] = [];
      const ratioUsable = prev !== null && prev > 0n && current > 0n;

      for (const asset of assets) {
        const cached = this.oracle.peekPrice(asset);
        if (ratioUsable && cached !== null && cached > 0n) {
          this.oracle.pokePrice(asset, (cached * current) / prev!);
          touched.add(asset);
          estimated.push(asset);
        } else {
          needsConfirm.push(asset);
        }
      }

      // Slow path: no usable baseline for these assets — they need an
      // authoritative read before they can contribute to a local HF. Batched:
      // this aggregator may back six reserves, and six separate getAssetPrice
      // calls per event would dominate the rate-limit budget during volatility.
      if (needsConfirm.length > 0) {
        const confirmed = await this.throttledRefreshMany(needsConfirm);
        for (const [a, p] of confirmed) if (p > 0n) touched.add(a);
      }

      if (touched.size === 0) return;

      // Dispatch on the estimates FIRST — the whole point is to act before a
      // confirmation round-trip. The confirmation runs behind it and corrects
      // the cache for the next event.
      this.dispatch(touched);
      if (estimated.length > 0) this.throttledRefreshMany(estimated).catch(() => {});
    } catch { /* never throw from a log handler */ }
  };

  // Batched authoritative refresh with a per-asset throttle. Assets still inside
  // their throttle window are served from cache and cost nothing; the rest go
  // out as ONE getAssetsPrices call.
  private async throttledRefreshMany(assets: string[]): Promise<Array<readonly [string, bigint]>> {
    const now = Date.now();
    const out: Array<readonly [string, bigint]> = [];
    const toFetch: string[] = [];

    for (const asset of assets) {
      const last = this.refreshThrottle.get(asset) ?? 0;
      if (now - last < 1_000) out.push([asset, this.oracle.peekPrice(asset) ?? 0n] as const);
      else { this.refreshThrottle.set(asset, now); toFetch.push(asset); }
    }

    if (toFetch.length > 0) {
      try {
        const fetched = await this.oracle.refreshPrices(toFetch);
        for (const asset of toFetch) out.push([asset, fetched.get(asset) ?? 0n] as const);
      } catch {
        for (const asset of toFetch) out.push([asset, this.oracle.peekPrice(asset) ?? 0n] as const);
      }
    }
    return out;
  }

  // Pure-computation hot path: snapshot prices → find crossed positions → build
  // and submit opportunities. No RPC before submission.
  private dispatch(assetsLower: Set<string>): void {
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
      const candidates = this.tracker.findLocalCandidates(assetsLower, prices, TRIGGER_HF_CEILING, 10);
      if (candidates.length === 0) return;

      const gasPrice = this.getGasPrice();
      const ethPrice = this.evaluator.ethPriceCached() || 3000; // gas-cost input only

      const now = Date.now();
      let fired = 0;
      for (const cand of candidates) {
        const key = cand.pos.address;
        const lastFire = this.firedAt.get(key);
        if (lastFire && now - lastFire < FIRE_DEDUPE_MS) continue;  // dedupe multi-feed bursts

        const opp = this.evaluator.buildFromLocal(
          cand.pos, cand.collaterals, cand.debts, prices, gasPrice, ethPrice,
        );
        if (!opp) continue;

        this.firedAt.set(key, now);
        fired++;
        logger.info(
          `⚡ Trigger: ${cand.pos.address.slice(0,10)}… localHF=${cand.hfLocal.toFixed(4)} ` +
          `${opp.collateralSymbol}->>${opp.debtSymbol} net=$${opp.netProfitUsd.toFixed(2)} — firing`
        );
        // Executor handles capacity/cooldown/in-flight guards internally.
        this.executor.execute(opp).catch(e =>
          logger.error(`Trigger exec error: ${e?.shortMessage ?? e?.message ?? e}`)
        );
      }

      this.pruneFiredAt(now);
      logger.debug(`trigger: ${candidates.length} local candidates for asset move, ${fired} dispatched`);
    } finally {
      stop();
    }
  }

  // firedAt only exists to dedupe within FIRE_DEDUPE_MS; without this it grows
  // one entry per borrower ever triggered and never shrinks.
  private pruneFiredAt(now: number): void {
    if (this.firedAt.size < 512) return;
    for (const [k, ts] of this.firedAt) {
      if (now - ts > FIRE_DEDUPE_MS * 10) this.firedAt.delete(k);
    }
  }
}
