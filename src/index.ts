import "dotenv/config";
import { ethers } from "ethers";
import { logger } from "./logger";
import { CONFIG } from "./config";
import { PositionTracker } from "./positions";
import { AaveOracle } from "./oracle";
import { Evaluator } from "./evaluator";
import { Executor } from "./executor";
import { TriggerEngine } from "./trigger";
import { metrics, startMetricsReporter } from "./metrics";
import { attachCallLimiter } from "./rpcLimiter";
import { ReserveRegistry, TOPIC_RESERVE_DATA_UPDATED } from "./reserveState";

// ─── Constants ──────────────────────────────────────────────────────────────
const HF_ONE = 10n ** 18n;

// ─── Graceful shutdown ──────────────────────────────────────────────────────
let shuttingDown = false;
process.on("SIGINT",  () => { shuttingDown = true; logger.info("Shutting down…"); process.exit(0); });
process.on("SIGTERM", () => { shuttingDown = true; process.exit(0); });
process.on("uncaughtException",  e => logger.error(`Uncaught: ${e.message}`, e));
process.on("unhandledRejection", r => logger.error(`Rejection: ${r}`));

async function main(): Promise<void> {
  logger.info("═══════════════════════════════════════════════════════════");
  logger.info(" Aave V3 Liquidation Bot — Arbitrum One ");
  logger.info("═══════════════════════════════════════════════════════════");
  logger.info(`Contract   : ${CONFIG.contractAddress}`);
  logger.info(`Min profit : $${CONFIG.minProfitUsd}`);
  logger.info(`Batch size : ${CONFIG.positionsPerCycle} positions/cycle`);
  logger.info("═══════════════════════════════════════════════════════════");

  // ── Shared state ──────────────────────────────────────────────────────────
  let lastSeenBlock      = 0n;
  let latestPendingBlock = 0n;
  let refreshing         = false;
  let cycleSeq           = 0;   // incremented on every runCycle; only owner can release lock
  let pruning            = false;  // true while startup pruneStale() runs
  let ready              = false;
  let reconnecting       = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let providerGeneration = 0;   // incremented on every reconnect; stale cycles self-abort

  let cycles = 0, liquidatable = 0, executed = 0, totalProfitUsd = 0;
  let lastCycleBlockMs = Date.now();  // Opt #25: watchdog timestamp
  let lastCycleStartMs = 0;           // throttle reference — see requestCycle
  let cycleTimer: ReturnType<typeof setTimeout> | null = null;

  // PERF: lastEvaluatedHF is pruned every 500 cycles to prevent unbounded growth.
  // Positions that haven't been seen in 500 cycles are no longer in the danger tier
  // so their cached HF is stale anyway.
  const lastEvaluatedHF          = new Map<string, { hf: bigint; block: bigint }>();
  const EVAL_HF_CHANGE_THRESHOLD = 5n * 10n ** 15n; // 0.005 HF
  const EVAL_BLOCK_REFRESH       = 10n;              // blocks
  const EVAL_MAP_PRUNE_INTERVAL  = 500;              // cycles between map prune passes

  // Opt #26: Background price pre-fetch cache, populated by the interval set up
  // during startup. Declared here rather than beside that interval because
  // runCycle() reads it — a `let` declared after the reader is a temporal-dead-zone
  // hazard that only stays benign as long as nothing calls runCycle early.
  let bgPriceCache: { prices: Map<string, bigint>; droppedAssets: Set<string>; ts: number } | null = null;

  // PERF: feeData cached for 3 seconds — gas price on Arbitrum barely moves
  // block-to-block, no need to fetch it fresh every cycle.
  let cachedFeeData:   ethers.FeeData | null = null;
  let cachedFeeDataTs = 0;
  const FEE_CACHE_MS  = 3_000;

  async function getFeeDataCached(): Promise<ethers.FeeData> {
    if (cachedFeeData && Date.now() - cachedFeeDataTs < FEE_CACHE_MS) return cachedFeeData;
    try {
      cachedFeeData   = await provider.getFeeData();
      cachedFeeDataTs = Date.now();
    } catch (e: any) {
      // On provider destroyed, serve stale cached value rather than hanging/throwing
      if (!cachedFeeData) throw e;  // no stale — let cycle catch handle it
      // else return stale silently
    }
    return cachedFeeData!;
  }

  // ── Services (initialised once, survive reconnects) ───────────────────────
  let tracker:   PositionTracker;
  let reserveRegistry: ReserveRegistry;
  let oracle:    AaveOracle;
  let evaluator: Evaluator;
  let executor:  Executor;
  let trigger:   TriggerEngine;

  // Stage-timing reporter — logs p50/p95/max per stage every 3 minutes.
  startMetricsReporter();

  // ── Provider slot — getProvider() always returns the live one ─────────────
  let provider: ethers.WebSocketProvider;
  const getProvider = (): ethers.WebSocketProvider => provider;

  // Opt #25: Watchdog timer — warns if no cycle has been processed for > 60 seconds.
  // This catches scenarios where the bot appears healthy (WS connected) but
  // the cycle loop is stuck (e.g. unhandled promise rejection, RPC hang).
  setInterval(() => {
    if (ready && !shuttingDown && Date.now() - lastCycleBlockMs > 60_000) {
      const silentSec = ((Date.now() - lastCycleBlockMs) / 1000).toFixed(0);
      logger.warn(`\u26A0\uFE0F  Watchdog: no cycle processed for ${silentSec}s — check for stuck operations`);
    }
  }, 30_000);

  // Stats heartbeat
  const startMs = Date.now();
  setInterval(() => {
    const upMin = ((Date.now() - startMs) / 60_000).toFixed(1);
    const dangerInfo = tracker?.getDangerTierSummary();
    const dangerStr  = dangerInfo && dangerInfo.count > 0
      ? ` danger=${dangerInfo.count}[${dangerInfo.top3.map(p => `${p.addr}:${p.hf.toFixed(3)}`).join(" ")}]`
      : ` danger=${dangerInfo?.count ?? 0}`;
    logger.info(
      `📊 uptime=${upMin}m | cycles=${cycles} | liquidatable=${liquidatable} | ` +
      `executed=${executed} | profit=$${totalProfitUsd.toFixed(2)} | ` +
      `watching=${tracker?.size ?? 0} dormant=${tracker?.dormantSize ?? 0}` +
      dangerStr
    );
  }, 300_000);

  // ════════════════════════════════════════════════════════════════════════════
  // WS PROVIDER
  // ════════════════════════════════════════════════════════════════════════════

  function createProvider(): ethers.WebSocketProvider {
    const wsUrl = CONFIG.RPC_WS;
    logger.info(`WS connecting: ${wsUrl.replace(/:[^:@]+@/, ":***@")}`);

    const p = new ethers.WebSocketProvider(wsUrl, undefined, { staticNetwork: true });

    let lastBlockMs  = Date.now();
    let healthTimerId:     ReturnType<typeof setInterval>  | null = null;
    let proactiveTimerId:  ReturnType<typeof setTimeout>   | null = null;

    const HEALTH_TIMEOUT_MS   = 45_000;
    // PERF: Proactive reconnect at 55 minutes — Tenderly drops connections at ~90 min.
    // Reconnecting proactively keeps the gap-fill window tiny (<1 block) vs the
    // 5-second blind spot from a surprise 1006 close.
    const PROACTIVE_RECONNECT_MS = 55 * 60_000;

    healthTimerId = setInterval(() => {
      if (shuttingDown) { clearTimers(); return; }
      const silentMs = Date.now() - lastBlockMs;
      if (silentMs > HEALTH_TIMEOUT_MS) {
        logger.warn(`No block for ${(silentMs/1000).toFixed(0)}s — reconnecting`);
        clearTimers();
        scheduleReconnect(0);
      }
    }, 15_000);

    proactiveTimerId = setTimeout(() => {
      if (shuttingDown || reconnecting) return;
      logger.info("Proactive WS reconnect (55 min) — pre-empting server timeout");
      clearTimers();
      scheduleReconnect(0);
    }, PROACTIVE_RECONNECT_MS);

    function clearTimers() {
      if (healthTimerId    !== null) { clearInterval(healthTimerId);    healthTimerId    = null; }
      if (proactiveTimerId !== null) { clearTimeout(proactiveTimerId);  proactiveTimerId = null; }
    }

    function scheduleReconnect(delayMs = 5_000): void {
      if (reconnecting || shuttingDown) return;
      reconnecting = true;
      refreshing = false;   // abort any in-progress cycle — provider is going away
      cycleSeq++;            // invalidate any in-flight cycle's lock ownership
      providerGeneration++;  // invalidate all in-flight cycles from the old provider
      clearTimers();
      try { p.destroy(); } catch { /* ignore */ }
      logger.info(`Reconnecting in ${delayMs}ms…`);
      reconnectTimer = setTimeout(async () => {
        reconnectTimer = null;
        if (shuttingDown) return;
        try {
          const spawned = createProvider();
          provider = spawned;
          if (executor) executor.attachProvider(provider);
          // FIX: if the WS is created but never fires 'open' (e.g. DNS failure, firewall),
          // reconnecting stays true forever and the block loop is frozen. Guard with a
          // 30s timeout: if we're still reconnecting by then, force a fresh retry.
          //
          // The retry must tear down the socket WE just spawned. Calling this
          // provider's own scheduleReconnect would destroy the already-dead old
          // socket instead and leave `spawned` running forever with its own
          // health timer and block handler — one orphan accumulating per failed
          // reconnect, each still mutating lastSeenBlock.
          setTimeout(() => {
            if (!reconnecting || shuttingDown) return;
            if (provider !== spawned) return;  // something newer already took over
            logger.warn("WS open timed out after 30s — forcing reconnect retry");
            try { spawned.destroy(); } catch { /* ignore */ }
            reconnecting = false;
            scheduleReconnect(5_000);
          }, 30_000);
        } catch (e: any) {
          logger.error(`Reconnect failed: ${e.message} — retrying in 10s`);
          reconnecting = false;
          scheduleReconnect(10_000);
        }
      }, delayMs);
    }

    p.on("block", (bn: number) => {
      lastBlockMs = Date.now();
      const bnBig = BigInt(bn);
      if (bnBig > lastSeenBlock) {
        lastSeenBlock = bnBig;
        onNewBlock(bnBig);
      }
    });

    const ws = p.websocket as any;

    ws.on("open", async () => {
      logger.info("WS open");
      lastBlockMs  = Date.now();
      reconnecting = false;
      if (ready && tracker) {
        logger.info("Reconnected — gap-filling…");
        try { await tracker.startEventMonitoring(p, () => {}); }
        catch (e: any) { logger.warn(`Gap-fill failed: ${e.message}`); }
        // Re-subscribe the trigger engine's feed listeners on the fresh socket
        try { trigger?.attach(p); } catch { /* non-fatal */ }
      }
    });

    ws.on("close", (code: number, reason: Buffer) => {
      const why = reason?.toString() || "no reason";
      logger.warn(`WS closed (${code}: ${why}) — reconnecting`);
      clearTimers();
      scheduleReconnect(5_000);
    });

    ws.on("error", (err: Error) => {
      logger.error(`WS error: ${err.message}`);
      // FIX: auth errors (401/403) need a long backoff — retrying immediately
      // just burns reconnects against a Tenderly rate limit or expired key.
      if (/401|403|Unauthorized|Forbidden/i.test(err.message)) {
        logger.error("WS auth error — check RPC_WS key. Backing off 60s before retry.");
        clearTimers();
        scheduleReconnect(60_000);
      }
    });

    return p;
  }

  // ── Block dispatch ─────────────────────────────────────────────────────────
  function onNewBlock(bn: bigint): void {
    latestPendingBlock = bn;
    tracker?.setCurrentBlock(bn);
    const tEvent = performance.now();  // for cyc.detectLag instrumentation

    // PERF: Pre-warm breakdown cache for danger-tier positions every N blocks.
    // Runs as a background fire-and-forget task — never blocks the cycle.
    // When a position crosses HF=1.0 its breakdown is already cached, saving
    // the breakdown round-trip on the hot path when it matters most. The
    // trigger engine also needs these cached breakdowns to compute local HF.
    if (ready && !pruning && !reconnecting && bn % 30n === 0n) {  // every 30 blocks (~7.5s)
      tracker.prewarmDangerBreakdowns().catch(() => { /* silent */ });
    }

    if (!ready || refreshing || pruning || shuttingDown) {
      if (ready && pruning) logger.debug(`Block ${bn} skipped — prune in progress`);
      else if (ready)       logger.debug(`Block ${bn} queued (cycle in progress)`);
      return;
    }
    requestCycle(bn, tEvent);
  }

  // Rate-limits how often the polling sweep starts. Without this the cycle ran
  // back-to-back at block rate (~250ms) and monopolised the eth_call budget.
  // When a request arrives too soon, one timer is armed for the remainder and
  // it picks up the newest block at that point — requests in between collapse
  // into that single pending run rather than queueing.
  function requestCycle(bn: bigint, tEvent?: number): void {
    if (!ready || refreshing || pruning || shuttingDown || reconnecting) return;

    const waitMs = CONFIG.cycleMinIntervalMs - (Date.now() - lastCycleStartMs);
    if (waitMs <= 0) {
      runCycle(bn, tEvent).catch(e => logger.error(`Cycle error: ${e?.message ?? e}`));
      return;
    }
    if (cycleTimer !== null) return;  // a run is already pending
    cycleTimer = setTimeout(() => {
      cycleTimer = null;
      if (!ready || refreshing || pruning || shuttingDown || reconnecting) return;
      const target = latestPendingBlock > 0n ? latestPendingBlock : bn;
      runCycle(target).catch(e => logger.error(`Cycle error: ${e?.message ?? e}`));
    }, waitMs);
  }

  // ── Core cycle ─────────────────────────────────────────────────────────────
  async function runCycle(bn: bigint, tBlockEvent?: number): Promise<void> {
    if (!ready || refreshing || shuttingDown) return;
    if (reconnecting) return;   // provider is being replaced — skip cycle entirely
    refreshing = true;
    cycles++;
    lastCycleBlockMs = Date.now();  // Opt #25: update watchdog timestamp
    lastCycleStartMs = Date.now();  // throttle reference for requestCycle
    const mySeq   = ++cycleSeq;           // this cycle owns the lock; seq is our ticket
    const cycleGen = providerGeneration;  // snapshot — if this changes, provider was replaced

    if (tBlockEvent !== undefined) metrics.record("cyc.detectLag", performance.now() - tBlockEvent);
    const stopTotal = metrics.startTimer("cyc.total");

    // PERF: Prune lastEvaluatedHF map periodically to prevent unbounded growth.
    // Keep only addresses still in the active watchlist.
    if (cycles % EVAL_MAP_PRUNE_INTERVAL === 0 && lastEvaluatedHF.size > 0) {
      const activeAddrs = tracker.addressSet();
      for (const addr of lastEvaluatedHF.keys()) {
        if (!activeAddrs.has(addr)) lastEvaluatedHF.delete(addr);
      }
      logger.debug(`lastEvaluatedHF pruned to ${lastEvaluatedHF.size} entries`);
    }

    // Bug #9 fix: add AbortController so in-flight operations can be cancelled
    // when the safety timeout fires, preventing concurrent cycles from running.
    const abortController = new AbortController();

    const safety = setTimeout(() => {
      // Only release the lock if this cycle still owns it (seq unchanged).
      // If a newer cycle already started (e.g. from a block event), don't interfere.
      if (refreshing && cycleSeq === mySeq) {
        logger.warn(`Cycle ${bn} safety timeout — releasing lock and aborting in-flight ops`);
        abortController.abort();  // signal in-flight operations to stop
        refreshing = false;
        // Don't trigger a new cycle if we're reconnecting — the new provider's
        // block event will do it once the socket is healthy again.
        if (latestPendingBlock > bn && !reconnecting) onNewBlock(latestPendingBlock);
      }
    }, 45_000);

    try {
      logger.debug(`Cycle block=${bn} watching=${tracker.size}`);

      const stopScan = metrics.startTimer("cyc.scan");
      const candidates = await tracker.refreshBatch(CONFIG.positionsPerCycle);
      stopScan();

      // Provider was replaced while we were awaiting — discard results and exit cleanly
      if (providerGeneration !== cycleGen) return;

      if (candidates.length === 0) {
        logger.debug(`Block ${bn}: 0 liquidatable of ${tracker.size}`);
        return;
      }

      liquidatable += candidates.length;
      logger.info(`🔍 Block ${bn}: ${candidates.length} liquidatable`);

      // PERF: feeData + oracle prices + ETH price all in parallel, feeData cached 3s
      // OPT 2: Use drop-detection variant — wakes dormant positions if a price fell ≥2%
      // Opt #26: Use background price cache if fresh (<5s old) to skip the RPC call
      // in the cycle's critical path, saving ~100-300ms.
      const BG_PRICE_FRESHNESS_MS = 5_000;
      const bgPrices = bgPriceCache && (Date.now() - bgPriceCache.ts < BG_PRICE_FRESHNESS_MS)
        ? bgPriceCache : null;

      let allPrices: Map<string, bigint>;
      let ethPriceUsd: number;
      let feeData: ethers.FeeData;
      let priceResult: { prices: Map<string, bigint>; droppedAssets: Set<string> };

      if (bgPrices) {
        // Fast path: use background-cached prices, only fetch feeData + ETH price
        [feeData, ethPriceUsd] = await Promise.all([
          getFeeDataCached(),
          evaluator.getEthPrice(),
        ]);
        allPrices = bgPrices.prices;
        // Wake dormant on price drops found by background prefetch
        if (bgPrices.droppedAssets.size > 0) {
          tracker.wakeByCollateralAssets(bgPrices.droppedAssets);
        }
      } else {
        // Slow path: no fresh background cache, fetch everything in cycle
        [feeData, priceResult, ethPriceUsd] = await Promise.all([
          getFeeDataCached(),
          oracle.prefetchAllPricesWithDropDetection(),
          evaluator.getEthPrice(),
        ]);
        allPrices = priceResult.prices;
        if (priceResult.droppedAssets.size > 0) {
          tracker.wakeByCollateralAssets(priceResult.droppedAssets);
        }
      }
      const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice ?? 100_000_000n;

      const MIN_DEBT_USD = 10;
      let skippedTooSmall = 0, skippedNoBreakdown = 0,
          skippedNotProfitable = 0, skippedUnchanged = 0;

      // ── Filter candidates to actionable set ──────────────────────────────
      // Apply all cheap filters (debt size, rate-limit) before any RPC calls so we
      // only pay for breakdown+evaluate on real candidates.
      // NOTE: all candidates from refreshBatch() have healthFactor < HF_ONE — the
      // >= HF_ONE guard below is purely defensive and should never fire.
      const actionable: typeof candidates = [];
      for (const pos of candidates) {
        if (shuttingDown) break;
        if (pos.healthFactor >= HF_ONE) continue; // defensive: refreshBatch already filters this

        const debtUsd = Number(pos.totalDebtBase) / 1e8;
        if (debtUsd < MIN_DEBT_USD) {
          skippedTooSmall++;
          logger.debug(`  ${pos.address.slice(0,10)}… dust (debt=$${debtUsd.toFixed(2)}) — evicting`);
          tracker.evictDust(pos.address);  // FIX: dust ≠ bad debt — don't denylist
          continue;
        }

        // FIX: isConfirmedLiquidatable was always true (candidates are all HF < 1.0),
        // making the unchanged-HF guard for borderline positions dead code. Simplified
        // to a single rate-limit: skip if this address was evaluated less than 2 blocks ago.
        const lastEval = lastEvaluatedHF.get(pos.address);
        if (lastEval && bn - lastEval.block < 2n) {
          skippedUnchanged++;
          continue;
        }

        actionable.push(pos);
      }

      if (actionable.length === 0) {
        if (candidates.length > 0) {
          logger.info(
            `  Candidates: ${candidates.length} | tooSmall=${skippedTooSmall} ` +
            `unchanged=${skippedUnchanged} actionable=0`
          );
        }
        return;
      }

      // ── PERF: Parallel breakdown fetch for all actionable candidates ──────
      // Previously serial: candidate[0] breakdown → evaluate → candidate[1] breakdown …
      // Now: all breakdowns fire simultaneously, then all evaluations fire simultaneously.
      // For N actionable candidates this saves (N-1) × ~150ms in breakdown latency
      // and (N-1) × ~100ms in Uniswap quote latency.
      // Batched across ADDRESSES, not just across assets within one address:
      // 2 eth_calls total instead of 2 per candidate.
      logger.debug(`  Batched breakdown for ${actionable.length} candidates`);
      const stopBreakdown = metrics.startTimer("cyc.breakdown");
      const breakdowns = await tracker.getAssetBreakdownBatch(actionable.map(p => p.address));
      stopBreakdown();
      if (providerGeneration !== cycleGen) return;

      // ── PERF: Parallel evaluate (includes Uniswap quote per candidate) ───
      const evalInputs: Array<{ pos: typeof actionable[0]; collaterals: any[]; debts: any[] }> = [];
      for (let i = 0; i < actionable.length; i++) {
        const br = breakdowns.get(actionable[i]!.address.toLowerCase());
        if (!br || !br.collaterals.length || !br.debts.length) {
          skippedNoBreakdown++;
          logger.debug(`  ${actionable[i]!.address.slice(0,10)}… no breakdown`);
          continue;
        }
        const { collaterals, debts } = br;
        logger.info(
          `  breakdown ${actionable[i]!.address.slice(0,10)}: ` +
          `col=[${collaterals.map((c: any) => c.symbol).join(",")}] ` +
          `debt=[${debts.map((d: any) => d.symbol).join(",")}] ` +
          `HF=${actionable[i]!.healthFactorNum.toFixed(4)} ` +
          `totalDebt=$${(Number(actionable[i]!.totalDebtBase) / 1e8).toFixed(2)}`
        );
        evalInputs.push({ pos: actionable[i]!, collaterals, debts });
      }

      // Evaluate candidates — evaluation is now pure CPU (no Uniswap quotes),
      // so the old serial-loop rationale no longer applies. Parallel is free.
      const stopEval = metrics.startTimer("cyc.evaluate");
      const evalResults: PromiseSettledResult<any>[] = await Promise.allSettled(
        evalInputs.map(({ pos, collaterals, debts }) =>
          evaluator.evaluate(pos, collaterals, debts, gasPrice, allPrices, ethPriceUsd)
        )
      );
      stopEval();
      if (providerGeneration !== cycleGen) return;

      // ── Process results — execute the best opportunity found ──────────────
      if (providerGeneration !== cycleGen) return;
      // Collect EVERY profitable opportunity, not just the single best. During a
      // crash — the only time large profit is on the table — many positions are
      // liquidatable at once, and the old code submitted one per sweep while the
      // executor sat idle with spare concurrency.
      const opportunities: Array<{ opp: any; pos: any }> = [];

      for (let i = 0; i < evalInputs.length; i++) {
        const pos = evalInputs[i]!.pos;
        lastEvaluatedHF.set(pos.address, { hf: pos.healthFactor, block: bn });

        const er = evalResults[i]!;
        if (er.status !== "fulfilled") {
          logger.error(`  Eval error ${pos.address.slice(0,10)}: ${(er as any).reason}`);
          continue;
        }

        const opp = er.value;

        if (opp === "EVICT") {
          logger.info(`  Evicting bad-debt ${pos.address.slice(0,10)} per evaluator`);
          tracker.evict(pos.address);
          lastEvaluatedHF.delete(pos.address);
          continue;
        }

        if (!opp) {
          skippedNotProfitable++;
          lastEvaluatedHF.delete(pos.address);
          continue;
        }

        opportunities.push({ opp, pos });
      }

      // Most profitable first, so limited executor slots go to the best ones.
      opportunities.sort((a, b) => b.opp.netProfitUsd - a.opp.netProfitUsd);

      for (const { opp, pos } of opportunities) {
        // OPT 3: the Executor's parallel queue allows up to
        // CONFIG.maxConcurrentExecutions simultaneous liquidations, each with its
        // own nonce slot. Stop offering work once it is full rather than
        // spamming skip warnings for every remaining candidate.
        if (executor.isExecuting) {
          logger.warn(
            `  → executor at capacity (${executor.inFlightCount}/${CONFIG.maxConcurrentExecutions}) — ` +
            `${opportunities.length} opportunities this cycle, dropping the rest`
          );
          break;
        }

        logger.info(
          `🚨 Opp: ${pos.address.slice(0,10)}… | HF=${pos.healthFactorNum.toFixed(4)} | ` +
          `debt=$${(Number(pos.totalDebtBase)/1e8).toFixed(2)} | ` +
          `${opp.collateralSymbol}→${opp.debtSymbol} | ` +
          `bonus=$${opp.expectedBonusUsd.toFixed(2)} net=$${opp.netProfitUsd.toFixed(2)}`
        );

        // Fire-and-forget — don't await, so the cycle loop continues watching
        // for more opportunities while this tx is in-flight.
        // Bug #1 fix: pass block number and feeData for recentlyExecuted check
        // and to avoid redundant getFeeData call (Opt #21).
        executor.execute(opp, bn, feeData).then(receipt => {
          if (receipt?.status === 1) {
            executed++;
            totalProfitUsd += opp.netProfitUsd;
            logger.info(`  ✅ ${receipt.hash}`);
            lastEvaluatedHF.delete(pos.address);
          } else if (receipt) {
            logger.warn(`  ❌ tx reverted`);
          }
        }).catch(e => {
          logger.error(`  Execute error: ${e?.shortMessage ?? e?.message ?? e}`);
        });
      }

      if (candidates.length > 0) {
        logger.info(
          `  Candidates: ${candidates.length} | ` +
          `tooSmall=${skippedTooSmall} unchanged=${skippedUnchanged} ` +
          `noBreakdown=${skippedNoBreakdown} notProfitable=${skippedNotProfitable} ` +
          `actionable=${actionable.length}`
        );
      }

    } catch (err: any) {
      logger.error(`Cycle ${bn}: ${err.message || err}`);
    } finally {
      stopTotal();
      clearTimeout(safety);
      // Only release the lock if we still own it — safety timer may have already
      // released it and spawned a new cycle that now owns the lock.
      if (cycleSeq === mySeq) {
        refreshing = false;
        // Spawn catch-up only if provider is still the same and we still own the
        // lock. Goes through requestCycle so the catch-up respects the sweep
        // throttle — this path was the one that made cycles run back-to-back.
        if (latestPendingBlock > bn && !shuttingDown && !reconnecting && providerGeneration === cycleGen) {
          setImmediate(() => requestCycle(latestPendingBlock));
        }
      }
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // STARTUP
  // ════════════════════════════════════════════════════════════════════════════

  provider = createProvider();
  const httpProvider = new ethers.JsonRpcProvider(CONFIG.rpcUrl, undefined, { staticNetwork: true });
  // Reads (multicall, price fetches, breakdown fetches — everything that isn't a
  // block/log subscription) go over this dedicated HTTP connection, not the shared
  // WebSocket. Root cause this fixes: the WS provider was carrying BOTH live
  // subscription traffic (block headers, Aave events, Chainlink AnswerUpdated) AND
  // every burst of concurrent eth_call multicall requests, multiplexed over one
  // socket. The one code path that stayed clean under load — pruneStale — paces
  // itself (waves of 8 with a 20ms sleep between them); refreshBatch and the
  // breakdown fan-out don't, and fire straight onto the same socket the
  // subscriptions depend on. HTTP requests are independent per-call (no shared
  // stream to correlate responses on), which is the standard split for this
  // reason: WS for subscriptions, HTTP for bulk/concurrent reads. Stateless, so
  // no reconnect handling needed — created once, used for the process lifetime.
  attachCallLimiter(httpProvider, CONFIG.rpcCallsPerSecond);
  const getReadProvider = (): ethers.JsonRpcProvider => httpProvider;

  try {
    const [net, bn] = await Promise.all([
      httpProvider.getNetwork(),
      httpProvider.getBlockNumber(),
    ]);
    if (net.chainId !== 42161n) throw new Error(`Wrong chain: ${net.chainId}`);
    lastSeenBlock = BigInt(bn);
    logger.info(`Connected to Arbitrum | block ${bn}`);
  } catch (err: any) {
    logger.error(`Init failed: ${err.message}`);
    process.exit(1);
  }

  const wallet = new ethers.Wallet(CONFIG.privateKey, provider);
  const ethBal = await httpProvider.getBalance(wallet.address); // FIX: reuse existing provider, don't leak a new one
  logger.info(`Wallet: ${wallet.address} | ETH: ${ethers.formatEther(ethBal)}`);
  if (ethBal < ethers.parseEther("0.05")) {
    logger.warn("⚠️  Low ETH balance — top up (need ≥0.05 ETH for gas)");
  }

  // FIX: Periodic ETH balance check — startup check only fires once, but balance
  // can drain over hours via failed txs or gas price spikes. Re-check every 15 min.
  setInterval(async () => {
    if (shuttingDown) return;
    try {
      const bal = await httpProvider.getBalance(wallet.address);
      if (bal < ethers.parseEther("0.02")) {
        logger.warn(`⚠️  ETH balance critically low: ${ethers.formatEther(bal)} ETH — top up now`);
      } else if (bal < ethers.parseEther("0.05")) {
        logger.warn(`⚠️  ETH balance low: ${ethers.formatEther(bal)} ETH`);
      }
    } catch { /* ignore — provider may be reconnecting */ }
  }, 15 * 60_000);

  // PositionTracker/AaveOracle/Evaluator do only reads (multicall, price fetches) —
  // route them through the HTTP provider. TriggerEngine below keeps the WS
  // provider: it genuinely needs it to subscribe to Chainlink log events.
  // Reserve-side mirror: indices, thresholds, bonuses, decimals, ids, e-mode.
  // Must be loaded before the tracker can compute any health factor locally.
  reserveRegistry = new ReserveRegistry(getReadProvider);
  try {
    await reserveRegistry.refreshAll();
  } catch (e: any) {
    logger.error(`Reserve registry load failed: ${e?.message ?? e}`);
    process.exit(1);
  }

  tracker   = new PositionTracker(getReadProvider, reserveRegistry);
  oracle    = new AaveOracle(getReadProvider);
  evaluator = new Evaluator(oracle, getReadProvider, reserveRegistry);
  // httpProvider doubles as a broadcast + receipt-polling endpoint so a WS
  // reconnect can't strand an in-flight liquidation.
  executor  = new Executor(wallet, CONFIG.contractAddress, httpProvider);

  // Competitor-liquidation awareness: when someone else's LiquidationCall is
  // seen for a tracked borrower, mark it so the executor skips accurately.
  tracker.onExternalLiquidation = (borrower: string) => executor.noteExternalLiquidation(borrower);
  tracker.ownLiquidator = CONFIG.contractAddress.toLowerCase();
  // Lets trigger-path executions reuse the cycle's fee data instead of paying
  // for a getFeeData round-trip before signing.
  executor.setFeeDataSource(() =>
    cachedFeeData && Date.now() - cachedFeeDataTs < FEE_CACHE_MS ? cachedFeeData : null
  );

  // Event-driven trigger engine — fires liquidations directly on Chainlink feed
  // updates using local HF recomputation, bypassing the polling cycle entirely.
  // Gas price comes from the cycle-level cache; canFire mirrors the block-loop
  // guards but deliberately does NOT check `refreshing` — firing during an
  // in-flight scan is exactly the point.
  trigger = new TriggerEngine(
    tracker,
    oracle,
    evaluator,
    executor,
    () => cachedFeeData?.maxFeePerGas ?? cachedFeeData?.gasPrice ?? 100_000_000n,
    () => ready && !pruning && !reconnecting && !shuttingDown,
    getProvider,      // WS — log subscriptions only
    getReadProvider,  // HTTP — feed resolution and price reads
  );

  const { skipPrune } = await tracker.seed();
  logger.info(`Seed complete — watching ${tracker.size} positions`);

  // Startup prune — runs in background, block loop paused until complete.
  // Skipped when seed came from the positions query (balance_gt: 0 guarantees live debt).
  if (skipPrune) {
    logger.info("Prune skipped — subgraph positions query guarantees active borrowers only");
  } else {
    pruning = true;
    logger.info("Prune starting — block loop paused until complete");
    tracker.pruneStale()
      .catch(e => logger.warn(`Prune failed: ${e?.message ?? e}`))
      .finally(() => {
        pruning = false;
        logger.info("Prune complete — block loop resumed");
        if (!shuttingDown && latestPendingBlock > 0n) {
          onNewBlock(latestPendingBlock);
        }
      });
  }

  await tracker.startEventMonitoring(provider, () => {});

  // Bug #12 fix: periodically prune the full borrower cache to prevent unbounded growth
  setInterval(() => {
    if (!shuttingDown) tracker.pruneFullCache();
  }, 6 * 60 * 60_000);  // every 6 hours

  // Reserve thresholds and bonuses no longer need their own refresh job — the
  // ReserveRegistry owns them and is refreshed below, e-mode included.

  // Arbitrum L1 base fee — read from the ArbGasInfo precompile on an interval so
  // the L1 data-fee estimate in evaluator.ts tracks real Ethereum L1 congestion
  // instead of a flat guess. Cheap (one staticcall), off the hot path.
  setInterval(() => {
    if (!shuttingDown) evaluator.refreshL1BaseFee().catch(() => { /* silent */ });
  }, 20_000);
  evaluator.refreshL1BaseFee().catch(() => { /* silent */ });

  // Opt #26: Background price pre-fetch with drop detection.
  // Pre-fetch prices every 5 seconds and cache them so the cycle just reads
  // the cache instead of waiting for the RPC call. This removes ~100-300ms of
  // latency from the cycle's critical path (between "candidates found" and
  // "evaluate + execute"), which matters when competing for liquidations.
  const BG_PRICE_INTERVAL_MS = 5_000;
  setInterval(async () => {
    if (shuttingDown || !ready) return;
    try {
      const result = await oracle.prefetchAllPricesWithDropDetection();
      bgPriceCache = { prices: result.prices, droppedAssets: result.droppedAssets, ts: Date.now() };
      // If price dropped, wake dormant positions immediately (don't wait for cycle)
      if (result.droppedAssets.size > 0) {
        tracker.wakeByCollateralAssets(result.droppedAssets);
      }
    } catch { /* silent — cycle will fetch its own prices if cache is stale */ }
  }, BG_PRICE_INTERVAL_MS);

  // Reserve registry refresh — indices are kept current for free by the
  // ReserveDataUpdated subscription below; this periodic full refresh picks up
  // governance changes to thresholds/bonuses and resyncs any missed index.
  setInterval(() => {
    if (!shuttingDown) reserveRegistry.refreshAll().catch(e => logger.debug(`Reserve refresh: ${e?.message ?? e}`));
  }, 5 * 60_000);

  // Background model fill. Model entries hold SCALED balances, which change only
  // when the borrower transacts — so this is a one-time cost per position, after
  // which health factors for the whole watchlist are computable in memory with
  // no RPC at all. Bounded per tick so it never competes with the hot path.
  const MODEL_FILL_INTERVAL_MS = 2_000;
  const MODEL_FILL_BATCH       = 60;   // 3 multicalls per tick at 20 users each
  setInterval(() => {
    if (shuttingDown || !ready || pruning || reconnecting) return;
    tracker.fillModel(MODEL_FILL_BATCH).catch(() => { /* silent — retried next tick */ });
  }, MODEL_FILL_INTERVAL_MS);

  // Dormant recheck — wake positions that were parked as healthy.
  // Interval shortened to 5 min (from 15 min) to match the reduced 1-hour
  // dormant window — ensures positions are never stale for longer than ~65 min.
  const DORMANT_WAKE_INTERVAL_MS = 5 * 60 * 1000;
  setInterval(() => {
    if (shuttingDown) return;
    tracker.wakeExpiredDormant();
  }, DORMANT_WAKE_INTERVAL_MS);

  await trigger.start().catch(e => logger.warn(`Trigger engine start failed: ${e?.message ?? e}`));

  ready = true;
  logger.info("Bot ready — watching for blocks");
  onNewBlock(lastSeenBlock);
}

main().catch(err => {
  logger.error("Fatal:", err);
  process.exit(1);
});
