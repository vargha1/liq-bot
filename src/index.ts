import "dotenv/config";
import { ethers } from "ethers";
import { logger } from "./logger";
import { CONFIG } from "./config";
import { PositionTracker } from "./positions";
import { AaveOracle } from "./oracle";
import { Evaluator } from "./evaluator";
import { Executor } from "./executor";

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

  // PERF: lastEvaluatedHF is pruned every 500 cycles to prevent unbounded growth.
  // Positions that haven't been seen in 500 cycles are no longer in the danger tier
  // so their cached HF is stale anyway.
  const lastEvaluatedHF          = new Map<string, { hf: bigint; block: bigint }>();
  const EVAL_HF_CHANGE_THRESHOLD = 5n * 10n ** 15n; // 0.005 HF
  const EVAL_BLOCK_REFRESH       = 10n;              // blocks
  const EVAL_MAP_PRUNE_INTERVAL  = 500;              // cycles between map prune passes

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
  let oracle:    AaveOracle;
  let evaluator: Evaluator;
  let executor:  Executor;

  // ── Provider slot — getProvider() always returns the live one ─────────────
  let provider: ethers.WebSocketProvider;
  const getProvider = (): ethers.WebSocketProvider => provider;

  // ── Stats heartbeat ───────────────────────────────────────────────────────
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
          provider = createProvider();
          if (executor) executor.attachProvider(provider);
          // FIX: if the WS is created but never fires 'open' (e.g. DNS failure, firewall),
          // reconnecting stays true forever and the block loop is frozen. Guard with a
          // 30s timeout: if we're still reconnecting by then, force a fresh retry.
          setTimeout(() => {
            if (reconnecting && !shuttingDown) {
              logger.warn("WS open timed out after 30s — forcing reconnect retry");
              reconnecting = false;
              scheduleReconnect(5_000);
            }
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

    // PERF: Pre-warm breakdown cache for danger-tier positions every 10 blocks.
    // Runs as a background fire-and-forget task — never blocks the cycle.
    // When a position crosses HF=1.0 its breakdown is already cached, saving
    // ~100-200ms on the hot path when it matters most.
    if (ready && !pruning && !reconnecting && bn % 30n === 0n) {  // every 30 blocks (~7.5s)
      tracker.prewarmDangerBreakdowns().catch(() => { /* silent */ });
    }

    if (!ready || refreshing || pruning || shuttingDown) {
      if (ready && pruning) logger.debug(`Block ${bn} skipped — prune in progress`);
      else if (ready)       logger.debug(`Block ${bn} queued (cycle in progress)`);
      return;
    }
    runCycle(bn).catch(e => logger.error(`Cycle error: ${e?.message ?? e}`));
  }

  // ── Core cycle ─────────────────────────────────────────────────────────────
  async function runCycle(bn: bigint): Promise<void> {
    if (!ready || refreshing || shuttingDown) return;
    if (reconnecting) return;   // provider is being replaced — skip cycle entirely
    refreshing = true;
    cycles++;
    const mySeq   = ++cycleSeq;           // this cycle owns the lock; seq is our ticket
    const cycleGen = providerGeneration;  // snapshot — if this changes, provider was replaced

    // PERF: Prune lastEvaluatedHF map periodically to prevent unbounded growth.
    // Keep only addresses still in the active watchlist.
    if (cycles % EVAL_MAP_PRUNE_INTERVAL === 0 && lastEvaluatedHF.size > 0) {
      const activeAddrs = tracker.addressSet();
      for (const addr of lastEvaluatedHF.keys()) {
        if (!activeAddrs.has(addr)) lastEvaluatedHF.delete(addr);
      }
      logger.debug(`lastEvaluatedHF pruned to ${lastEvaluatedHF.size} entries`);
    }

    const safety = setTimeout(() => {
      // Only release the lock if this cycle still owns it (seq unchanged).
      // If a newer cycle already started (e.g. from a block event), don't interfere.
      if (refreshing && cycleSeq === mySeq) {
        logger.warn(`Cycle ${bn} safety timeout — releasing lock`);
        refreshing = false;
        // Don't trigger a new cycle if we're reconnecting — the new provider's
        // block event will do it once the socket is healthy again.
        if (latestPendingBlock > bn && !reconnecting) onNewBlock(latestPendingBlock);
      }
    }, 45_000);

    try {
      logger.debug(`Cycle block=${bn} watching=${tracker.size}`);

      const candidates = await tracker.refreshBatch(CONFIG.positionsPerCycle);

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
      const [feeData, priceResult, ethPriceUsd] = await Promise.all([
        getFeeDataCached(),
        oracle.prefetchAllPricesWithDropDetection(),
        evaluator.getEthPrice(),
      ]);
      const allPrices = priceResult.prices;
      // OPT 2: If any asset price dropped significantly, immediately wake dormant
      // positions that may now be liquidatable — don't wait for the hourly timer.
      if (priceResult.droppedAssets.size > 0) {
        tracker.wakeByCollateralAssets(priceResult.droppedAssets);
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
      logger.debug(`  Parallel breakdown for ${actionable.length} candidates`);
      const breakdownResults = await Promise.allSettled(
        actionable.map(pos => tracker.getAssetBreakdown(pos.address))
      );
      if (providerGeneration !== cycleGen) return;

      // ── PERF: Parallel evaluate (includes Uniswap quote per candidate) ───
      const evalInputs: Array<{ pos: typeof actionable[0]; collaterals: any[]; debts: any[] }> = [];
      for (let i = 0; i < actionable.length; i++) {
        const br = breakdownResults[i]!;
        if (br.status !== "fulfilled" || !br.value.collaterals.length || !br.value.debts.length) {
          skippedNoBreakdown++;
          logger.debug(`  ${actionable[i]!.address.slice(0,10)}… no breakdown`);
          continue;
        }
        const { collaterals, debts } = br.value;
        logger.info(
          `  breakdown ${actionable[i]!.address.slice(0,10)}: ` +
          `col=[${collaterals.map((c: any) => c.symbol).join(",")}] ` +
          `debt=[${debts.map((d: any) => d.symbol).join(",")}] ` +
          `HF=${actionable[i]!.healthFactorNum.toFixed(4)} ` +
          `totalDebt=$${(Number(actionable[i]!.totalDebtBase) / 1e8).toFixed(2)}`
        );
        evalInputs.push({ pos: actionable[i]!, collaterals, debts });
      }

      // Evaluate candidates serially — each evaluate() fires Uniswap staticCalls.
      // Parallel evaluation with N candidates = N×8 concurrent staticCalls which
      // saturates Tenderly and causes timeouts. Serial cost is negligible since
      // there are rarely more than 1-3 actionable candidates per cycle.
      const evalResults: PromiseSettledResult<any>[] = [];
      for (const { pos, collaterals, debts } of evalInputs) {
        if (providerGeneration !== cycleGen) break;  // abort if provider replaced mid-eval
        evalResults.push(await Promise.allSettled([
          evaluator.evaluate(pos, collaterals, debts, gasPrice, allPrices, ethPriceUsd)
        ]).then(r => r[0]!));
      }

      // ── Process results — execute the best opportunity found ──────────────
      if (providerGeneration !== cycleGen) return;
      let bestOpp: any = null;
      let bestIdx = -1;

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

        // Track the single best opportunity across all candidates
        if (!bestOpp || opp.netProfitUsd > bestOpp.netProfitUsd) {
          bestOpp = opp;
          bestIdx = i;
        }
      }

      if (bestOpp) {
        const pos = evalInputs[bestIdx]!.pos;
        logger.info(
          `🚨 Opp: ${pos.address.slice(0,10)}… | HF=${pos.healthFactorNum.toFixed(4)} | ` +
          `debt=$${(Number(pos.totalDebtBase)/1e8).toFixed(2)} | ` +
          `${bestOpp.collateralSymbol}→${bestOpp.debtSymbol} | ` +
          `bonus=$${bestOpp.expectedBonusUsd.toFixed(2)} net=$${bestOpp.netProfitUsd.toFixed(2)}`
        );

        // OPT 3: Execute the best opportunity. The parallel queue in Executor
        // allows up to CONFIG.maxConcurrentExecutions simultaneous liquidations —
        // each gets its own nonce slot so they don't block each other.
        if (executor.isExecuting) {
          logger.warn(`  → executor at capacity (${executor.inFlightCount}/${CONFIG.maxConcurrentExecutions})`);
        } else {
          // Fire-and-forget — don't await, so the cycle loop continues watching
          // for more opportunities while this tx is in-flight.
          executor.execute(bestOpp).then(receipt => {
            if (receipt?.status === 1) {
              executed++;
              totalProfitUsd += bestOpp.netProfitUsd;
              logger.info(`  ✅ ${receipt.hash}`);
              lastEvaluatedHF.delete(pos.address);
            } else if (receipt) {
              logger.warn(`  ❌ tx reverted`);
            }
          }).catch(e => {
            logger.error(`  Execute error: ${e?.shortMessage ?? e?.message ?? e}`);
          });
        }
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
      clearTimeout(safety);
      // Only release the lock if we still own it — safety timer may have already
      // released it and spawned a new cycle that now owns the lock.
      if (cycleSeq === mySeq) {
        refreshing = false;
        // Spawn catch-up only if provider is still the same and we still own the lock.
        if (latestPendingBlock > bn && !shuttingDown && !reconnecting && providerGeneration === cycleGen) {
          setImmediate(() =>
            runCycle(latestPendingBlock).catch(e =>
              logger.error(`Catch-up cycle: ${e?.message ?? e}`)
            )
          );
        }
      }
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // STARTUP
  // ════════════════════════════════════════════════════════════════════════════

  provider = createProvider();
  const httpProvider = new ethers.JsonRpcProvider(CONFIG.rpcUrl, undefined, { staticNetwork: true });

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

  tracker   = new PositionTracker(getProvider);
  oracle    = new AaveOracle(getProvider);
  evaluator = new Evaluator(oracle, getProvider);
  executor  = new Executor(wallet, CONFIG.contractAddress);

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

  // Dormant recheck — wake positions that were parked as healthy.
  // Interval shortened to 5 min (from 15 min) to match the reduced 1-hour
  // dormant window — ensures positions are never stale for longer than ~65 min.
  const DORMANT_WAKE_INTERVAL_MS = 5 * 60 * 1000;
  setInterval(() => {
    if (shuttingDown) return;
    tracker.wakeExpiredDormant();
  }, DORMANT_WAKE_INTERVAL_MS);

  ready = true;
  logger.info("Bot ready — watching for blocks");
  onNewBlock(lastSeenBlock);
}

main().catch(err => {
  logger.error("Fatal:", err);
  process.exit(1);
});
