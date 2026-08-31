// rpcLimiter.ts — paces outbound eth_call traffic on a provider to a max
// requests-per-second rate.
//
// History: this started as a max-CONCURRENCY cap (bound how many eth_calls
// are outstanding at once). Evidence proved that wrong — dropping the cap
// from 4 to 2 concurrent barely changed the failure rate, which rules out
// concurrency as the actual constraint. A "max N in flight" cap does nothing
// to limit how many NEW requests start per second if each one resolves
// quickly; you can have only 2 outstanding at any instant and still fire
// dozens of requests/sec.
//
// What actually correlated with success: the startup prune (chunk=500,
// 8-wide waves) passed with zero failures, and its own wave timing worked
// out to roughly ~4 requests/second sustained (each wave of 8 concurrent
// calls took ~2.1s to resolve, per the progress-log timestamps). The instant
// normal operation started — cycle loop, background price prefetch,
// per-candidate breakdown fetches, config refreshes all firing without that
// natural spacing — failures resumed immediately. That's the signature of a
// requests-per-second ceiling (a standard shape for a free/shared RPC plan),
// not a concurrency ceiling.
//
// Fix: space out when NEW eth_calls are allowed to START, at a fixed max
// rate, regardless of how many are concurrently outstanding or how fast they
// complete. Wraps provider.call() only — never .send(), so
// eth_sendRawTransaction/tx submission is never queued behind read traffic.
// Every caller (multicall, individual fallback calls, oracle reads) funnels
// through the same provider instance via getProvider(), so one wrapper here
// paces the whole app uniformly without touching dozens of call sites.

import { ethers } from "ethers";
import { logger } from "./logger";

function createRateLimiter(maxPerSecond: number) {
  const intervalMs = 1000 / maxPerSecond;
  let nextSlot = Date.now();

  return function schedule<T>(fn: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const runAt = Math.max(now, nextSlot);
    nextSlot = runAt + intervalMs;
    const delay = runAt - now;
    return delay > 0
      ? new Promise<T>((resolve, reject) => {
          setTimeout(() => { fn().then(resolve, reject); }, delay);
        })
      : fn();
  };
}

// Idempotency guard — a provider only gets wrapped once even if this is
// called again for the same instance.
const wrapped = new WeakSet<ethers.Provider>();

// Wrap provider.call() so new eth_calls start at most `maxPerSecond` times
// per second. Call once per new provider instance (index.ts does this in
// createProvider(), including on every reconnect, since reconnect creates a
// fresh WebSocketProvider object).
export function attachCallLimiter(provider: ethers.Provider, maxPerSecond: number): void {
  if (wrapped.has(provider)) return;
  wrapped.add(provider);

  const schedule = createRateLimiter(maxPerSecond);
  const originalCall = provider.call.bind(provider);

  provider.call = (tx: ethers.TransactionRequest) => schedule(() => originalCall(tx));

  logger.info(`RPC call limiter attached: max ${maxPerSecond} eth_call/sec`);
}
