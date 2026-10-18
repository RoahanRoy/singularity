/**
 * Technical indicators: SMA/EMA and their crossovers, Wilder RSI, MACD,
 * Bollinger bands, momentum (12-1, 6-1, 3m), on-balance volume, relative
 * volume and VWAP. Series outputs are aligned to the input and NaN until the
 * indicator has enough history.
 *
 * Academic support for most of these alone is weak; momentum is the
 * exception. The ensemble weights them by their own out-of-sample record.
 */

import { mean, std, clamp, percentileOf, isNum } from "./stats";
import type { Bar } from "./types";

export function sma(xs: readonly number[], n: number): number[] {
  const out = new Array<number>(xs.length).fill(NaN);
  let s = 0;
  for (let i = 0; i < xs.length; i++) {
    s += xs[i];
    if (i >= n) s -= xs[i - n];
    if (i >= n - 1) out[i] = s / n;
  }
  return out;
}

/** EMA with α = 2/(n+1), seeded with the SMA of the first n values. */
export function ema(xs: readonly number[], n: number): number[] {
  const out = new Array<number>(xs.length).fill(NaN);
  if (xs.length < n) return out;
  const a = 2 / (n + 1);
  let e = 0;
  for (let i = 0; i < n; i++) e += xs[i];
  e /= n;
  out[n - 1] = e;
  for (let i = n; i < xs.length; i++) { e = a * xs[i] + (1 - a) * e; out[i] = e; }
  return out;
}

/** EMA of a series that starts with NaNs (e.g. MACD line) — seeds at the first n finite values. */
function emaFrom(xs: readonly number[], n: number): number[] {
  const start = xs.findIndex((v) => Number.isFinite(v));
  const out = new Array<number>(xs.length).fill(NaN);
  if (start < 0) return out;
  const tail = ema(xs.slice(start), n);
  for (let i = 0; i < tail.length; i++) out[start + i] = tail[i];
  return out;
}

export type Cross = { index: number; type: "golden" | "death" };

/** Points where `fast` crosses `slow`: golden = crosses above, death = crosses below. */
export function crossovers(fast: readonly number[], slow: readonly number[]): Cross[] {
  const out: Cross[] = [];
  for (let i = 1; i < fast.length; i++) {
    const a0 = fast[i - 1] - slow[i - 1], a1 = fast[i] - slow[i];
    if (!Number.isFinite(a0) || !Number.isFinite(a1)) continue;
    if (a0 <= 0 && a1 > 0) out.push({ index: i, type: "golden" });
    else if (a0 >= 0 && a1 < 0) out.push({ index: i, type: "death" });
  }
  return out;
}

/** RSI = 100 − 100/(1 + avg gain/avg loss) with Wilder smoothing. */
export function rsi(closes: readonly number[], n = 14): number[] {
  const out = new Array<number>(closes.length).fill(NaN);
  if (closes.length <= n) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) g += d; else l -= d;
  }
  g /= n; l /= n;
  const val = () => (l === 0 ? (g === 0 ? 50 : 100) : 100 - 100 / (1 + g / l));
  out[n] = val();
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    g = (g * (n - 1) + Math.max(d, 0)) / n;
    l = (l * (n - 1) + Math.max(-d, 0)) / n;
    out[i] = val();
  }
  return out;
}

/** MACD = EMA₁₂ − EMA₂₆; signal = EMA₉ of MACD; histogram = MACD − signal. */
export function macd(closes: readonly number[], fast = 12, slow = 26, signal = 9) {
  const ef = ema(closes, fast), es = ema(closes, slow);
  const line = closes.map((_, i) => ef[i] - es[i]);
  const sig = emaFrom(line, signal);
  return { macd: line, signal: sig, hist: line.map((v, i) => v - sig[i]) };
}

/** Bollinger = SMA₂₀ ± 2σ (population σ, as Bollinger specifies), with %B and bandwidth. */
export function bollinger(closes: readonly number[], n = 20, k = 2) {
  const mid = sma(closes, n);
  const upper = new Array<number>(closes.length).fill(NaN);
  const lower = new Array<number>(closes.length).fill(NaN);
  const pctB = new Array<number>(closes.length).fill(NaN);
  const bandwidth = new Array<number>(closes.length).fill(NaN);
  for (let i = n - 1; i < closes.length; i++) {
    const w = closes.slice(i - n + 1, i + 1);
    const sd = std(w, 0);
    upper[i] = mid[i] + k * sd;
    lower[i] = mid[i] - k * sd;
    const span = upper[i] - lower[i];
    pctB[i] = span > 0 ? (closes[i] - lower[i]) / span : 0.5;
    bandwidth[i] = mid[i] > 0 ? span / mid[i] : NaN;
  }
  return { mid, upper, lower, pctB, bandwidth };
}

export type MomentumSet = {
  /** 12-1 momentum: P(t−21)/P(t−252) − 1, skipping the latest month (short-term reversal). */
  mom12_1: number | null;
  mom6_1: number | null;
  ret1m: number | null;
  ret3m: number | null;
};

export function momentum(closes: readonly number[]): MomentumSet {
  const n = closes.length;
  const at = (k: number) => (n - 1 - k >= 0 ? closes[n - 1 - k] : NaN);
  const r = (a: number, b: number) => (isNum(a) && isNum(b) && b > 0 ? a / b - 1 : null);
  return {
    mom12_1: r(at(21), at(252)),
    mom6_1: r(at(21), at(126)),
    ret1m: r(at(0), at(21)),
    ret3m: r(at(0), at(63)),
  };
}

export function obv(closes: readonly number[], volumes: readonly number[]): number[] {
  const out = new Array<number>(closes.length).fill(0);
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    out[i] = out[i - 1] + (d > 0 ? volumes[i] : d < 0 ? -volumes[i] : 0);
  }
  return out;
}

/** Today's volume over the trailing n-day average (excluding today). */
export function relativeVolume(volumes: readonly number[], n = 20): number | null {
  if (volumes.length < n + 1) return null;
  const base = mean(volumes.slice(-n - 1, -1));
  return base > 0 ? volumes[volumes.length - 1] / base : null;
}

/** Rolling VWAP over n daily bars using the typical price (H+L+C)/3. */
export function rollingVwap(bars: readonly Bar[], n = 20): number | null {
  const w = bars.slice(-n);
  let pv = 0, v = 0;
  for (const b of w) { pv += ((b.high + b.low + b.close) / 3) * b.volume; v += b.volume; }
  return v > 0 ? pv / v : null;
}

/** Session VWAP from intraday bars of the latest session: Σ(typical·vol)/Σvol. */
export function sessionVwap(intraday: readonly Bar[]): number | null {
  if (!intraday.length) return null;
  const day = intraday[intraday.length - 1].date;
  let pv = 0, v = 0;
  for (const b of intraday) {
    if (b.date !== day || !(b.volume > 0)) continue;
    pv += ((b.high + b.low + b.close) / 3) * b.volume;
    v += b.volume;
  }
  return v > 0 ? pv / v : null;
}

export type Vote = { name: string; vote: -1 | 0 | 1; value: number | string | null; note: string };

export type TechnicalSnapshot = {
  price: number;
  sma20: number; sma50: number; sma200: number;
  ema12: number; ema26: number;
  lastCross: (Cross & { date: string; barsAgo: number }) | null;
  rsi14: number;
  macd: { macd: number; signal: number; hist: number };
  bollinger: { upper: number; lower: number; pctB: number; bandwidth: number };
  relVolume: number | null;
  obvSlope20: number | null;
  vwap20: number | null;
  sessionVwap: number | null;
  votes: Vote[];
  /** −100 … 100: mean of the votes. */
  score: number;
};

type IndicatorSeries = {
  c: number[]; s20: number[]; s50: number[]; s200: number[]; e12: number[]; e26: number[];
  rsi: number[]; macd: ReturnType<typeof macd>; bb: ReturnType<typeof bollinger>; obv: number[]; vwap20: number[];
};

/** Every indicator the vote uses, as causal series over the whole history. */
function indicatorSeries(bars: readonly Bar[]): IndicatorSeries {
  const c = bars.map((b) => b.close);
  return {
    c, s20: sma(c, 20), s50: sma(c, 50), s200: sma(c, 200), e12: ema(c, 12), e26: ema(c, 26),
    rsi: rsi(c), macd: macd(c), bb: bollinger(c),
    obv: obv(c, bars.map((b) => b.volume)),
    vwap20: bars.map((_, i) => rollingVwap(bars.slice(Math.max(0, i - 19), i + 1)) ?? NaN),
  };
}

/** The eight indicator votes as of bar i, using nothing after it. */
function votesAt(x: IndicatorSeries, i: number, crossType: string | null = null): Vote[] {
  const price = x.c[i], s50 = x.s50[i], s200 = x.s200[i];
  const mh = x.macd.hist[i], r = x.rsi[i], pb = x.bb.pctB[i], vw = x.vwap20[i];
  const obvSlope = i >= 20 ? (x.obv[i] - x.obv[i - 20]) / 20 : null;
  const ret20 = i >= 20 ? price / x.c[i - 20] - 1 : 0;
  return [
    { name: "Price vs 200-day SMA", vote: price > s200 ? 1 : -1, value: s200, note: price > s200 ? "long-term uptrend" : "below long-term trend" },
    { name: "50/200 SMA state", vote: s50 > s200 ? 1 : -1, value: crossType, note: s50 > s200 ? "golden-cross regime" : "death-cross regime" },
    { name: "EMA 12/26", vote: x.e12[i] > x.e26[i] ? 1 : -1, value: x.e12[i] - x.e26[i], note: "short-term trend" },
    { name: "MACD histogram", vote: mh > 0 ? 1 : mh < 0 ? -1 : 0, value: mh, note: mh > 0 ? "momentum building" : "momentum fading" },
    { name: "RSI(14)", vote: r > 70 ? -1 : r < 30 ? 1 : 0, value: r, note: r > 70 ? "overbought" : r < 30 ? "oversold" : "neutral" },
    { name: "Bollinger %B", vote: pb > 1 ? -1 : pb < 0 ? 1 : 0, value: pb, note: pb > 1 ? "above upper band" : pb < 0 ? "below lower band" : "inside bands" },
    { name: "Price vs 20-day VWAP", vote: isNum(vw) ? (price > vw ? 1 : -1) : 0, value: isNum(vw) ? vw : null, note: "volume-weighted fair price" },
    { name: "OBV confirms trend", vote: obvSlope == null || ret20 === 0 || Math.sign(obvSlope) !== Math.sign(ret20) ? 0 : ret20 > 0 ? 1 : -1, value: obvSlope, note: "volume agrees with price direction" },
  ];
}

const voteScore = (votes: readonly Vote[]) => Math.round((100 * votes.reduce((s, x) => s + x.vote, 0)) / votes.length);

/** One-glance technical state plus a vote per indicator. Needs ≥ 200 daily bars. */
export function technicalSnapshot(bars: readonly Bar[], intraday: readonly Bar[] = []): TechnicalSnapshot | null {
  if (bars.length < 200) return null;
  const x = indicatorSeries(bars);
  const i = bars.length - 1;
  const crosses = crossovers(x.s50, x.s200);
  const lc = crosses.length ? crosses[crosses.length - 1] : null;
  const votes = votesAt(x, i, lc ? lc.type : null);
  const vw = x.vwap20[i];
  return {
    price: x.c[i],
    sma20: x.s20[i], sma50: x.s50[i], sma200: x.s200[i],
    ema12: x.e12[i], ema26: x.e26[i],
    lastCross: lc ? { ...lc, date: bars[lc.index].date, barsAgo: i - lc.index } : null,
    rsi14: x.rsi[i],
    macd: { macd: x.macd.macd[i], signal: x.macd.signal[i], hist: x.macd.hist[i] },
    bollinger: { upper: x.bb.upper[i], lower: x.bb.lower[i], pctB: x.bb.pctB[i], bandwidth: x.bb.bandwidth[i] },
    relVolume: relativeVolume(bars.map((b) => b.volume)),
    obvSlope20: i >= 20 ? (x.obv[i] - x.obv[i - 20]) / 20 : null,
    vwap20: isNum(vw) ? vw : null,
    sessionVwap: sessionVwap(intraday),
    votes,
    score: voteScore(votes),
  };
}

/**
 * The snapshot's score on every bar (NaN for the first 199), each computed
 * from that bar's history only, so a backtest can replay the live signal.
 */
export function technicalScoreSeries(bars: readonly Bar[]): number[] {
  const x = indicatorSeries(bars);
  return bars.map((_, i) => (i < 199 ? NaN : voteScore(votesAt(x, i))));
}

/**
 * Momentum score −100…100: 60% cross-sectional (12-1 percentile among
 * same-sector peers, when ≥ 3 peers) and 40% time-series (sign and size of
 * 12-1, squashed with tanh). Without peers the time-series part carries it.
 */
export function momentumScore(own: MomentumSet, peerMom12_1: readonly number[]): { score: number; percentile: number | null } {
  if (own.mom12_1 == null) return { score: 0, percentile: null };
  const ts = Math.tanh(own.mom12_1 / 0.3);
  if (peerMom12_1.length >= 3) {
    const p = percentileOf(peerMom12_1, own.mom12_1);
    return { score: Math.round(100 * clamp(0.6 * (2 * p - 1) + 0.4 * ts, -1, 1)), percentile: p };
  }
  return { score: Math.round(100 * ts), percentile: null };
}
