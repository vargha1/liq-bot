import { ethers } from "ethers";
import { logger } from "./logger";
import { CONFIG, LIQUIDATOR_ABI } from "./config";
import { estimateGasUnits, SAME_ASSET_GAS } from "./evaluator";
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

  constructor(private wallet: ethers.Wallet, contractAddress: string) {
    this.contract = new ethers.Contract(contractAddress, LIQUIDATOR_ABI, wallet);

    // OPT 1: If SUBMIT_RPC_URL is set, use a dedicated provider for tx submission.
    // This can be a lower-latency or geographically closer endpoint to the
    // Arbitrum sequencer, giving us a few ms advantage in FCFS ordering.
    if (CONFIG.submitRpcUrl) {
      const submitProvider = new ethers.JsonRpcProvider(
        CONFIG.submitRpcUrl, undefined, { staticNetwork: true }
      );
      this.submitWallet = wallet.connect(submitProvider);
      logger.info(`Executor: using separate submit RPC (${CONFIG.submitRpcUrl.split("/")[2]})`);
    } else {
      this.submitWallet = wallet;
    }
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
  async execute(opp: LiquidationOpportunity): Promise<ethers.TransactionReceipt | null> {
    // Don't double-liquidate the same borrower
    if (this.inFlight.has(opp.borrower.toLowerCase())) {
      logger.warn(`  → ${opp.borrower.slice(0,10)} already in-flight — skipping`);
      return null;
    }
    // Concurrency cap
    if (this.inFlight.size >= CONFIG.maxConcurrentExecutions) {
      logger.warn(`  → executor at capacity (${this.inFlight.size}/${CONFIG.maxConcurrentExecutions}) — skipping`);
      return null;
    }

    const key = opp.borrower.toLowerCase();
    const promise = this._executeOne(opp).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, promise);
    return promise;
  }

  private async _executeOne(opp: LiquidationOpportunity): Promise<ethers.TransactionReceipt | null> {
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
      const gasLimit = (gasUnits * 120n) / 100n;
      logger.debug(`Gas: fixed=${gasUnits} limit=${gasLimit} (${hops} swap hops)`);

      // ── OPT 1: Timeboost priority fee ──────────────────────────────────────
      // Arbitrum's mempool is private (no front-running), but FCFS ordering means
      // arriving first matters. Among non-express-lane txs, the sequencer orders
      // by arrival time; a higher priority tip also helps beat the 200ms Timeboost
      // artificial delay imposed on non-express-lane transactions.
      // Source: https://docs.arbitrum.io/how-arbitrum-works/timeboost/gentle-introduction
      const feeData      = await this.wallet.provider!.getFeeData();
      const PRIORITY_WEI = BigInt(Math.round(CONFIG.timeboostPriorityGwei * 1e9));
      const basePriority = feeData.maxPriorityFeePerGas ?? PRIORITY_WEI;
      // Use whichever is higher: our configured floor or 1.5× the network tip
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
      // Fetch nonce once and increment manually so parallel calls don't collide.
      if (this.nonce < 0) {
        this.nonce = await this.submitWallet.getNonce();
      }
      const nonce = this.nonce++;
      (txOpts as any).nonce = nonce;

      logger.debug(`Submitting nonce=${nonce} priority=${Number(bumpedPriority)/1e9}gwei`);

      // FIX: compute a deadline (now + deadlineSecs) so stale/stuck txs revert
      // cleanly instead of executing at wrong prices long after opportunity passed.
      const deadline = BigInt(Math.floor(Date.now() / 1000) + CONFIG.deadlineSecs);

      // Submit via the cached dedicated submit contract (OPT 1)
      const tx = await this.getSubmitContract().liquidate(
        opp.collateralAsset,
        opp.debtAsset,
        opp.borrower,
        opp.debtToCover,
        swapPath,
        amountOutMinimum,
        deadline,
        txOpts,
      );

      logger.info(`Tx: ${tx.hash} (nonce=${nonce})`);
      const receipt = await tx.wait(1);

      if (receipt?.status === 1) {
        logger.info(`✅ Confirmed block=${receipt.blockNumber}`);
        this._parseReceipt(receipt);
      } else {
        // On revert, the nonce was consumed — no adjustment needed.
        logger.error(`❌ Reverted: ${tx.hash}`);
      }
      return receipt;

    } catch (err: any) {
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

