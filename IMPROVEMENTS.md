# Bot Improvement Plan

## Problem 1: HF_WATCH threshold too aggressive (MOST IMPACTFUL)

Current: positions with HF > 1.05 are evicted. 
Reality: a position at HF=1.10 needs only a 9% price drop to become liquidatable.
On volatile assets (ARB, LINK, weETH) this happens in minutes.

Fix: raise HF_WATCH to 1.30 or even 1.50.
With 447 positions this adds almost zero overhead — even 5000 positions costs
<1 multicall per cycle at batch=100.

## Problem 2: Cache saves pruned set, shrinking watchlist every restart

Current: pruneStale() runs → evicts HF>1.05 → saves 447 addresses to cache.
Next restart: seeds from 447, misses anyone who was at HF=1.08 yesterday.

Fix: save TWO caches:
  - borrowers-cache.json: full scan result (never pruned), updated with new borrows
  - active-cache.json: current watching set (pruned), used for fast startup

On restart: load active-cache for immediate operation, then background-merge
full borrowers list at HF_WATCH=1.30 threshold.

## Problem 3: No re-expansion after market moves

Current: once pruned, an address only returns via a live Borrow/Supply event.
But if someone deposited 6 months ago and is now underwater due to price drop,
no event fires — the bot never sees them.

Fix: periodic re-expansion scan using subgraph or on-chain events.
Every 2 hours, fetch the last 2 hours of Borrow/Supply/Withdraw events and
upsert any new addresses. This is cheap (getLogs over ~28800 blocks = 1 RPC call).

## Problem 4: Only 447 positions is far too few for Arbitrum Aave V3

The subgraph has 181k historical borrowers. After pruning at HF>1.05 you get 447.
But right now the market is healthy — everyone is overcollateralized.
When the next crash happens, thousands will drop below HF=1 simultaneously.
Your bot needs to be watching them BEFORE they drop, not after.

Fix: watch all positions with HF < 1.30 (or even 1.50 for volatile assets).
After the full prune, this is likely 2000-5000 positions — still trivially fast
with Multicall3 at 100/cycle.
