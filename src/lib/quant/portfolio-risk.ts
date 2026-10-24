/**
 * Portfolio risk at today's weights, measured from daily history: no assumed
 * volatility, correlation or beta stands in for one.
 *
 *  - Calendar: the desk index's last `window` sessions. A holding missing a
 *    session carries its last close (counted in `missing_days`); one that
 *    starts trading inside the window has no full history and is reported as
 *    unmeasured with its weight, not proxied.
 *  - Covariance: Ledoit-Wolf (2004) shrinkage of the sample covariance toward
 *    a scaled identity, intensity estimated from the data, so a book with
 *    nearly as many names as sessions still has a usable matrix.
 *  - 1-day VaR / ES at 95% and 99%, as positive fractions of NAV:
 *    parametric from the shrunk covariance (zero-mean Gaussian) and
 *    historical from today's weights replayed over the window.
 *  - Beta and tracking error against the index; cash is a zero-return asset,
 *    so it dilutes both.
 *  - Risk contributions: each name's share of portfolio variance,
 *    wᵢ(Σw)ᵢ / wᵀΣw, and of tracking variance, wᵢ·cov(rᵢ, a) / var(a) with
 *    a = r_p − r_index (the index's own term closes the sum to 1).
 *  - Liquidity: shares held over average daily volume, i.e. days to exit at
 *    the whole market's volume.
 *  - Stress replays: for each year given, the index's peak-to-trough inside
 *    that year (measured, not dated by hand) and today's book over the same
 *    dates. A name that wasn't trading at the peak is left out and its weight
 *    reported as uncovered.
 *
 * Pure: no I/O, so the desk's runner and the tests share it.
 */

import { covariance, mean, normInv, normPdf, std, variance } from "./stats";
import { cvar, historicalVaR, maxDrawdown, TRADING_DAYS } from "./risk";
import type { Bar } from "./types";

export type RiskHolding = { ticker: string; qty: number; price: number; bars: readonly Bar[] };

export type RiskInput = {
  /** Book NAV the weights are taken against (cash + positions). */
  nav: number;
  holdings: readonly RiskHolding[];
  /** The desk index's daily bars; its dates are the calendar. */
  index: readonly Bar[];
  /** Daily returns in the covariance / VaR window. */
  window: number;
  /** Sessions in the average-daily-volume window. */
  advWindow: number;
  /** Calendar years to replay (the index's in-year peak-to-trough). */
  stressYears: readonly number[];
};

export type Tail = { parametric: number; historical: number };

export type NameRisk = {
  ticker: string;
  /** Share of NAV. */
  weight: number;
  vol_annual: number;
  /** Annualised vol of the name's return less the index's: its active risk per unit weight. */
  active_vol: number;
  beta: number;
  /** Share of portfolio variance (sums to 1 over names). */
  risk_share: number;
  /** Share of tracking variance (sums to 1 with `index_te_share`). */
  te_share: number;
  /** Shares held / average daily volume; null with no volume reported. */
  adv_days: number | null;
  adv_shares: number | null;
  missing_days: number;
  last_bar: string;
  /** Price return over each stress window; null when not trading at its peak. */
  stress: Record<string, number | null>;
};

export type StressReplay = {
  label: string;
  peak: string;
  trough: string;
  index_return: number;
  /** Today's book over the window, as a fraction of NAV (covered names only). */
  book_return: number;
  covered_weight: number;
  uncovered_weight: number;
};

export type PortfolioRisk = {
  as_of: string;
  window: { start: string; end: string; observations: number };
  nav: number;
  cash_weight: number;
  /** Weight of the names measured here. */
  measured_weight: number;
  unmeasured: { ticker: string; weight: number; reason: string }[];
  unmeasured_weight: number;
  vol_annual: number;
  var95: Tail;
  var99: Tail;
  es95: Tail;
  es99: Tail;
  beta: number;
  tracking_error: number;
  index_vol: number;
  index_te_share: number;
  shrinkage: number;
  names: NameRisk[];
  stress: StressReplay[];
};

/**
 * Ledoit-Wolf shrinkage of a T × N return matrix's covariance toward
 * m·I, m = mean variance; intensity b²/d² from the data (Ledoit & Wolf 2004,
 * "A well-conditioned estimator for large-dimensional covariance matrices").
 */
export function ledoitWolf(X: readonly (readonly number[])[]): { cov: number[][]; shrinkage: number } {
  const T = X.length;
  const N = T ? X[0].length : 0;
  if (!T || !N) return { cov: [], shrinkage: 0 };
  const mu = Array.from({ length: N }, (_, j) => mean(X.map((r) => r[j])));
  const Z = X.map((r) => r.map((x, j) => x - mu[j]));
  const S = Array.from({ length: N }, () => new Array<number>(N).fill(0));
  for (const z of Z) for (let i = 0; i < N; i++) for (let j = i; j < N; j++) S[i][j] += z[i] * z[j];
  for (let i = 0; i < N; i++) for (let j = i; j < N; j++) { S[i][j] /= T; S[j][i] = S[i][j]; }

  let m = 0;
  for (let i = 0; i < N; i++) m += S[i][i];
  m /= N;
  let d2 = 0, sNorm = 0;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    d2 += (S[i][j] - (i === j ? m : 0)) ** 2;
    sNorm += S[i][j] ** 2;
  }
  d2 /= N;
  // ‖zzᵀ − S‖² = (zᵀz)² − 2zᵀSz + ‖S‖²
  let b2 = 0;
  for (const z of Z) {
    let zz = 0, zSz = 0;
    for (let i = 0; i < N; i++) {
      zz += z[i] * z[i];
      let s = 0;
      for (let j = 0; j < N; j++) s += S[i][j] * z[j];
      zSz += z[i] * s;
    }
    b2 += zz * zz - 2 * zSz + sNorm;
  }
  b2 = Math.min(b2 / N / (T * T), d2);
  const delta = d2 > 0 ? b2 / d2 : 1;
  const cov = S.map((row, i) => row.map((s, j) => (1 - delta) * s + (i === j ? delta * m : 0)));
  return { cov, shrinkage: delta };
}

/** Daily adjusted closes on the calendar dates, carrying the last close forward. */
export function onCalendar(bars: readonly Bar[], dates: readonly string[]): { closes: number[]; missing: number } | null {
  if (!bars.length || bars[0].date > dates[0]) return null;
  const closes: number[] = [];
  let k = 0, last = NaN, missing = 0;
  for (const d of dates) {
    let hit = false;
    while (k < bars.length && bars[k].date <= d) {
      if (bars[k].date === d) hit = true;
      last = bars[k].adjClose;
      k++;
    }
    if (!hit) missing++;
    closes.push(last);
  }
  return { closes, missing };
}

/** Simple returns between consecutive closes. */
export const rets = (xs: readonly number[]) => xs.slice(1).map((x, i) => x / xs[i] - 1);

function adjOnOrBefore(bars: readonly Bar[], date: string): number | null {
  let ans: number | null = null;
  for (const b of bars) { if (b.date > date) break; ans = b.adjClose; }
  return ans;
}

export function portfolioRisk(input: RiskInput): PortfolioRisk | null {
  const { nav, index, window } = input;
  if (!(nav > 0) || index.length < window + 1) return null;
  const dates = index.slice(-(window + 1)).map((b) => b.date);
  const idx = rets(index.slice(-(window + 1)).map((b) => b.adjClose));

  type Measured = { h: RiskHolding; w: number; r: number[]; missing: number };
  const measured: Measured[] = [];
  const unmeasured: PortfolioRisk["unmeasured"] = [];
  let invested = 0;
  for (const h of input.holdings) {
    const w = (h.qty * h.price) / nav;
    invested += w;
    const cal = onCalendar(h.bars, dates);
    if (!cal) {
      unmeasured.push({ ticker: h.ticker, weight: w, reason: h.bars.length ? `history starts ${h.bars[0].date}, after the window opens ${dates[0]}` : "no daily history" });
      continue;
    }
    measured.push({ h, w, r: rets(cal.closes), missing: cal.missing });
  }

  const T = idx.length;
  const w = measured.map((m) => m.w);
  const X = Array.from({ length: T }, (_, t) => measured.map((m) => m.r[t]));
  const { cov, shrinkage } = ledoitWolf(X);
  const Sw = cov.map((row) => row.reduce((s, c, j) => s + c * w[j], 0));
  const pVar = w.reduce((s, wi, i) => s + wi * Sw[i], 0);
  const sigma = Math.sqrt(Math.max(0, pVar));

  const p = X.map((row) => row.reduce((s, r, i) => s + r * w[i], 0));
  const active = p.map((x, t) => x - idx[t]);
  const aVar = variance(active);
  const iVar = variance(idx);

  const tail = (level: number) => {
    const z = normInv(level);
    return {
      var: { parametric: z * sigma, historical: historicalVaR(p, level) },
      es: { parametric: (sigma * normPdf(z)) / (1 - level), historical: cvar(p, level) },
    };
  };
  const t95 = tail(0.95), t99 = tail(0.99);

  // Stress windows: the index's own worst in-year decline.
  const windows = input.stressYears.flatMap((y) => {
    const bars = index.filter((b) => b.date.startsWith(`${y}-`));
    if (bars.length < 2) return [];
    const dd = maxDrawdown(bars.map((b) => b.adjClose));
    if (!(dd.maxDrawdown > 0)) return [];
    return [{ label: String(y), peak: bars[dd.peakIndex].date, trough: bars[dd.troughIndex].date, index_return: -dd.maxDrawdown }];
  });

  const names: NameRisk[] = measured.map((m, i) => {
    const bars = m.h.bars;
    const recent = bars.filter((b) => b.date <= dates[dates.length - 1]).slice(-input.advWindow);
    const adv = recent.length ? mean(recent.map((b) => b.volume)) : 0;
    const stress: Record<string, number | null> = {};
    for (const s of windows) {
      const a = bars[0].date <= s.peak ? adjOnOrBefore(bars, s.peak) : null;
      const b = a == null ? null : adjOnOrBefore(bars, s.trough);
      stress[s.label] = a != null && b != null ? b / a - 1 : null;
    }
    return {
      ticker: m.h.ticker,
      weight: m.w,
      vol_annual: std(m.r) * Math.sqrt(TRADING_DAYS),
      active_vol: std(m.r.map((x, t) => x - idx[t])) * Math.sqrt(TRADING_DAYS),
      beta: iVar > 0 ? covariance(m.r, idx) / iVar : 0,
      risk_share: pVar > 0 ? (m.w * Sw[i]) / pVar : 0,
      te_share: aVar > 0 ? (m.w * covariance(m.r, active)) / aVar : 0,
      adv_days: adv > 0 ? m.h.qty / adv : null,
      adv_shares: adv > 0 ? adv : null,
      missing_days: m.missing,
      last_bar: bars[bars.length - 1].date,
      stress,
    };
  });

  // Unmeasured names can still be replayed when they traded through a window.
  const stressOf = (h: RiskHolding, s: (typeof windows)[number]) => {
    if (!h.bars.length || h.bars[0].date > s.peak) return null;
    const a = adjOnOrBefore(h.bars, s.peak), b = adjOnOrBefore(h.bars, s.trough);
    return a != null && b != null ? b / a - 1 : null;
  };
  const stress: StressReplay[] = windows.map((s) => {
    let ret = 0, covered = 0;
    for (const h of input.holdings) {
      const r = stressOf(h, s);
      if (r == null) continue;
      const wi = (h.qty * h.price) / nav;
      ret += wi * r;
      covered += wi;
    }
    return { ...s, book_return: ret, covered_weight: covered, uncovered_weight: invested - covered };
  });

  const measuredWeight = w.reduce((s, x) => s + x, 0);
  return {
    as_of: dates[dates.length - 1],
    window: { start: dates[0], end: dates[dates.length - 1], observations: T },
    nav,
    cash_weight: 1 - invested,
    measured_weight: measuredWeight,
    unmeasured,
    unmeasured_weight: invested - measuredWeight,
    vol_annual: sigma * Math.sqrt(TRADING_DAYS),
    var95: t95.var,
    var99: t99.var,
    es95: t95.es,
    es99: t99.es,
    beta: iVar > 0 ? covariance(p, idx) / iVar : 0,
    tracking_error: Math.sqrt(Math.max(0, aVar)) * Math.sqrt(TRADING_DAYS),
    index_vol: Math.sqrt(iVar) * Math.sqrt(TRADING_DAYS),
    index_te_share: aVar > 0 ? -covariance(idx, active) / aVar : 0,
    shrinkage,
    names: names.sort((a, b) => b.risk_share - a.risk_share),
    stress,
  };
}
