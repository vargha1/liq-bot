import { ethers } from "ethers";
import { logger } from "./logger";
import { CONFIG, LIQUIDATOR_ABI, ARBITRUM_SEQUENCER_RPC, CHAIN_ID } from "./config";
import { estimateGasUnits, SAME_ASSET_GAS } from "./evaluator";
import { metrics } from "./metrics";
import type { LiquidationOpportunity } from "./types";

// Re-export so index.ts doesn't need to change its import
export { estimateGasUnits };

// Count Uniswap V3 path hops from encoded path bytes
// Path: 20-byte token + (3-byte fee + 20-byte token) * N => hops = (bytes-20)/23
function hopsFromPath(swapPath: string): number {
  if (!swapPath || swapPath === "0x") return 0;
  const bytes = (swapPath.length - 2) / 2;
  return Math.max(1, Math.round((bytes - 20) / 23));
}

type CooldownCause = "success" | "failure" | "external";
interface CooldownEntry { ts: number; cause: CooldownCause }

const COOLDOWN_SUCCESS_MS   = 30_000; // position is gone — no point retrying soon
const COOLDOWN_FAILURE_MS   = 3_000;  // our own tx failed — retry quickly (may have been transient)
const COOLDOWN_EXTERNAL_MS  = 30_000; // a competitor liquidated the borrower

function cooldownMsFor(cause: CooldownCause): number {
  switch (cause) {
    case "success":  return COOLDOWN_SUCCESS_MS;
    case "failure":  return COOLDOWN_FAILURE_MS;
    case "external": return COOLDOWN_EXTERNAL_MS;
  }
}

export class Executor {
  private contract:    ethers.Contract;
  private submitWallet: ethers.Wallet;  // OPT 1: separate wallet for submission RPC

  // FIX: cache the submit-contract instance — creating new ethers.Contract
  // (with full ABI parse) on every liquidation was wasteful.
  private _submitContract: ethers.Contract | null = null;

  private getSubmitContract(): ethers.Contract {
    if (!this._submitContract) {
      this._submitContract = new ethers.Contract(
        this.contract.target as string, LIQUIDATOR_ABI, this.submitWallet,
      );
    }
    return this._submitContract;
  }

  // OPT 3: Parallel execution queue — track in-flight txs by borrower address.
  // Prevents double-execution of the same borrower while allowing different
  // borrowers to be liquidated concurrently (each uses its own nonce slot).
  private inFlight = new Map<string, Promise<ethers.TransactionReceipt | null>>();
  private nonce    = -1;  // managed manually to allow parallel submissions

  // Recently-attempted map with per-cause cooldowns. Distinguishes:
  //   success  — we liquidated it (30s)
  //   failure  — OUR tx failed for a transient reason (3s, then retry allowed)
  //   external — a competitor's LiquidationCall event was seen (30s)
  private recentlyExecuted = new Map<string, CooldownEntry>();

  // Clock skew between local machine and the chain. The on-chain deadline guard
  // compares against block.timestamp, so a skewed host clock makes deadlines
  // wrong in either direction. Calibrated once a minute against latest block ts.
  private _clockSkewMs = 0;

  // Stateless HTTP provider (index.ts's read provider). The main wallet rides on
  // the WebSocket, which is destroyed and rebuilt on every reconnect — during
  // that window eth_sendRawTransaction and receipt polling both fail against a
  // dead socket. Broadcasting and polling here too costs nothing and keeps
  // submission alive across reconnects.
  private fallbackProvider: ethers.JsonRpcProvider | null = null;

  // Broadcast-only. Never polled for receipts or reads — the sequencer endpoint
  // exists to shave the forwarding hop off submission, nothing else.
  private sequencerProvider: ethers.JsonRpcProvider | null = null;
  private sequencerFailures = 0;

  // Supplies the cycle's cached fee data. The trigger engine calls execute()
  // without an override, so without this the single most latency-critical path
  // in the bot paid for a getFeeData round-trip before it could even sign.
  private feeDataSource: (() => ethers.FeeData | null) | null = null;

  setFeeDataSource(fn: () => ethers.FeeData | null): void { this.feeDataSource = fn; }

  constructor(
    private wallet: ethers.Wallet,
    contractAddress: string,
    fallbackProvider?: ethers.JsonRpcProvider,
  ) {
    this.contract = new ethers.Contract(contractAddress, LIQUIDATOR_ABI, wallet);
    this.fallbackProvider = fallbackProvider ?? null;

    if (CONFIG.broadcastToSequencer) {
      try {
        // Submission-only endpoint: it serves eth_sendRawTransaction but not
        // eth_blockNumber/eth_chainId, so the network is pinned explicitly and
        // staticNetwork stops ethers probing for a chain id it cannot answer.
        this.sequencerProvider = new ethers.JsonRpcProvider(
          ARBITRUM_SEQUENCER_RPC, CHAIN_ID, { staticNetwork: true },
        );
        logger.info(`Executor: also broadcasting to Arbitrum sequencer (${ARBITRUM_SEQUENCER_RPC})`);
      } catch (e: any) {
        logger.warn(`Executor: sequencer endpoint unavailable: ${e?.message ?? e}`);
      }
    }

    // OPT 1: If SUBMIT_RPC_URL is set, use a dedicated provider for tx submission.
    // This can be a lower-latency or geographically closer endpoint to the
    // Arbitrum sequencer, giving us a few ms FCFS ordering advantage.
    if (CONFIG.submitRpcUrl) {
      const submitProvider = new ethers.JsonRpcProvider(
        CONFIG.submitRpcUrl, undefined, { staticNetwork: true }
      );
      this.submitWallet = wallet.connect(submitProvider);
      logger.info(`Executor: using separate submit RPC (${CONFIG.submitRpcUrl.split("/")[2]})`);
    } else {
      this.submitWallet = wallet;
    }

    // Cleanup expired cooldown entries
    setInterval(() => {
      const cutoff = Date.now() - Math.max(COOLDOWN_SUCCESS_MS, COOLDOWN_EXTERNAL_MS) * 2;
      for (const [k, v] of this.recentlyExecuted) {
        if (v.ts < cutoff) this.recentlyExecuted.delete(k);
      }
    }, 60_000);

    // Bug #5 fix: periodic nonce sync to detect desync after dropped/replaced txs
    setInterval(async () => {
      if (this.nonce >= 0) {
        try {
          const onChainNonce = await this.submitWallet.getNonce();
          if (onChainNonce !== this.nonce) {
            logger.warn(`Nonce desync: local=${this.nonce} on-chain=${onChainNonce} — resetting`);
            this.nonce = onChainNonce;
          }
        } catch { /* ignore — provider may be reconnecting */ }
      }
    }, 30_000);

    // Clock-skew calibration against the chain clock
    const calibrateClock = async () => {
      try {
        const block = await this.wallet.provider!.getBlock("latest");
        if (block?.timestamp) {
          this._clockSkewMs = block.timestamp * 1000 - Date.now();
          if (Math.abs(this._clockSkewMs) > 5_000) {
            logger.warn(`Clock skew vs chain: ${Math.round(this._clockSkewMs / 1000)}s — deadlines adjusted`);
          }
        }
      } catch { /* ignore */ }
    };
    calibrateClock();
    setInterval(calibrateClock, 60_000);
  }

  // Called by index.ts when a competitor's LiquidationCall is observed on a
  // borrower we track. Lets execute() skip instantly with an accurate reason
  // instead of waiting out the generic cooldown.
  noteExternalLiquidation(borrower: string): void {
    this.recentlyExecuted.set(borrower.toLowerCase(), { ts: Date.now(), cause: "external" });
  }

  // OPT 3: isExecuting is true only if we've hit the concurrency cap.
  get isExecuting(): boolean {
    return this.inFlight.size >= CONFIG.maxConcurrentExecutions;
  }

  // Number of currently in-flight liquidations.
  get inFlightCount(): number { return this.inFlight.size; }

  attachProvider(provider: ethers.Provider): void {
    this.wallet       = this.wallet.connect(provider);
    this.submitWallet = CONFIG.submitRpcUrl ? this.submitWallet : this.wallet;
    this.contract     = new ethers.Contract(this.contract.target as string, LIQUIDATOR_ABI, this.wallet);
    this._submitContract = null;  // FIX: invalidate cached submit contract on reconnect
    this.nonce        = -1;  // reset nonce on reconnect
  }

  // OPT 3: Execute with parallel queue support.
  // Returns immediately if this borrower is already being liquidated.
  // Allows up to CONFIG.maxConcurrentExecutions simultaneous executions.
  async execute(opp: LiquidationOpportunity, currentBlock: bigint = 0n, feeDataOverride?: ethers.FeeData): Promise<ethers.TransactionReceipt | null> {
    const key = opp.borrower.toLowerCase();

    // Per-cause cooldown check
    const entry = this.recentlyExecuted.get(key);
    if (entry) {
      const limit = cooldownMsFor(entry.cause);
      const age = Date.now() - entry.ts;
      if (age < limit) {
        if (entry.cause === "external") {
          logger.info(`  → ${key.slice(0,10)} already liquidated by competitor — skipping`);
        } else {
          logger.debug(`  → ${key.slice(0,10)} recent ${entry.cause} ${age}ms ago (<${limit}ms) — skipping`);
        }
        return null;
      }
    }

    // Don't double-liquidate the same borrower
    if (this.inFlight.has(key)) {
      logger.warn(`  → ${key.slice(0,10)} already in-flight — skipping`);
      return null;
    }
    // Concurrency cap
    if (this.inFlight.size >= CONFIG.maxConcurrentExecutions) {
      logger.warn(`  → executor at capacity (${this.inFlight.size}/${CONFIG.maxConcurrentExecutions}) — skipping`);
      return null;
    }

    const promise = this._executeOne(opp, feeDataOverride).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, promise);
    return promise;
  }

  private async _executeOne(opp: LiquidationOpportunity, feeDataOverride?: ethers.FeeData): Promise<ethers.TransactionReceipt | null> {
    const key = opp.borrower.toLowerCase();
    const e2eStart = performance.now();
    try {
      logger.info(
        `Liquidating ${opp.borrower.slice(0, 10)}... | HF=${opp.healthFactor.toFixed(4)} | ` +
        `${opp.collateralSymbol}->>${opp.debtSymbol} | ` +
        `debt=$${opp.debtToCoverUsd.toFixed(2)} bonus=$${opp.expectedBonusUsd.toFixed(2)} net=$${opp.netProfitUsd.toFixed(2)}`
      );

      const swapPath         = opp.swapPath         ?? "0x";
      const amountOutMinimum = opp.amountOutMinimum ?? 0n;

      const isSameAsset = opp.collateralAsset.toLowerCase() === opp.debtAsset.toLowerCase();
      if (!isSameAsset && (!swapPath || swapPath === "0x")) {
        logger.error("execute: missing swapPath for different-asset liquidation");
        return null;
      }

      const hops     = hopsFromPath(swapPath);
      const gasUnits = isSameAsset ? SAME_ASSET_GAS : estimateGasUnits(hops);
      // Generous buffer: Arbitrum refunds unused L2 gas and its L1 data fee
      // scales with CALDATA SIZE, not the gas limit — so a large limit costs
      // nothing extra and eliminates out-of-gas reverts on multi-hop swaps.
      const gasLimit = gasUnits + 1_500_000n;
      logger.debug(`Gas: est=${gasUnits} limit=${gasLimit} (${hops} swap hops)`);

      // NOTE on ordering: Arbitrum sequences FCFS by arrival time — priority
      // tips do not reorder transactions. What wins races is arriving first
      // (detection latency) and, optionally, the Timeboost express lane.
      // We still set a modest tip because it is free and harmless.
      const feeData      = feeDataOverride ?? this.feeDataSource?.() ?? await this.getFeeDataResilient();
      const PRIORITY_WEI = BigInt(Math.round(CONFIG.timeboostPriorityGwei * 1e9));
      const basePriority = feeData.maxPriorityFeePerGas ?? PRIORITY_WEI;
      const bumpedPriority = basePriority > PRIORITY_WEI
        ? (basePriority * 15n) / 10n
        : PRIORITY_WEI;
      const bumpedMax = feeData.maxFeePerGas && feeData.maxFeePerGas > bumpedPriority
        ? feeData.maxFeePerGas : bumpedPriority;

      const txOpts: ethers.Overrides = {
        gasLimit,
        ...(feeData.maxFeePerGas
          ? { maxFeePerGas: bumpedMax, maxPriorityFeePerGas: bumpedPriority }
          : { gasPrice: feeData.gasPrice ?? 100_000_000n }),
      };

      // ── OPT 3: Nonce management for parallel submissions ───────────────────
      if (this.nonce < 0) {
        this.nonce = await this.submitWallet.getNonce();
      }
      const nonce = this.nonce++;
      (txOpts as any).nonce = nonce;

      logger.debug(`Submitting nonce=${nonce}`);

      // Deadline from CHAIN time (calibrated), not host clock — the contract
      // compares against block.timestamp.
      const chainNowMs = Date.now() + this._clockSkewMs;
      const deadline   = BigInt(Math.floor(chainNowMs / 1000) + CONFIG.deadlineSecs);

      // Sign once, broadcast to every available endpoint simultaneously.
      // First sequencer ack wins; duplicates are idempotent (same hash).
      const t0 = performance.now();
      const populatedTx = await this.getSubmitContract().liquidate.populateTransaction(
        opp.collateralAsset,
        opp.debtAsset,
        opp.borrower,
        opp.debtToCover,
        swapPath,
        amountOutMinimum,
        deadline,
        txOpts,
      );
      const signedTx = await this.submitWallet.signTransaction(populatedTx);
      const signedHash = ethers.keccak256(signedTx);

      const endpoints = this.broadcastEndpoints();
      const sendResults = await Promise.allSettled(
        endpoints.map(p =>
          p.send("eth_sendRawTransaction", [signedTx]).then(() => { return performance.now() - t0; })
        )
      );
      // If the sequencer endpoint is unreachable from this host, stop paying for
      // a doomed request on every liquidation. Other endpoints already carry the
      // transaction, so losing it costs latency, not correctness.
      if (this.sequencerProvider && endpoints[0] === (this.sequencerProvider as unknown as ethers.JsonRpcApiProvider)) {
        if (sendResults[0]?.status === "rejected") {
          if (++this.sequencerFailures >= 3) {
            logger.warn("Executor: sequencer broadcast failed 3× — disabling it; other endpoints still carry the transaction");
            this.sequencerProvider = null;
          }
        } else {
          this.sequencerFailures = 0;
        }
      }

      const acked = sendResults.filter(r => r.status === "fulfilled") as PromiseFulfilledResult<number>[];
      const submitMs = performance.now() - t0;
      metrics.record("exec.submit", submitMs);

      if (acked.length === 0) {
        const firstErr = (sendResults[0] as PromiseRejectedResult).reason;
        throw firstErr instanceof Error ? firstErr : new Error(String(firstErr));
      }
      if (acked.length < endpoints.length) {
        logger.warn(`Broadcast: only ${acked.length}/${endpoints.length} endpoints accepted the tx`);
      }
      logger.info(`Tx: ${signedHash} (nonce=${nonce}, seq-ack=${Math.round(submitMs)}ms via ${acked.length}/${endpoints.length} endpoint${endpoints.length > 1 ? "s" : ""})`);

      // Wait for confirmation on the primary provider with a timeout — dropped
      // txs must not block the nonce slot forever.
      const receipt = await this.waitForReceipt(this.receiptProviders(), signedHash, 120_000);
      const confirmMs = performance.now() - t0;
      metrics.record("exec.e2e", performance.now() - e2eStart);
      if (receipt) metrics.record("exec.confirm", confirmMs - submitMs);

      if (receipt?.status === 1) {
        logger.info(`✅ Confirmed block=${receipt.blockNumber}`);
        this.recentlyExecuted.set(key, { ts: Date.now(), cause: "success" });
        this._parseReceipt(receipt);
      } else if (receipt) {
        // Reverted — mark short failure cooldown so we retry fast but don't loop.
        this.recentlyExecuted.set(key, { ts: Date.now(), cause: "failure" });
        logger.error(`❌ Reverted: ${signedHash}`);
      } else {
        this.recentlyExecuted.set(key, { ts: Date.now(), cause: "failure" });
        logger.error(`❌ Confirmation timeout: ${signedHash}`);
      }
      return receipt;

    } catch (err: any) {
      this.recentlyExecuted.set(opp.borrower.toLowerCase(), { ts: Date.now(), cause: "failure" });
      // If nonce was wrong (race condition), reset so next call re-fetches
      if (/nonce|replacement/i.test(err?.message ?? "")) {
        this.nonce = -1;
        logger.warn(`Executor: nonce error — reset. ${err?.shortMessage ?? err?.message}`);
      } else {
        logger.error(`Executor: ${err?.shortMessage ?? err?.message ?? err}`);
      }
      return null;
    }
  }

  // Unique providers to broadcast to: dedicated submit endpoint (if configured)
  // plus the main provider. Broadcasting the same signed tx to both costs
  // nothing and removes single-endpoint stalls from the race.
  private broadcastEndpoints(): ethers.JsonRpcApiProvider[] {
    const eps: ethers.JsonRpcApiProvider[] = [];
    const submitP   = this.submitWallet.provider as ethers.JsonRpcApiProvider | null;
    const mainP     = this.wallet.provider       as ethers.JsonRpcApiProvider | null;
    const fallbackP = this.fallbackProvider      as ethers.JsonRpcApiProvider | null;
    const seqP      = this.sequencerProvider     as ethers.JsonRpcApiProvider | null;
    // Sequencer first: it is the endpoint with the fewest hops to the thing that
    // actually decides ordering, and Promise.allSettled dispatches in order.
    for (const p of [seqP, submitP, mainP, fallbackP]) {
      if (p && !eps.includes(p)) eps.push(p);
    }
    return eps;
  }

  // getFeeData against the WS provider throws while it is being replaced, which
  // would abort an otherwise-valid liquidation. Try each endpoint in turn.
  private async getFeeDataResilient(): Promise<ethers.FeeData> {
    let lastErr: unknown;
    for (const p of this.receiptProviders()) {
      try { return await p.getFeeData(); } catch (e) { lastErr = e; }
    }
    throw lastErr instanceof Error ? lastErr : new Error("getFeeData failed on all endpoints");
  }

  // Providers to poll for a receipt, primary first. Includes the HTTP fallback
  // so a mid-flight WS reconnect doesn't turn every confirmed tx into a
  // "confirmation timeout".
  private receiptProviders(): ethers.Provider[] {
    const out: ethers.Provider[] = [];
    for (const p of [this.submitWallet.provider, this.wallet.provider, this.fallbackProvider]) {
      if (p && !out.includes(p)) out.push(p);
    }
    return out;
  }

  // Receipt polling loop — avoids relying on provider-specific wait APIs and
  // survives WS hiccups better than tx.wait().
  private async waitForReceipt(
    providers: ethers.Provider[],
    hash: string,
    timeoutMs: number,
  ): Promise<ethers.TransactionReceipt | null> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      // One call per round in the normal case. Only fail OVER to the next
      // endpoint when this one throws — a null receipt means "not mined yet",
      // which every endpoint would answer identically, so asking all of them
      // would triple the poll cost for nothing.
      for (const provider of providers) {
        try {
          const r = await provider.getTransactionReceipt(hash);
          if (r) return r;
          break;  // answered, just not mined — wait and retry on this endpoint
        } catch { /* dead socket or transient — try the next endpoint */ }
      }
      await new Promise(res => setTimeout(res, 2_000));
    }
    return null;
  }

  private _parseReceipt(receipt: ethers.TransactionReceipt): void {
    const iface = new ethers.Interface(LIQUIDATOR_ABI);
    for (const log of receipt.logs) {
      try {
        const p = iface.parseLog(log);
        if (p?.name === "LiquidationExecuted") {
          const { borrower, collateralAsset, debtAsset, debtCovered, collateralReceived, profitRaw, flashloanPremium } = p.args;
          logger.info(
            `LiquidationExecuted | borrower=${borrower.slice(0,10)}... | ` +
            `debt=${debtCovered} col=${collateralReceived} profit=${profitRaw} premium=${flashloanPremium}`
          );
        }
      } catch { /* non-matching log */ }
    }
    const gasCost = receipt.gasUsed * (receipt.gasPrice ?? 0n);
    logger.info(`Gas: ${receipt.gasUsed} | ${ethers.formatEther(gasCost)} ETH`);
  }

  async withdraw(tokenAddress: string): Promise<void> {
    const tx = await this.contract.withdraw(tokenAddress);
    await tx.wait(1);
    logger.info(`Withdrawn ${tokenAddress}: ${tx.hash}`);
  }
}
