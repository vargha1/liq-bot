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
//
// ── Bounded backlog (this is the part that was missing) ─────────────────────
// The original scheduler pushed `nextSlot` forward for every call and made the
// caller wait however long that took, with no ceiling. That is only stable
// while demand stays under the rate; the instant demand exceeds it the debt
// compounds and never repays. Observed in production: a 300-position sweep at
// MC_SUBCHUNK=50 is 6 eth_calls, fired roughly once a second against a 4/sec
// budget, alongside the model fill, the 5-second price prefetch and the danger
// prewarm. Demand ran at ~2x the ceiling, so the queue grew by seconds every
// second until a single refreshBatch took 300707 ms — a five-minute wait for a
// call whose data was stale within one block. The 45-second cycle safety
// timeout fired continuously, and because the queued work was never cancelled
// each aborted cycle left its calls in the queue for the next one to sit behind.
//
// Two changes make that impossible:
//   1. The backlog is capped. A call that cannot start within maxQueueMs is
//      REJECTED immediately instead of being promised a slot minutes away.
//      Callers already handle a failed eth_call (multicall chunks fall back,
//      price reads serve stale) — a fast failure is strictly better than a
//      five-minute stall, and it applies backpressure instead of hiding it.
//   2. A call whose deadline passed while it sat in the queue is dropped at
//      dequeue rather than sent. If a cycle was abandoned 40 seconds ago its
//      calls are worthless; sending them only pushes the live work further back.
//
// queueDelayMs() exposes the current backlog so the cycle loop can decline to
// pile on more work when the budget is already spent.

import { ethers } from "ethers";
import { logger } from "./logger";

// Thrown when the backlog is too deep to accept more work. Callers that
// distinguish error kinds (provider-destroyed vs. genuine RPC failure) can
// match on `code`.
export class RpcBackpressureError extends Error {
  readonly code = "RPC_BACKPRESSURE";
  constructor(waitMs: number, maxMs: number) {
    super(`rpc call shed: backlog ${Math.round(waitMs)}ms exceeds max ${maxMs}ms`);
    this.name = "RpcBackpressureError";
  }
}

export interface CallLimiterHandle {
  /** How far in the future the next admitted call would start, in ms. */
  queueDelayMs(): number;
  /** Calls rejected because the backlog was too deep, since process start. */
  shedCount(): number;
  /** Calls dropped at dequeue because their deadline had already passed. */
  expiredCount(): number;
}

function createRateLimiter(maxPerSecond: number, maxQueueMs: number) {
  const intervalMs = 1000 / maxPerSecond;
  let nextSlot = Date.now();
  let shed     = 0;
  let expired  = 0;

  function schedule<T>(fn: () => Promise<T>): Promise<T> {
    const now   = Date.now();
    const runAt = Math.max(now, nextSlot);
    const delay = runAt - now;

    // Backlog too deep — shed rather than promise a slot that will be useless
    // by the time it arrives. nextSlot is deliberately NOT advanced: a shed
    // call must not make the queue worse for the calls that were admitted.
    if (delay > maxQueueMs) {
      shed++;
      return Promise.reject(new RpcBackpressureError(delay, maxQueueMs));
    }

    nextSlot = runAt + intervalMs;
    if (delay <= 0) return fn();

    // The deadline travels with the call. Work queued behind a stall is
    // usually stale on arrival; sending it anyway spends budget that the
    // live path needs.
    const deadline = now + maxQueueMs;
    return new Promise<T>((resolve, reject) => {
      setTimeout(() => {
        if (Date.now() > deadline) {
          expired++;
          reject(new RpcBackpressureError(Date.now() - now, maxQueueMs));
          return;
        }
        fn().then(resolve, reject);
      }, delay);
    });
  }

  schedule.queueDelayMs  = () => Math.max(0, nextSlot - Date.now());
  schedule.shedCount     = () => shed;
  schedule.expiredCount  = () => expired;
  return schedule;
}

// Idempotency guard — a provider only gets wrapped once even if this is
// called again for the same instance.
const wrapped = new WeakMap<ethers.Provider, CallLimiterHandle>();

// Wrap provider.call() so new eth_calls start at most `maxPerSecond` times
// per second, with a bounded backlog. Call once per new provider instance.
// Returns a handle for reading backpressure state; calling it again for the
// same provider returns the existing handle without re-wrapping.
export function attachCallLimiter(
  provider: ethers.Provider,
  maxPerSecond: number,
  maxQueueMs = 5_000,
): CallLimiterHandle {
  const existing = wrapped.get(provider);
  if (existing) return existing;

  const schedule = createRateLimiter(maxPerSecond, maxQueueMs);
  const originalCall = provider.call.bind(provider);

  provider.call = (tx: ethers.TransactionRequest) => schedule(() => originalCall(tx));

  const handle: CallLimiterHandle = {
    queueDelayMs:  schedule.queueDelayMs,
    shedCount:     schedule.shedCount,
    expiredCount:  schedule.expiredCount,
  };
  wrapped.set(provider, handle);

  logger.info(
    `RPC call limiter attached: max ${maxPerSecond} eth_call/sec, backlog capped at ${maxQueueMs}ms`
  );
  return handle;
}
