// Lightweight stage-timing instrumentation.
//
// Every latency-sensitive stage in the bot records a sample here:
//   cyc.detectLag   block event received → cycle starts running
//   cyc.scan        refreshBatch (multicall getUserAccountData sweep)
//   cyc.breakdown   parallel asset breakdown fetches
//   cyc.evaluate    candidate evaluation (pair pick + route lookup)
//   exec.submit     populate+sign+eth_sendRawTransaction sequencer ack
//   exec.confirm    sequencer ack → receipt
//   exec.e2e        execute() entry → receipt
//   trig.dispatch   feed price event → opportunities dispatched
//
// A periodic reporter logs count/p50/p95/max per metric so regressions are
// visible without attaching a profiler.

import { logger } from "./logger";

const MAX_SAMPLES_PER_METRIC = 2000;

class Metrics {
  private samples = new Map<string, number[]>();

  record(name: string, ms: number): void {
    let arr = this.samples.get(name);
    if (!arr) { arr = []; this.samples.set(name, arr); }
    arr.push(ms);
    if (arr.length > MAX_SAMPLES_PER_METRIC) arr.splice(0, arr.length - MAX_SAMPLES_PER_METRIC);
  }

  // Returns a stop-function that records elapsed ms under `name` when called.
  startTimer(name: string): () => void {
    const t0 = performance.now();
    return () => this.record(name, performance.now() - t0);
  }

  private percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
    return sorted[Math.max(0, idx)]!;
  }

  summary(): Record<string, { n: number; p50: number; p95: number; max: number }> {
    const out: Record<string, { n: number; p50: number; p95: number; max: number }> = {};
    for (const [name, arr] of this.samples) {
      if (arr.length === 0) continue;
      const sorted = [...arr].sort((a, b) => a - b);
      out[name] = {
        n:   sorted.length,
        p50: Math.round(this.percentile(sorted, 50)),
        p95: Math.round(this.percentile(sorted, 95)),
        max: Math.round(sorted[sorted.length - 1]!),
      };
    }
    return out;
  }
}

export const metrics = new Metrics();

// Periodic report — only logs when there is data, so idle periods stay quiet.
export function startMetricsReporter(intervalMs = 180_000): void {
  setInterval(() => {
    const s = metrics.summary();
    const keys = Object.keys(s);
    if (keys.length === 0) return;
    const lines = keys.map(k => {
      const v = s[k]!;
      return `  ${k.padEnd(16)} n=${String(v.n).padStart(5)}  p50=${String(v.p50).padStart(6)}ms  p95=${String(v.p95).padStart(6)}ms  max=${String(v.max).padStart(6)}ms`;
    });
    logger.info(`⏱️ Stage timings (ms):\n${lines.join("\n")}`);
  }, intervalMs);
}
