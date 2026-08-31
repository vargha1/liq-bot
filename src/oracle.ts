import { ethers } from "ethers";
import { logger } from "./logger";
import { AAVE_ORACLE, ORACLE_ABI, RESERVES } from "./config";

const CACHE_TTL = 15_000;

const priceCache   = new Map<string, { price: bigint; ts: number }>();
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

export class AaveOracle {
  constructor(private _getProvider: () => ethers.Provider) {}

  // Cached contract — rebuilt only when provider changes (reconnect).
  private _oracleProvider: ethers.Provider | null = null;
  private _oracle!: ethers.Contract;

  private get oracle(): ethers.Contract {
    const p = this._getProvider();
    if (p !== this._oracleProvider) {
      this._oracleProvider = p;
      this._oracle = new ethers.Contract(AAVE_ORACLE, ORACLE_ABI, p);
    }
    return this._oracle;
  }

  // Returns price in USD with 8 decimals (Aave base currency)
  async getPrice(tokenAddress: string): Promise<bigint> {
    const key = tokenAddress.toLowerCase();
    if (isDeadFeed(key)) return 0n;
    const cached = priceCache.get(key);
    if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.price;
    try {
      const price: bigint = await this.oracle.getAssetPrice(tokenAddress);
      priceCache.set(key, { price, ts: Date.now() });
      return price;
    } catch (err: any) {
      // Don't warn on provider-destroyed errors — just serve stale/zero silently
      if (!(err.code === 'UNSUPPORTED_OPERATION' || /provider destroyed|cancelled request/i.test(err.message ?? ''))) {
        logger.warn(`Oracle price failed for ${tokenAddress}: ${err.message}`);
      }
      return cached?.price ?? 0n;
    }
  }

  // Batch price read — single RPC call for multiple assets.
  // Known-dead feeds are skipped entirely (no RPC call, return 0n immediately).
  async getPrices(tokenAddresses: string[]): Promise<Map<string, bigint>> {
    const unique = [...new Set(tokenAddresses.map(a => a.toLowerCase()))];
    const now    = Date.now();

    const fresh  = new Map<string, bigint>();
    const toFetch: string[] = [];

    for (const addr of unique) {
      // Skip permanently dead feeds without any RPC call
      if (isDeadFeed(addr)) { fresh.set(addr, 0n); continue; }
      const c = priceCache.get(addr);
      if (c && now - c.ts < CACHE_TTL) { fresh.set(addr, c.price); }
      else { toFetch.push(addr); }
    }

    if (toFetch.length > 0) {
      try {
        const prices: bigint[] = await this.oracle.getAssetsPrices(toFetch);
        for (let i = 0; i < toFetch.length; i++) {
          const key = toFetch[i]!;
          fresh.set(key, prices[i]!);
          priceCache.set(key, { price: prices[i]!, ts: now });
        }
      } catch (batchErr: any) {
        // If provider was destroyed, serve stale prices immediately — don't fire N individual calls
        if ((batchErr.code === 'UNSUPPORTED_OPERATION' || /provider destroyed|cancelled request/i.test(batchErr.message ?? ''))) {
          logger.debug(`Oracle batch aborted (provider destroyed) — serving stale/zero prices`);
          for (const addr of toFetch) {
            const stale = priceCache.get(addr);
            fresh.set(addr, stale?.price ?? 0n);
          }
        } else {
          // Batch failed — one asset feed reverted. Fall back per-asset to find the culprit.
          logger.warn(`Batch oracle failed for ${toFetch.length} assets — per-asset fallback`);
          await Promise.allSettled(toFetch.map(async (addr) => {
            try {
              const price: bigint = await this.oracle.getAssetPrice(addr);
              fresh.set(addr, price);
              priceCache.set(addr, { price, ts: now });
            } catch {
              const stale = priceCache.get(addr);
              if (stale) {
                fresh.set(addr, stale.price);
                logger.debug(`Oracle: stale price used for ${addr}`);
              } else {
                // No stale fallback — this feed is dead. Blacklist it with TTL
                // so it never poisons a batch call again, but is retried after 10 min.
                markDeadFeed(addr);
                fresh.set(addr, 0n);
                logger.warn(`Oracle: feed dead for ${addr} — blacklisted for ${DEAD_FEED_TTL_MS/60000} min`);
              }
            }
          }));
        }
      }
    }

    const result = new Map<string, bigint>();
    for (const addr of tokenAddresses) {
      result.set(addr.toLowerCase(), fresh.get(addr.toLowerCase()) ?? 0n);
    }
    return result;
  }

  // Pre-fetch ALL reserve prices in a single call, excluding known-dead feeds.
  async prefetchAllPrices(): Promise<Map<string, bigint>> {
    const allAddrs = Object.values(RESERVES)
      .map(r => r.address)
      .filter(a => !isDeadFeed(a.toLowerCase()));
    return this.getPrices(allAddrs);
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

  // Returns assets that dropped >= threshold over ANY of the check windows.
  async prefetchAllPricesWithDropDetection(): Promise<{
    prices:        Map<string, bigint>;
    droppedAssets: Set<string>;  // lowercase addresses with meaningful price drop
  }> {
    const now    = Date.now();
    const prices = await this.prefetchAllPrices();
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

  pokePrice(tokenAddress: string, price: bigint): void {
    priceCache.set(tokenAddress.toLowerCase(), { price, ts: Date.now() });
  }

  // Force-fetch past the cache TTL — used to establish an authoritative baseline
  // right after a feed event. Returns 0n on failure.
  async refreshPrice(tokenAddress: string): Promise<bigint> {
    try {
      const price: bigint = await this.oracle.getAssetPrice(tokenAddress);
      priceCache.set(tokenAddress.toLowerCase(), { price, ts: Date.now() });
      return price;
    } catch {
      return 0n;
    }
  }

  // Batched force-refresh. One Chainlink aggregator can back many Aave reserves
  // (ETH/USD alone prices WETH, wstETH, rETH, weETH, ezETH and rsETH), so a feed
  // event needs a confirmation read for all of them at once — six individual
  // getAssetPrice calls per event is six times the rate-limit budget for the
  // same data. Returns 0n for any asset that failed.
  async refreshPrices(tokenAddresses: string[]): Promise<Map<string, bigint>> {
    const unique = [...new Set(tokenAddresses.map(a => a.toLowerCase()))];
    const out = new Map<string, bigint>();
    if (unique.length === 0) return out;
    if (unique.length === 1) {
      out.set(unique[0]!, await this.refreshPrice(unique[0]!));
      return out;
    }
    const now = Date.now();
    try {
      const prices: bigint[] = await this.oracle.getAssetsPrices(unique);
      for (let i = 0; i < unique.length; i++) {
        const price = prices[i] ?? 0n;
        out.set(unique[i]!, price);
        if (price > 0n) priceCache.set(unique[i]!, { price, ts: now });
      }
    } catch {
      // A single dead feed reverts the whole batch. Serve what we have cached
      // rather than fanning out into per-asset calls on the hot path — the
      // background prefetch will sort out a genuinely dead feed.
      for (const addr of unique) out.set(addr, priceCache.get(addr)?.price ?? 0n);
    }
    return out;
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
