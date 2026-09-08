// modelError.ts — measured disagreement between the local health-factor model
// and Aave's own getUserAccountData.
//
// ── Why this exists ─────────────────────────────────────────────────────────
// The trigger engine has to decide, without an RPC round-trip, whether a
// position it believes is liquidatable really is. Getting that wrong burns
// ~350k gas on a HealthFactorNotBelowThreshold() revert; being too cautious
// forfeits the latency advantage the whole engine exists to provide.
//
// That decision used to be a hardcoded constant (TRIGGER_CONFIRM_HF = 0.995):
// fire blind below it, confirm above it. The constant was set from TWO observed
// failures, in calm conditions, and expressed the answer in health-factor units
// even though the underlying error is a PRICE error whose health-factor impact
// depends on the position. For a single-collateral, single-debt borrower — the
// common case — a price error passes into the health factor with a gain of 1.0,
// undamped. So one constant cannot be right across positions, and cannot be
// right across market regimes either: it is far too loose when prices are moving
// fast and estimates chain off one another, and needlessly tight when they are
// not.
//
// The fix is to stop guessing. Every marginal candidate already gets an
// authoritative confirmation, which yields a matched (localHF, chainHF) pair for
// the same borrower at the same moment — a free, continuously-collected error
// sample that the bot was throwing away. Collect them, and the confidence margin
// becomes a measured quantity that widens on its own during volatility and
// tightens when the model is provably tracking.
//
// ── What is measured ────────────────────────────────────────────────────────
// The signed RELATIVE error
//
//     e = (chainHF − localHF) / localHF
//
// so that chainHF = localHF · (1 + e). Positive e is the dangerous direction:
// the chain is healthier than the model believed, which is what produces a
// revert. A fire at localHF is safe exactly when localHF·(1+e) < 1, i.e. when
//
//     e < 1/localHF − 1        ("headroom")
//
// so the probability a blind fire lands is P(e < headroom) — read straight off
// the empirical distribution by cdf().
//
// Deliberately NOT modelled as a Gaussian. The error is driven by price
// staleness and by ratio estimates chaining off other estimates, which produces
// a fat right tail; a normal approximation would understate exactly the tail
// that costs money.

import { logger } from "./logger";

const HF_ONE = 10n ** 18n;

export interface ModelErrorStats {
  count:  number;
  p50:    number;
  p95:    number;
  p999:   number;
  worst:  number;
  /** 0.1th percentile — the NEGATIVE tail. */
  p001:   number;
  /** Most negative observation. */
  best:   number;
  /** Fraction of samples where the chain disagreed about liquidatability. */
  flipRate: number;
}

export class ModelErrorTracker {
  // Ring buffer. A rolling window is the decay mechanism: old samples from a
  // calmer regime age out as new ones arrive, so the distribution tracks
  // current conditions without any explicit half-life to tune.
  private samples: number[] = [];
  private cursor  = 0;
  // Sorted copy, rebuilt lazily — cdf() runs on the hot path, once per
  // candidate per feed event, so it must not sort on every call.
  private sorted:  number[] | null = null;
  private flips   = 0;
  private total   = 0;

  constructor(
    private readonly capacity = 500,
    /** Samples required before the empirical distribution is trusted at all. */
    readonly minSamples = 30,
  ) {}

  /**
   * Record one matched observation. `localHfE18` is what the model computed at
   * dispatch; `chainHfE18` is what getUserAccountData returned moments later.
   */
  record(localHfE18: bigint, chainHfE18: bigint): void {
    // A position with no debt reports type(uint256).max — not a comparable
    // health factor, and including it would poison the distribution.
    if (localHfE18 <= 0n || chainHfE18 <= 0n) return;
    if (chainHfE18 > 1000n * HF_ONE) return;

    const local = Number(localHfE18) / 1e18;
    const chain = Number(chainHfE18) / 1e18;
    if (!Number.isFinite(local) || !Number.isFinite(chain) || local <= 0) return;

    const e = (chain - local) / local;
    if (!Number.isFinite(e)) return;

    // A "flip" is the outcome that actually costs gas: the model said
    // liquidatable, the chain disagreed.
    this.total++;
    if (local < 1 && chain >= 1) this.flips++;

    if (this.samples.length < this.capacity) this.samples.push(e);
    else { this.samples[this.cursor] = e; this.cursor = (this.cursor + 1) % this.capacity; }
    this.sorted = null;
  }

  get count(): number { return this.samples.length; }
  get ready(): boolean { return this.samples.length >= this.minSamples; }

  private ensureSorted(): number[] {
    if (!this.sorted) this.sorted = [...this.samples].sort((a, b) => a - b);
    return this.sorted;
  }

  /**
   * Empirical P(e < x) — the probability a blind fire at this headroom lands.
   * Returns null until enough samples exist to mean anything, so callers fall
   * back to the configured static threshold rather than acting on noise.
   */
  cdf(x: number): number | null {
    if (!this.ready) return null;
    const s = this.ensureSorted();
    // Binary search for the first index with s[i] >= x.
    let lo = 0, hi = s.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (s[mid]! < x) lo = mid + 1; else hi = mid;
    }
    return lo / s.length;
  }

  /** Empirical quantile of the error, e.g. quantile(0.999). */
  quantile(p: number): number | null {
    if (!this.ready) return null;
    const s = this.ensureSorted();
    const idx = Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1));
    return s[idx]!;
  }

  stats(): ModelErrorStats {
    const s = this.ensureSorted();
    const q = (p: number) =>
      s.length === 0 ? 0 : s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]!;
    return {
      count:    s.length,
      p50:      q(0.50),
      p95:      q(0.95),
      p999:     q(0.999),
      worst:    s.length ? s[s.length - 1]! : 0,
      p001:     q(0.001),
      best:     s.length ? s[0]! : 0,
      flipRate: this.total > 0 ? this.flips / this.total : 0,
    };
  }

  /** One line for the heartbeat, in basis points. */
  summary(): string {
    if (this.samples.length === 0) return "model-err=no-samples";
    const st = this.stats();
    const bps = (v: number) => (v * 10_000).toFixed(1);
    return (
      `model-err n=${st.count} p50=${bps(st.p50)}bps p95=${bps(st.p95)}bps ` +
      `p99.9=${bps(st.p999)}bps worst=${bps(st.worst)}bps ` +
      // The negative tail is the one that costs opportunities rather than gas:
      // when the model reads a health factor HIGHER than the chain's, a position
      // that really is liquidatable is filtered out before anything can act on
      // it. Reporting only the positive tail made that failure mode invisible.
      `neg(p0.1=${bps(st.p001)}bps min=${bps(st.best)}bps) ` +
      `flip=${(st.flipRate * 100).toFixed(1)}%`
    );
  }

  logSummary(): void {
    if (this.samples.length > 0) logger.info(`📐 ${this.summary()}`);
  }
}
