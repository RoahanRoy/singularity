/**
 * Feature matrix for the machine-learning agents.
 *
 * Every feature on date t is computed from bars up to and including t, and
 * the label is the forward log return from t's close to the close `horizon`
 * bars later. The newest `horizon` rows therefore have no label: they are
 * what the models predict today. Rows from several symbols (sector peers)
 * can be pooled; splits are always by date, never by row, so a peer's same-day
 * row can't leak into training.
 */

import type { Bar } from "./types";
import { rsi, macd, bollinger, sma } from "./technicals";
import { closeOnOrBefore } from "./series";
import { isNum } from "./stats";

export const BASE_FEATURES = [
  "r1", "r5", "r21", "r63", "r126", "r252",
  "vol21", "vol63",
  "rsi14", "macdHist", "pctB", "distSma50", "distSma200",
  "volumeZ",
] as const;

export const FEATURE_LABELS: Record<string, string> = {
  r1: "1-day return",
  r5: "1-week return",
  r21: "1-month return",
  r63: "3-month return",
  r126: "6-month return",
  r252: "12-month return",
  vol21: "1-month volatility",
  vol63: "3-month volatility",
  rsi14: "RSI(14)",
  macdHist: "MACD histogram",
  pctB: "Bollinger %B",
  distSma50: "distance from 50-day SMA",
  distSma200: "distance from 200-day SMA",
  volumeZ: "volume vs 3-month norm",
  idx21: "index 1-month return",
};

export type FeatureRow = {
  symbol: string;
  date: string;
  x: number[];
  /** Forward `horizon`-bar log return, or null when it hasn't happened yet. */
  y: number | null;
};

export type FeatureSet = { names: string[]; horizon: number; rows: FeatureRow[] };

function rollingStd(xs: readonly number[], n: number): number[] {
  const out = new Array<number>(xs.length).fill(NaN);
  let s = 0, s2 = 0;
  for (let i = 0; i < xs.length; i++) {
    s += xs[i]; s2 += xs[i] * xs[i];
    if (i >= n) { s -= xs[i - n]; s2 -= xs[i - n] * xs[i - n]; }
    if (i >= n - 1) out[i] = Math.sqrt(Math.max(0, (s2 - (s * s) / n) / (n - 1)));
  }
  return out;
}

/**
 * Build feature rows for one symbol. `index` (optional) adds the market's
 * 1-month return as a feature; pass the same index for every pooled symbol.
 */
export function buildFeatures(
  symbol: string,
  bars: readonly Bar[],
  opts: { horizon?: number; index?: readonly Bar[] } = {},
): FeatureSet {
  const h = opts.horizon ?? 21;
  const names: string[] = [...BASE_FEATURES];
  if (opts.index?.length) names.push("idx21");
  const clean = bars.filter((b) => (b.adjClose > 0 || b.close > 0) && b.date);
  const px = clean.map((b) => (b.adjClose > 0 ? b.adjClose : b.close));
  const n = px.length;
  const lp = px.map(Math.log);
  const r1s = lp.map((v, i) => (i ? v - lp[i - 1] : 0));
  const vol21 = rollingStd(r1s, 21), vol63 = rollingStd(r1s, 63);
  const rs = rsi(px, 14);
  const { hist } = macd(px);
  const { pctB } = bollinger(px, 20, 2);
  const s50 = sma(px, 50), s200 = sma(px, 200);
  const lv = clean.map((b) => Math.log1p(Math.max(0, b.volume || 0)));
  const lvMean = sma(lv, 63), lvSd = rollingStd(lv, 63);
  const idx = opts.index?.length ? clean.map((b) => closeOnOrBefore(opts.index!, b.date)) : null;

  const rows: FeatureRow[] = [];
  const ret = (i: number, k: number) => (i - k >= 0 ? lp[i] - lp[i - k] : NaN);
  for (let i = 0; i < n; i++) {
    const x = [
      ret(i, 1), ret(i, 5), ret(i, 21), ret(i, 63), ret(i, 126), ret(i, 252),
      vol21[i] * Math.sqrt(252), vol63[i] * Math.sqrt(252),
      rs[i] / 100 - 0.5,
      hist[i] / px[i],
      pctB[i],
      px[i] / s50[i] - 1,
      px[i] / s200[i] - 1,
      lvSd[i] > 0 ? (lv[i] - lvMean[i]) / lvSd[i] : 0,
    ];
    if (idx) {
      const a = idx[i], b = i >= 21 ? idx[i - 21] : null;
      x.push(a != null && b != null && a > 0 && b > 0 ? Math.log(a / b) : NaN);
    }
    if (!x.every(isNum)) continue;
    rows.push({ symbol, date: clean[i].date, x, y: i + h < n ? lp[i + h] - lp[i] : null });
  }
  return { names, horizon: h, rows };
}

/** Pool several symbols' feature sets (same feature list and horizon) into one. */
export function poolFeatures(sets: readonly FeatureSet[]): FeatureSet | null {
  if (!sets.length) return null;
  const { names, horizon } = sets[0];
  const same = sets.filter((s) => s.horizon === horizon && s.names.join() === names.join());
  return { names, horizon, rows: same.flatMap((s) => s.rows) };
}
