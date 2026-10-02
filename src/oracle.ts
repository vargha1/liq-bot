import { ethers } from "ethers";
import { logger } from "./logger";
import { AAVE_ORACLE, ORACLE_ABI, MULTICALL3, MULTICALL3_ABI, RESERVES, PROFILE } from "./config";

const CACHE_TTL = 15_000;

// `estimated` marks a price the bot INFERRED rather than read from the chain —
// pokePrice writes these from a Chainlink answer ratio when a feed event or a
// sequencer-feed hint arrives, ahead of any authoritative getAssetPrice.
//
// The distinction decides whether gas may be committed without confirmation. An
// estimated price is a guess about what Aave's oracle will say; the liquidation
// executes against what it ACTUALLY says. Firing on the guess is how a genuine
// crossing at model HF 0.9971 met a chain that had not crossed yet and reverted
// inside validateLiquidationCall.
//
// `block` is the chain block the value describes (an event's block for an
// estimate, the execution block for a read). It makes writes monotonic: a read
// that resolves late and describes an OLDER block must not overwrite a newer
// price, which is how a slow confirmation used to undo the estimate it followed.
interface PriceEntry { price: bigint; ts: number; estimated?: boolean; block?: number }
const priceCache   = new Map<string, PriceEntry>();

// Every price the cache has held, newest last, for the last HIST_KEEP_MS. Lets a
// caller bound how far a price can have been from "now" at any earlier moment in
// a window (see priceExtremes) — the basis of the trigger's candidate index.
const priceHist = new Map<string, Array<{ ts: number; price: bigint }>>();
const HIST_KEEP_MS = 12 * 60_000;
function recordHist(key: string, price: bigint, ts: number): void {
  if (price <= 0n) return;
  let h = priceHist.get(key);
  if (!h) { h = []; priceHist.set(key, h); }
  const last = h[h.length - 1];
  if (!last || last.price !== price) h.push({ ts, price });
  while (h.length > 1 && h[1]!.ts < ts - HIST_KEEP_MS) h.shift();
}

// Returns true when the entry was stored.
function putPrice(key: string, e: PriceEntry): boolean {
  const cur = priceCache.get(key);
  if (cur && e.block !== undefined && cur.block !== undefined) {
    if (e.estimated) {
      // An estimate for block b is redundant once a read at >= b exists.
      const newer = e.block > cur.block || (cur.estimated === true && e.block >= cur.block);
      if (!newer) return false;
    } else if (e.block < cur.block) {
      return false;   // older read — keep what we have
    }
  }
  priceCache.set(key, e);
  recordHist(key, e.price, e.ts);
  return true;
}

// Permanently dead feeds — never retry after the first confirmed revert.
// Populated at runtime when getAssetPrice reverts with no stale fallback.
// BUG FIX: Added TTL (10 min) so feeds re-enabled upstream are eventually retried.
// A purely permanent blacklist would silently miss an asset if its oracle is fixed.
const DEAD_FEED_TTL_MS = 10 * 60_000; // 10 minutes
const deadFeeds    = new Map<string, number>(); // address → expiry timestamp

function isDeadFeed(addr: string): boolean {
  const exp = deadFeeds.get(addr);
  if (exp === undefined) return false;
  if (Date.now() > exp) { deadFeeds.delete(addr); return false; } // expired — retry
  return true;
}

function markDeadFeed(addr: string): void {
  deadFeeds.set(addr, Date.now() + DEAD_FEED_TTL_MS);
}

const ORACLE_IFACE = new ethers.Interface(ORACLE_ABI);
// Where an L2 block number can be read inside a Multicall3 batch. Arbitrum's
// block.number is the L1 number, so it needs the ArbSys precompile; on chains whose
// block.number is the L2 number (Base) Multicall3's own getBlockNumber() is right.
const BLOCK_CALL = PROFILE.blockNumberSource === "arbsys"
  ? {
      target: "0x0000000000000000000000000000000000000064",
      iface:  new ethers.Interface(["function arbBlockNumber() view returns (uint256)"]),
      fn:     "arbBlockNumber",
    }
  : {
      target: MULTICALL3,
      iface:  new ethers.Interface(["function getBlockNumber() view returns (uint256)"]),
      fn:     "getBlockNumber",
    };

function isTransportGone(err: any): boolean {
  return err?.code === "RPC_BACKPRESSURE"
    || err?.code === "UNSUPPORTED_OPERATION"
    || /provider destroyed|cancelled request/i.test(err?.message ?? "");
}

export class AaveOracle {
  // `_getHotProvider` is the unshared, separately rate-limited endpoint used for
  // the trigger's confirmation reads. Falls back to the normal read provider.
  constructor(
    private _getProvider: () => ethers.Provider,
    private _getHotProvider?: () => ethers.Provider,
  ) {}

  // Cached contracts — rebuilt only when the provider changes (reconnect).
  private _oracleProvider: ethers.Provider | null = null;
  private _oracle!: ethers.Contract;
  private _mc!:     ethers.Contract;
  private _hotProvider: ethers.Provider | null = null;
  private _hotMc!:  ethers.Contract;

  private get oracle(): ethers.Contract {
    const p = this._getProvider();
    if (p !== this._oracleProvider) {
      this._oracleProvider = p;
      this._oracle = new ethers.Contract(AAVE_ORACLE, ORACLE_ABI, p);
      this._mc     = new ethers.Contract(MULTICALL3, MULTICALL3_ABI, p);
    }
    return this._oracle;
  }

  private get multicall(): ethers.Contract { void this.oracle; return this._mc; }

  private get hotMulticall(): ethers.Contract {
    const p = this._getHotProvider ? this._getHotProvider() : this._getProvider();
    if (p !== this._hotProvider) {
      this._hotProvider = p;
      this._hotMc = new ethers.Contract(MULTICALL3, MULTICALL3_ABI, p);
    }
    return this._hotMc;
  }

  // One eth_call reading many prices. Each asset is its own sub-call under
  // tryAggregate, so a single reverting feed costs that asset only —
  // getAssetsPrices reverted the WHOLE batch, which forced a per-asset fan-out
  // on every failure. Failed / zero prices come back as 0n.
  //
  // `block` is the L2 block the read executed at, taken inside the same call
  // (see BLOCK_CALL). On Arbitrum Multicall3's own block number is NOT usable:
  // block.number there is the L1 number (~26M against an L2 head of ~510M), which
  // would make every read look ancient next to an event's block.
  private async fetchMany(
    addrs: string[], hot: boolean, blockTag?: number,
  ): Promise<{ block: number | undefined; prices: Map<string, bigint> }> {
    const mc = hot ? this.hotMulticall : this.multicall;
    const calls = addrs.map(a => ({
      target:   AAVE_ORACLE,
      callData: ORACLE_IFACE.encodeFunctionData("getAssetPrice", [a]),
    }));
    calls.push({ target: BLOCK_CALL.target, callData: BLOCK_CALL.iface.encodeFunctionData(BLOCK_CALL.fn) });
    const results: Array<{ success: boolean; returnData: string }> = blockTag !== undefined
      ? await mc.tryAggregate!.staticCall(false, calls, { blockTag })
      : await mc.tryAggregate!.staticCall(false, calls);

    let block: number | undefined = blockTag;
    const last = results[addrs.length];
    if (last?.success && last.returnData !== "0x") {
      try { block = Number(BLOCK_CALL.iface.decodeFunctionResult(BLOCK_CALL.fn, last.returnData)[0] as bigint); }
      catch { /* keep blockTag / undefined */ }
    }
    const prices = new Map<string, bigint>();
    for (let i = 0; i < addrs.length; i++) {
      const r = results[i];
      let price = 0n;
      if (r?.success && r.returnData !== "0x") {
        try { price = ORACLE_IFACE.decodeFunctionResult("getAssetPrice", r.returnData)[0] as bigint; }
        catch { /* leave 0n */ }
      }
      prices.set(addrs[i]!.toLowerCase(), price);
    }
    return { block, prices };
  }

  // Returns price in USD with 8 decimals (Aave base currency)
  async getPrice(tokenAddress: string): Promise<bigint> {
    const key = tokenAddress.toLowerCase();
    if (isDeadFeed(key)) return 0n;
    const cached = priceCache.get(key);
    if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.price;
    try {
      const price: bigint = await this.oracle.getAssetPrice(tokenAddress);
      putPrice(key, { price, ts: Date.now() });
      return priceCache.get(key)?.price ?? price;
    } catch (err: any) {
      // Don't warn on provider-destroyed errors — just serve stale/zero silently
      if (!(err.code === 'UNSUPPORTED_OPERATION' || /provider destroyed|cancelled request/i.test(err.message ?? ''))) {
        logger.warn(`Oracle price failed for ${tokenAddress}: ${err.message}`);
      }
      return cached?.price ?? 0n;
    }
  }

  // Batch price read — one RPC call for multiple assets, isolated per asset.
  // Known-dead feeds are skipped entirely (no RPC call, return 0n immediately).
  // `force` bypasses the TTL: the background prefetch needs a genuinely fresh
  // read every tick, not a cache hit that a poked estimate keeps warm. Estimated
  // entries are never served from cache here for the same reason.
  async getPrices(tokenAddresses: string[], force = false): Promise<Map<string, bigint>> {
    const unique = [...new Set(tokenAddresses.map(a => a.toLowerCase()))];
    const now    = Date.now();

    const fresh  = new Map<string, bigint>();
    const toFetch: string[] = [];

    for (const addr of unique) {
      // Skip permanently dead feeds without any RPC call
      if (isDeadFeed(addr)) { fresh.set(addr, 0n); continue; }
      const c = priceCache.get(addr);
      if (!force && c && !c.estimated && now - c.ts < CACHE_TTL) { fresh.set(addr, c.price); }
      else { toFetch.push(addr); }
    }

    if (toFetch.length > 0) {
      try {
        const { block, prices } = await this.fetchMany(toFetch, false);
        for (const addr of toFetch) {
          const price = prices.get(addr) ?? 0n;
          if (price > 0n) {
            putPrice(addr, { price, ts: now, block });
            fresh.set(addr, priceCache.get(addr)?.price ?? price);
          } else {
            const stale = priceCache.get(addr);
            if (stale) {
              fresh.set(addr, stale.price);
              logger.debug(`Oracle: stale price used for ${addr}`);
            } else {
              // No stale fallback — this feed is dead. Blacklist it with TTL so it
              // is not re-read every tick, but is retried after 10 min.
              markDeadFeed(addr);
              fresh.set(addr, 0n);
              logger.warn(`Oracle: feed dead for ${addr} — blacklisted for ${DEAD_FEED_TTL_MS/60000} min`);
            }
          }
        }
      } catch (err: any) {
        // Transport-level failure (shed by the limiter, socket gone): serve stale
        // and do NOT retry per asset — that would pour more calls into a budget
        // that is already spent.
        if (!isTransportGone(err)) logger.warn(`Oracle batch failed: ${err?.message ?? err}`);
        else logger.debug(`Oracle batch aborted (${err.code ?? "provider destroyed"}) — serving stale/zero prices`);
        for (const addr of toFetch) fresh.set(addr, priceCache.get(addr)?.price ?? 0n);
      }
    }

    const result = new Map<string, bigint>();
    for (const addr of tokenAddresses) {
      result.set(addr.toLowerCase(), fresh.get(addr.toLowerCase()) ?? 0n);
    }
    return result;
  }

  // Pre-fetch ALL reserve prices in a single call, excluding known-dead feeds.
  async prefetchAllPrices(force = false): Promise<Map<string, bigint>> {
    const allAddrs = Object.values(RESERVES)
      .map(r => r.address)
      .filter(a => !isDeadFeed(a.toLowerCase()));
    return this.getPrices(allAddrs, force);
  }

  // Rolling price history for drop detection.
  // Stores timestamped snapshots per asset so we can compare "now" vs "N minutes ago"
  // rather than just the previous cycle (~250ms). A gradual crash of 0.3%/block over
  // 10 blocks = 3% total but never 2% in one block — cycle-to-cycle comparison misses it.
  // With a 5-minute window, that same crash is detected as a 3% drop correctly.
  //
  // Structure: address → array of { price, ts } snapshots, oldest first.
  // We keep only snapshots within the longest window (15 min) to bound memory.
  private _priceHistory = new Map<string, Array<{ price: bigint; ts: number }>>();

  // Check windows: compare current price to the snapshot closest to N minutes ago.
  // Multiple windows let us catch both fast crashes (1 min) and slow bleeds (15 min).
  private static readonly DROP_WINDOWS_MS = [
    1  * 60_000,   //  1 min  — catches flash crashes
    5  * 60_000,   //  5 min  — catches typical liquidation-wave crashes
    15 * 60_000,   // 15 min  — catches slow bleeds / gradual deleveraging
  ];
  private static readonly HISTORY_TTL_MS  = 16 * 60_000; // keep 16 min of history
  static readonly PRICE_DROP_THRESHOLD    = 0.02;         // 2% drop over any window triggers wake

  // Latch per asset: the price a drop was last reported at.
  //
  // Without this, a drop stays "detected" for as long as its reference snapshot
  // remains in the history window. A single 2.2% ARB move at 21:23 was therefore
  // re-reported on every prefetch tick for the following 15 minutes — the log
  // shows the identical "0.1248 → 0.1220" line five times in 64 seconds — and
  // each report re-ran the full wake path, churning hundreds of dormant
  // positions back into the active set over and over for one price move that had
  // already been handled the first time.
  //
  // A drop is reported once. It is reported again only if the price makes a NEW
  // low below the latched level (genuinely new information), or if the price has
  // recovered above it, which re-arms the detector for the next move.
  private _dropLatch = new Map<string, bigint>();
  // Recovery band: the price must climb this far back above the latched low
  // before the asset re-arms, so a price oscillating around the latch doesn't
  // re-fire on every tick.
  private static readonly DROP_REARM_BPS = 50n; // +0.5%

  // Returns assets that dropped >= threshold over ANY of the check windows.
  async prefetchAllPricesWithDropDetection(force = false): Promise<{
    prices:        Map<string, bigint>;
    droppedAssets: Set<string>;  // lowercase addresses with meaningful price drop
  }> {
    const now    = Date.now();
    const prices = await this.prefetchAllPrices(force);
    const droppedAssets = new Set<string>();

    for (const [addr, newPrice] of prices) {
      if (newPrice === 0n) continue;
      const key = addr.toLowerCase();

      // Append current price to history
      const history = this._priceHistory.get(key) ?? [];
      history.push({ price: newPrice, ts: now });

      // Evict entries older than HISTORY_TTL_MS
      const cutoff = now - AaveOracle.HISTORY_TTL_MS;
      let startIdx = 0;
      while (startIdx < history.length - 1 && history[startIdx]!.ts < cutoff) startIdx++;
      if (startIdx > 0) history.splice(0, startIdx);

      this._priceHistory.set(key, history);

      // Check each time window
      for (const windowMs of AaveOracle.DROP_WINDOWS_MS) {
        const targetTs = now - windowMs;
        // Find the snapshot closest to targetTs (oldest entry >= targetTs, or the oldest overall)
        const ref = history.find(h => h.ts >= targetTs) ?? history[0];
        if (!ref || ref.price === 0n || ref.ts === now) continue; // only one snapshot yet

        // Only compare if the reference snapshot is at least half the window old
        // (avoids false positives when history is sparse at startup)
        if (now - ref.ts < windowMs / 2) continue;

        if (newPrice < ref.price) {
          const dropBps = Number((ref.price - newPrice) * 10_000n / ref.price);
          if (dropBps >= AaveOracle.PRICE_DROP_THRESHOLD * 10_000) {
            // Already reported at or below this price — the wake for it has
            // happened, and repeating it just churns the dormant tier.
            const latched = this._dropLatch.get(key);
            if (latched !== undefined && newPrice >= latched) break;

            this._dropLatch.set(key, newPrice);
            droppedAssets.add(key);
            const windowMin = (windowMs / 60_000).toFixed(0);
            logger.info(
              `⚡ Price drop detected: ${addr.slice(0, 10)}… ` +
              `${(dropBps / 100).toFixed(2)}% over ${windowMin}min ` +
              `(${(Number(ref.price) / 1e8).toFixed(4)} → ${(Number(newPrice) / 1e8).toFixed(4)})`
            );
            break; // one window match is enough — no need to check longer windows
          }
        }
      }

      // Re-arm once the price has recovered clear of the latched low, so the
      // next genuine drop is reported normally.
      const latched = this._dropLatch.get(key);
      if (latched !== undefined) {
        const rearmAt = latched + (latched * AaveOracle.DROP_REARM_BPS) / 10_000n;
        if (newPrice > rearmAt) this._dropLatch.delete(key);
      }
    }

    return { prices, droppedAssets };
  }

  // ── Trigger-engine accessors ────────────────────────────────────────────────
  // The Chainlink AnswerUpdated trigger needs synchronous access to the latest
  // known prices: read the cache, write an estimated price into it, force a
  // refresh past the TTL, and snapshot every reserve price without RPC.

  peekPrice(tokenAddress: string): bigint | null {
    const c = priceCache.get(tokenAddress.toLowerCase());
    return c ? c.price : null;
  }

  // `block` is the block of the Chainlink event the estimate was derived from.
  // Returns false when a newer or equal authoritative read already exists.
  pokePrice(tokenAddress: string, price: bigint, block?: number): boolean {
    return putPrice(tokenAddress.toLowerCase(), { price, ts: Date.now(), estimated: true, block });
  }

  /** True when the cached price for this asset was inferred, not read on-chain. */
  isEstimated(tokenAddress: string): boolean {
    return priceCache.get(tokenAddress.toLowerCase())?.estimated === true;
  }

  /**
   * Lowest and highest price this asset has held at any point in the last
   * `windowMs`, including the price in force when the window opened. Null when
   * there is no history.
   */
  priceExtremes(tokenAddress: string, windowMs: number): { lo: bigint; hi: bigint } | null {
    const h = priceHist.get(tokenAddress.toLowerCase());
    if (!h || h.length === 0) return null;
    const cutoff = Date.now() - windowMs;
    let lo = h[h.length - 1]!.price, hi = lo;
    for (let i = h.length - 1; i >= 0; i--) {
      const p = h[i]!.price;
      if (p < lo) lo = p;
      if (p > hi) hi = p;
      if (h[i]!.ts < cutoff) break;   // this sample was in force at the window start
    }
    return { lo, hi };
  }

  /** Age in ms of the OLDEST cached price among these assets (Infinity if any is missing). */
  maxAgeMs(addresses: Iterable<string>): number {
    const now = Date.now();
    let oldest = 0;
    for (const a of addresses) {
      const c = priceCache.get(a.toLowerCase());
      if (!c) return Infinity;
      oldest = Math.max(oldest, now - c.ts);
    }
    return oldest;
  }

  /** True if ANY of these assets is currently priced from an estimate. */
  anyEstimated(addresses: Iterable<string>): boolean {
    for (const a of addresses) if (this.isEstimated(a)) return true;
    return false;
  }

  // Authoritative batched read on the HOT provider, past the cache TTL.
  //
  // One Chainlink aggregator can back many Aave reserves (ETH/USD alone prices
  // WETH, wstETH, rETH, weETH, ezETH and rsETH), so a feed event needs a
  // confirmation for all of them at once. `blockTag` pins the read to the
  // event's block: an unpinned read may land on a node that has not yet imported
  // that block and return the PRE-update price, which would then be cached as
  // "confirmed" and clear the very estimate that was right. If the node does not
  // have the block yet the call throws, and we retry briefly before giving up.
  //
  // Returns { block, prices }; prices holds the cached value for any asset that
  // failed. The cache is updated monotonically (see putPrice).
  async refreshPrices(
    tokenAddresses: string[], blockTag?: number,
  ): Promise<{ block: number | null; prices: Map<string, bigint> }> {
    const unique = [...new Set(tokenAddresses.map(a => a.toLowerCase()))];
    const out = new Map<string, bigint>();
    if (unique.length === 0) return { block: null, prices: out };

    const attempts = blockTag !== undefined ? 3 : 1;
    for (let i = 0; i < attempts; i++) {
      try {
        const { block, prices } = await this.fetchMany(unique, true, blockTag);
        const now = Date.now();
        for (const addr of unique) {
          const price = prices.get(addr) ?? 0n;
          if (price > 0n) {
            putPrice(addr, { price, ts: now, block });
            out.set(addr, price);
          } else {
            out.set(addr, priceCache.get(addr)?.price ?? 0n);
          }
        }
        return { block: block ?? null, prices: out };
      } catch {
        if (i < attempts - 1) await new Promise(r => setTimeout(r, 60));
      }
    }
    // Serve what we have rather than fan out on the hot path; the background
    // prefetch sorts out a genuinely dead feed.
    for (const addr of unique) out.set(addr, priceCache.get(addr)?.price ?? 0n);
    return { block: null, prices: out };
  }

  // Latest known price for EVERY reserve (0n where nothing cached yet).
  snapshotAllPrices(): Map<string, bigint> {
    const out = new Map<string, bigint>();
    for (const r of Object.values(RESERVES)) {
      const c = priceCache.get(r.address.toLowerCase());
      out.set(r.address.toLowerCase(), c ? c.price : 0n);
    }
    return out;
  }

  async toUsd8(tokenAddress: string, rawAmount: bigint, decimals: number): Promise<bigint> {
    const price = await this.getPrice(tokenAddress);
    return (price * rawAmount) / BigInt(10 ** decimals);
  }

  toUsdNumber(usd8: bigint): number {
    return Number(usd8) / 1e8;
  }

  // Expose dead feed list for diagnostics
  getDeadFeeds(): string[] { return [...deadFeeds.keys()]; }
}
