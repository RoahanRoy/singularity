/**
 * Time-series models: ARIMA (ARMA on log returns), GARCH(1,1), exponential
 * smoothing (SES / damped Holt), Kalman filters (local linear trend, dynamic
 * beta), ADF unit-root tests, Engle-Granger cointegration for pairs, and a
 * two-state Markov regime-switching model (bull/bear).
 *
 * Every forecaster reports an out-of-sample comparison against the naive
 * benchmark (random walk / trailing realized variance). Most lose to it on
 * returns — the agents say so instead of hiding it.
 */

import { mean, variance, std, nelderMead, ols, clamp, ljungBox } from "./stats";
import { neweyWestLags } from "./factors";

// ── ARMA / ARIMA ────────────────────────────────────────────────────────────

export type ArmaFit = {
  p: number;
  q: number;
  c: number;
  phi: number[];
  theta: number[];
  sigma2: number;
  aic: number;
  n: number;
  converged: boolean;
};

/** AR part stationary (p ≤ 2): φ1 + φ2 < 1, φ2 − φ1 < 1, |φ2| < 1. */
export function arStationary(phi: readonly number[]): boolean {
  if (phi.length === 0) return true;
  if (phi.length === 1) return Math.abs(phi[0]) < 1;
  const [a, b] = phi;
  return a + b < 1 && b - a < 1 && Math.abs(b) < 1;
}

/** MA part invertible: the same triangle applied to −θ. */
export function maInvertible(theta: readonly number[]): boolean {
  return arStationary(theta.map((t) => -t));
}

/** Conditional-sum-of-squares residuals from index `start` (earlier residuals are 0). */
export function armaResiduals(x: readonly number[], c: number, phi: readonly number[], theta: readonly number[], start: number): number[] {
  const e = new Array<number>(x.length).fill(0);
  for (let t = start; t < x.length; t++) {
    let pred = c;
    for (let i = 0; i < phi.length; i++) pred += phi[i] * x[t - 1 - i];
    for (let j = 0; j < theta.length; j++) if (t - 1 - j >= 0) pred += theta[j] * e[t - 1 - j];
    e[t] = x[t] - pred;
  }
  return e;
}

/** Fit ARMA(p, q) by CSS + Nelder-Mead, rejecting non-stationary / non-invertible parameters. */
export function fitArma(x: readonly number[], p: number, q: number, start = Math.max(p, 2)): ArmaFit | null {
  const n = x.length - start;
  if (n < 30) return null;
  const m = mean(x);
  const sse = (v: number[]) => {
    const c = v[0], phi = v.slice(1, 1 + p), theta = v.slice(1 + p);
    if (!arStationary(phi) || !maInvertible(theta)) return Infinity;
    const e = armaResiduals(x, c, phi, theta, start);
    let s = 0;
    for (let t = start; t < x.length; t++) s += e[t] * e[t];
    return s;
  };
  const x0 = [m, ...new Array(p).fill(0), ...new Array(q).fill(0)];
  const sd = std(x) || 1e-3;
  const r = nelderMead(sse, x0, { step: [sd * 0.1, ...new Array(p + q).fill(0.1)], maxIter: 3000 });
  if (!Number.isFinite(r.fx)) return null;
  const sigma2 = r.fx / n;
  const k = p + q + 2; // c, φ, θ, σ²
  const ll = -0.5 * n * (Math.log(2 * Math.PI * sigma2) + 1);
  return { p, q, c: r.x[0], phi: r.x.slice(1, 1 + p), theta: r.x.slice(1 + p), sigma2, aic: -2 * ll + 2 * k, n, converged: r.converged };
}

/** Grid-search p, q ≤ max on a common sample; lowest AIC wins. */
export function selectArma(x: readonly number[], maxP = 2, maxQ = 2): ArmaFit | null {
  let best: ArmaFit | null = null;
  const start = Math.max(maxP, 2);
  for (let p = 0; p <= maxP; p++) {
    for (let q = 0; q <= maxQ; q++) {
      const f = fitArma(x, p, q, start);
      if (f && (!best || f.aic < best.aic)) best = f;
    }
  }
  return best;
}

/** h-step point forecasts of x given the full history (future shocks = 0). */
export function armaForecast(fit: ArmaFit, x: readonly number[], h: number): number[] {
  const e = armaResiduals(x, fit.c, fit.phi, fit.theta, Math.max(fit.p, 2));
  const xs = [...x];
  const es = [...e];
  const out: number[] = [];
  for (let k = 0; k < h; k++) {
    const t = xs.length;
    let pred = fit.c;
    for (let i = 0; i < fit.p; i++) pred += fit.phi[i] * xs[t - 1 - i];
    for (let j = 0; j < fit.q; j++) pred += fit.theta[j] * es[t - 1 - j];
    xs.push(pred);
    es.push(0);
    out.push(pred);
  }
  return out;
}

export type OosScore = {
  n: number;
  mseModel: number;
  mseBenchmark: number;
  /** 1 − MSE_model / MSE_benchmark: > 0 means the model beat the benchmark out of sample. */
  skill: number;
  hitRate: number | null;
  /**
   * Diebold-Mariano t-stat: mean of (benchmark loss − model loss) over its
   * Newey-West standard error. ≥ 2 means the model's edge is not luck.
   */
  dmT: number;
};

/**
 * Diebold-Mariano test on squared-error loss differentials. Volatility
 * clustering makes them autocorrelated, so the lag count never drops below
 * the automatic Newey-West choice (or h − 1 for overlapping h-step forecasts).
 */
export function dieboldMariano(lossDiff: readonly number[], horizon = 1): number {
  if (lossDiff.length < 30) return NaN;
  const r = ols(lossDiff, lossDiff.map(() => []), { neweyWestLags: Math.max(horizon - 1, neweyWestLags(lossDiff.length)) });
  return r && r.sigma2 > 0 && Number.isFinite(r.t[0]) ? r.t[0] : NaN;
}

export type ArimaReport = {
  order: [number, number, number];
  fit: ArmaFit;
  forecast1d: number;
  forecast21d: number;
  oos: OosScore;
  ljungBoxP: number;
};

/**
 * ARIMA(p,1,q) on log prices ⇔ ARMA(p,q) on log returns. Order chosen on the
 * first 70%, scored one step ahead on the last 30% with frozen parameters
 * against a random walk with drift, then refit on everything for the forecast.
 */
export function arimaReport(logRets: readonly number[]): ArimaReport | null {
  if (logRets.length < 250) return null;
  const split = Math.floor(logRets.length * 0.7);
  const train = logRets.slice(0, split);
  const sel = selectArma(train);
  if (!sel) return null;
  const e = armaResiduals(logRets, sel.c, sel.phi, sel.theta, Math.max(sel.p, 2));
  const drift = mean(train);
  let sm = 0, sb = 0, hits = 0, cnt = 0;
  const diff: number[] = [];
  for (let t = split; t < logRets.length; t++) {
    const pred = logRets[t] - e[t];
    sm += e[t] * e[t];
    sb += (logRets[t] - drift) ** 2;
    diff.push((logRets[t] - drift) ** 2 - e[t] * e[t]);
    if (pred !== 0 && logRets[t] !== 0) { cnt++; if (Math.sign(pred) === Math.sign(logRets[t])) hits++; }
  }
  const nT = logRets.length - split;
  const full = fitArma(logRets, sel.p, sel.q) ?? sel;
  const f = armaForecast(full, logRets, 21);
  const resid = armaResiduals(logRets, full.c, full.phi, full.theta, Math.max(full.p, 2)).slice(2);
  return {
    order: [full.p, 1, full.q],
    fit: full,
    forecast1d: f[0],
    forecast21d: f.reduce((a, b) => a + b, 0),
    oos: { n: nT, mseModel: sm / nT, mseBenchmark: sb / nT, skill: 1 - sm / sb, hitRate: cnt ? hits / cnt : null, dmT: dieboldMariano(diff) },
    ljungBoxP: ljungBox(resid, 10, full.p + full.q).p,
  };
}

// ── GARCH(1,1) ──────────────────────────────────────────────────────────────

export type GarchParams = { omega: number; alpha: number; beta: number; mu: number };
export type GarchFit = GarchParams & { persistence: number; longRunVar: number; logLik: number; converged: boolean };

const garchFromX = (x: number[]) => {
  const ea = Math.exp(x[0]), eb = Math.exp(x[1]);
  const d = 1 + ea + eb;
  return { alpha: ea / d, beta: eb / d };
};

/** σ²ₜ = ω + α·ε²ₜ₋₁ + β·σ²ₜ₋₁, started at the long-run variance. */
export function garchFilter(rets: readonly number[], p: GarchParams, sigma2Start?: number): number[] {
  const s2 = new Array<number>(rets.length + 1);
  const lr = p.omega / Math.max(1e-12, 1 - p.alpha - p.beta);
  s2[0] = sigma2Start ?? lr;
  for (let t = 0; t < rets.length; t++) {
    const e = rets[t] - p.mu;
    s2[t + 1] = p.omega + p.alpha * e * e + p.beta * s2[t];
  }
  return s2; // s2[t] is the variance of rets[t] given data before t; s2[n] is the next-day forecast
}

/** Gaussian MLE with variance targeting: ω = σ̄²(1 − α − β). */
export function fitGarch(rets: readonly number[]): GarchFit | null {
  if (rets.length < 100) return null;
  const mu = mean(rets);
  const v = variance(rets);
  if (!(v > 0)) return null;
  const nll = (x: number[]) => {
    const { alpha, beta } = garchFromX(x);
    if (alpha + beta >= 0.9999) return Infinity;
    const omega = v * (1 - alpha - beta);
    const s2 = garchFilter(rets, { omega, alpha, beta, mu }, v);
    let ll = 0;
    for (let t = 0; t < rets.length; t++) {
      const e = rets[t] - mu;
      ll += Math.log(s2[t]) + (e * e) / s2[t];
    }
    return 0.5 * (ll + rets.length * Math.log(2 * Math.PI));
  };
  const r = nelderMead(nll, [Math.log(4), Math.log(45)], { step: 0.5, maxIter: 2000 });
  if (!Number.isFinite(r.fx)) return null;
  const { alpha, beta } = garchFromX(r.x);
  const omega = v * (1 - alpha - beta);
  return { omega, alpha, beta, mu, persistence: alpha + beta, longRunVar: v, logLik: -r.fx, converged: r.converged };
}

/** σ²ₜ₊ₕ = σ̄² + (α + β)^(h−1)·(σ²ₜ₊₁ − σ̄²), for h = 1..H. */
export function garchTermStructure(fit: GarchFit, nextVar: number, h: number): number[] {
  const out: number[] = [];
  for (let k = 1; k <= h; k++) out.push(fit.longRunVar + Math.pow(fit.persistence, k - 1) * (nextVar - fit.longRunVar));
  return out;
}

export type GarchReport = {
  fit: GarchFit;
  /** Annualized vols (decimal). */
  currentVol: number;
  forecastVol21d: number;
  forecastVol63d: number;
  longRunVol: number;
  /** Days for a variance shock to decay halfway: ln 0.5 / ln(α + β). */
  halfLifeDays: number;
  /** Next-day σ of returns (decimal, not annualized) — feeds VaR and Monte Carlo. */
  nextDaySigma: number;
  oos: { n: number; qlikeGarch: number; qlikeNaive: number; beatsNaive: boolean };
};

const qlike = (rv: number, f: number) => (rv > 0 && f > 0 ? rv / f - Math.log(rv / f) - 1 : 0);

/**
 * Fit on the first 70%, then forecast the next-21-day average variance at each
 * test date with frozen parameters and score it (QLIKE) against the trailing
 * 21-day realized variance. Refit on the full sample for today's forecast.
 */
export function garchReport(rets: readonly number[]): GarchReport | null {
  if (rets.length < 300) return null;
  const split = Math.floor(rets.length * 0.7);
  const tr = fitGarch(rets.slice(0, split));
  let oos = { n: 0, qlikeGarch: NaN, qlikeNaive: NaN, beatsNaive: false };
  if (tr) {
    const s2 = garchFilter(rets, tr, tr.longRunVar);
    let lg = 0, ln = 0, n = 0;
    for (let t = split; t + 21 < rets.length; t++) {
      let rv = 0, trail = 0;
      for (let h = 1; h <= 21; h++) rv += (rets[t + h] - tr.mu) ** 2;
      for (let h = 0; h < 21; h++) trail += (rets[t - h] - tr.mu) ** 2;
      rv /= 21; trail /= 21;
      const fc = garchTermStructure(tr, s2[t + 1], 21);
      const f = fc.reduce((a, b) => a + b, 0) / 21;
      lg += qlike(rv, f); ln += qlike(rv, trail); n++;
    }
    if (n) oos = { n, qlikeGarch: lg / n, qlikeNaive: ln / n, beatsNaive: lg < ln };
  }
  const fit = fitGarch(rets);
  if (!fit) return null;
  const s2 = garchFilter(rets, fit, fit.longRunVar);
  const next = s2[rets.length];
  const ts = garchTermStructure(fit, next, 63);
  const avgVol = (h: number) => Math.sqrt((ts.slice(0, h).reduce((a, b) => a + b, 0) / h) * 252);
  return {
    fit,
    currentVol: Math.sqrt(s2[rets.length - 1] * 252),
    forecastVol21d: avgVol(21),
    forecastVol63d: avgVol(63),
    longRunVol: Math.sqrt(fit.longRunVar * 252),
    halfLifeDays: fit.persistence > 0 && fit.persistence < 1 ? Math.log(0.5) / Math.log(fit.persistence) : Infinity,
    nextDaySigma: Math.sqrt(next),
    oos,
  };
}

// ── Exponential smoothing ───────────────────────────────────────────────────

const logistic = (z: number) => 1 / (1 + Math.exp(-z));
const logit = (p: number) => Math.log(p / (1 - p));

/** Damped Holt: ℓₜ = αyₜ + (1−α)(ℓₜ₋₁ + φbₜ₋₁); bₜ = β(ℓₜ − ℓₜ₋₁) + (1−β)φbₜ₋₁. β = 0, φ = 0 → SES. */
export function holt(y: readonly number[], alpha: number, beta: number, phi: number) {
  let l = y[0];
  let b = y.length > 1 ? y[1] - y[0] : 0;
  let sse = 0;
  const level = [l], trend = [b];
  for (let t = 1; t < y.length; t++) {
    const f = l + phi * b;
    sse += (y[t] - f) ** 2;
    const ln = alpha * y[t] + (1 - alpha) * (l + phi * b);
    b = beta * (ln - l) + (1 - beta) * phi * b;
    l = ln;
    level.push(l); trend.push(b);
  }
  return { level, trend, sse };
}

export function holtForecast(l: number, b: number, phi: number, h: number): number {
  let s = 0, p = 1;
  for (let k = 1; k <= h; k++) { p *= phi; s += p; }
  return l + s * b;
}

export type SmoothingFit = { alpha: number; beta: number; phi: number; sse: number };

/** Simple exponential smoothing (no trend): Holt with β = 0 and φ = 0. */
export function fitSes(y: readonly number[]): SmoothingFit {
  const r = nelderMead((x) => holt(y, logistic(x[0]), 0, 0).sse, [logit(0.5)], { step: 1 });
  return { alpha: logistic(r.x[0]), beta: 0, phi: 0, sse: r.fx };
}

/** φ is kept in [0.8, 0.98] (Hyndman's recommended damping range). */
export function fitHoltDamped(y: readonly number[]): SmoothingFit {
  const phiOf = (z: number) => 0.8 + 0.18 * logistic(z);
  const r = nelderMead((x) => holt(y, logistic(x[0]), logistic(x[1]), phiOf(x[2])).sse, [logit(0.8), logit(0.05), 0], { step: 1, maxIter: 1500 });
  return { alpha: logistic(r.x[0]), beta: logistic(r.x[1]), phi: phiOf(r.x[2]), sse: r.fx };
}

export type SmoothingReport = {
  ses: SmoothingFit;
  holt: SmoothingFit;
  /** Holt trend in log-price units per day, annualized ×252. */
  trendAnnual: number;
  forecast21dReturn: number;
  /** 5-day-ahead log-price forecasts on the last 30% vs the random walk. */
  oos: OosScore;
};

export function smoothingReport(logPrices: readonly number[]): SmoothingReport | null {
  if (logPrices.length < 250) return null;
  const split = Math.floor(logPrices.length * 0.7);
  const trainFit = fitHoltDamped(logPrices.slice(0, split));
  const run = holt(logPrices, trainFit.alpha, trainFit.beta, trainFit.phi);
  const H = 5;
  let sm = 0, sb = 0, hits = 0, cnt = 0, n = 0;
  const diff: number[] = [];
  for (let t = split; t + H < logPrices.length; t++) {
    const f = holtForecast(run.level[t], run.trend[t], trainFit.phi, H);
    const actual = logPrices[t + H];
    sm += (actual - f) ** 2;
    sb += (actual - logPrices[t]) ** 2;
    diff.push((actual - logPrices[t]) ** 2 - (actual - f) ** 2);
    const dirF = f - logPrices[t], dirA = actual - logPrices[t];
    if (dirF !== 0 && dirA !== 0) { cnt++; if (Math.sign(dirF) === Math.sign(dirA)) hits++; }
    n++;
  }
  const ses = fitSes(logPrices);
  const fit = fitHoltDamped(logPrices);
  const all = holt(logPrices, fit.alpha, fit.beta, fit.phi);
  const L = all.level[all.level.length - 1], B = all.trend[all.trend.length - 1];
  return {
    ses, holt: fit,
    trendAnnual: B * 252,
    forecast21dReturn: holtForecast(L, B, fit.phi, 21) - logPrices[logPrices.length - 1],
    oos: { n, mseModel: n ? sm / n : NaN, mseBenchmark: n ? sb / n : NaN, skill: sb > 0 ? 1 - sm / sb : NaN, hitRate: cnt ? hits / cnt : null, dmT: dieboldMariano(diff, H) },
  };
}

// ── Kalman filters ──────────────────────────────────────────────────────────

export type TrendFilter = { level: number[]; slope: number[]; slopeVar: number[]; logLik: number };

/**
 * Local linear trend: yₜ = ℓₜ + εₜ; ℓₜ = ℓₜ₋₁ + sₜ₋₁ + ηₜ; sₜ = sₜ₋₁ + ζₜ.
 * Prediction-error log-likelihood skips a short burn-in for the diffuse start.
 */
export function localLinearTrend(y: readonly number[], q1: number, q2: number, r: number, burn = 10): TrendFilter {
  let x0 = y[0], x1 = 0;
  let p00 = 1, p01 = 0, p11 = 0.01;
  let ll = 0;
  const level: number[] = [], slope: number[] = [], slopeVar: number[] = [];
  for (let t = 0; t < y.length; t++) {
    // predict
    const a0 = x0 + x1, a1 = x1;
    const m00 = p00 + 2 * p01 + p11 + q1;
    const m01 = p01 + p11;
    const m11 = p11 + q2;
    // update
    const v = y[t] - a0;
    const S = m00 + r;
    const k0 = m00 / S, k1 = m01 / S;
    x0 = a0 + k0 * v; x1 = a1 + k1 * v;
    p00 = m00 - k0 * m00; p01 = m01 - k0 * m01; p11 = m11 - k1 * m01;
    if (t >= burn) ll += -0.5 * (Math.log(2 * Math.PI * S) + (v * v) / S);
    level.push(x0); slope.push(x1); slopeVar.push(Math.max(p11, 0));
  }
  return { level, slope, slopeVar, logLik: ll };
}

export type TrendReport = {
  q: [number, number];
  r: number;
  /** Filtered drift, annualized log-return units. */
  slopeAnnual: number;
  slopeT: number;
  /** Price above (+) or below (−) the filtered level, %. */
  priceVsLevelPct: number;
  signal: "uptrend" | "downtrend" | "no clear trend";
};

export function kalmanTrendReport(logPrices: readonly number[]): TrendReport | null {
  if (logPrices.length < 120) return null;
  const d = variance(logPrices.slice(1).map((v, i) => v - logPrices[i])) || 1e-4;
  const obj = (z: number[]) => -localLinearTrend(logPrices, Math.exp(z[0]), Math.exp(z[1]), Math.exp(z[2])).logLik;
  const r = nelderMead(obj, [Math.log(d * 0.5), Math.log(d * 1e-4), Math.log(d * 0.5)], { step: 1, maxIter: 1500 });
  const [q1, q2, rv] = r.x.map(Math.exp);
  const f = localLinearTrend(logPrices, q1, q2, rv);
  const n = logPrices.length - 1;
  const s = f.slope[n], se = Math.sqrt(f.slopeVar[n]);
  const t = se > 0 ? s / se : 0;
  return {
    q: [q1, q2], r: rv,
    slopeAnnual: s * 252, slopeT: t,
    priceVsLevelPct: (Math.exp(logPrices[n] - f.level[n]) - 1) * 100,
    signal: t > 2 ? "uptrend" : t < -2 ? "downtrend" : "no clear trend",
  };
}

/** Time-varying beta: rₛ = α + βₜ·rₘ + ε, βₜ a random walk. (q, R) by MLE. */
export function kalmanBeta(asset: readonly number[], market: readonly number[]): { beta: number; betaSe: number; path: number[]; q: number; r: number } | null {
  const n = Math.min(asset.length, market.length);
  if (n < 120) return null;
  const a = asset.slice(-n), m = market.slice(-n);
  const base = ols(a, m.map((x) => [x]));
  if (!base) return null;
  const alpha = base.coef[0];
  const run = (q: number, r: number) => {
    let b = base.coef[1], P = 1;
    let ll = 0;
    const path: number[] = [];
    for (let t = 0; t < n; t++) {
      const Pm = P + q;
      const v = a[t] - alpha - b * m[t];
      const S = m[t] * m[t] * Pm + r;
      const K = (Pm * m[t]) / S;
      b += K * v;
      P = (1 - K * m[t]) * Pm;
      if (t >= 20) ll += -0.5 * (Math.log(2 * Math.PI * S) + (v * v) / S);
      path.push(b);
    }
    return { ll, path, P, b };
  };
  const rv = base.sigma2;
  const opt = nelderMead((z) => -run(Math.exp(z[0]), Math.exp(z[1])).ll, [Math.log(1e-4), Math.log(rv)], { step: 1 });
  const q = Math.exp(opt.x[0]), r = Math.exp(opt.x[1]);
  const fin = run(q, r);
  return { beta: fin.b, betaSe: Math.sqrt(fin.P), path: fin.path, q, r };
}

// ── Unit roots and cointegration ────────────────────────────────────────────

type Crit = { "1%": number; "5%": number; "10%": number };

/** MacKinnon (2010) response surfaces τ(T) = β∞ + β₁/T + β₂/T² + β₃/T³ (constant case). */
const MACKINNON: Record<1 | 2, Record<keyof Crit, [number, number, number, number]>> = {
  1: { "1%": [-3.43035, -6.5393, -16.786, -79.433], "5%": [-2.86154, -2.8903, -4.234, -40.04], "10%": [-2.56677, -1.5384, -2.809, 0] },
  2: { "1%": [-3.89644, -10.9519, -33.527, 0], "5%": [-3.33613, -6.1101, -6.823, 0], "10%": [-3.04445, -4.2412, -2.72, 0] },
};

export function mackinnonCrit(T: number, nVars: 1 | 2): Crit {
  const f = ([b0, b1, b2, b3]: [number, number, number, number]) => b0 + b1 / T + b2 / (T * T) + b3 / (T * T * T);
  const t = MACKINNON[nVars];
  return { "1%": f(t["1%"]), "5%": f(t["5%"]), "10%": f(t["10%"]) };
}

export type AdfResult = { stat: number; lags: number; nobs: number; crit: Crit; pBucket: "<1%" | "<5%" | "<10%" | ">10%"; gamma: number };

function adfRegression(y: readonly number[], lags: number, start: number, constant: boolean) {
  const dy = y.slice(1).map((v, i) => v - y[i]);
  const rows: number[][] = [];
  const target: number[] = [];
  for (let t = start; t < dy.length; t++) {
    const row = [y[t]];
    for (let i = 1; i <= lags; i++) row.push(dy[t - i]);
    rows.push(row);
    target.push(dy[t]);
  }
  return ols(target, rows, { intercept: constant });
}

/**
 * Augmented Dickey-Fuller: Δyₜ = a + γyₜ₋₁ + Σδᵢ Δyₜ₋ᵢ + eₜ, lags by AIC up to
 * Schwert's 12·(T/100)^¼ on a common sample, then refit at the chosen lag.
 * `nVars` = 2 applies Engle-Granger critical values to cointegration residuals
 * (which are tested without a constant).
 */
export function adf(y: readonly number[], opts: { maxLags?: number; nVars?: 1 | 2 } = {}): AdfResult | null {
  const T = y.length;
  if (T < 50) return null;
  const nVars = opts.nVars ?? 1;
  const constant = nVars === 1;
  const maxL = opts.maxLags ?? Math.floor(12 * Math.pow(T / 100, 0.25));
  let bestL = 0, bestAic = Infinity;
  for (let L = 0; L <= maxL; L++) {
    const r = adfRegression(y, L, maxL, constant);
    if (!r) continue;
    const aic = r.n * Math.log((r.sigma2 * (r.n - r.k)) / r.n) + 2 * r.k;
    if (aic < bestAic) { bestAic = aic; bestL = L; }
  }
  const fin = adfRegression(y, bestL, bestL, constant);
  if (!fin) return null;
  const gi = constant ? 1 : 0;
  const stat = fin.t[gi];
  const crit = mackinnonCrit(fin.n, nVars);
  const pBucket = stat < crit["1%"] ? "<1%" : stat < crit["5%"] ? "<5%" : stat < crit["10%"] ? "<10%" : ">10%";
  return { stat, lags: bestL, nobs: fin.n, crit, pBucket, gamma: fin.coef[gi] };
}

/**
 * Mean-reversion half-life from Δsₜ = a + b·sₜ₋₁: −ln 2 / ln(1 + b).
 * Infinity when not mean-reverting, or when the half-life exceeds ten times
 * the sample (indistinguishable from a random walk).
 */
export function halfLife(s: readonly number[]): number {
  const r = ols(s.slice(1).map((v, i) => v - s[i]), s.slice(0, -1).map((v) => [v]));
  if (!r) return Infinity;
  const b = r.coef[1];
  if (!(b < 0 && b > -1)) return Infinity;
  const hl = -Math.LN2 / Math.log1p(b);
  return Number.isFinite(hl) && hl < s.length * 10 ? hl : Infinity;
}

export type EngleGranger = {
  alpha: number;
  hedgeRatio: number;
  adf: AdfResult;
  halfLifeDays: number;
};

/** Engle-Granger step 1 (OLS y = α + βx) and step 2 (ADF on residuals with N = 2 critical values). */
export function engleGranger(y: readonly number[], x: readonly number[]): EngleGranger | null {
  const r = ols(y, x.map((v) => [v]));
  if (!r) return null;
  const a = adf(r.resid, { nVars: 2 });
  if (!a) return null;
  return { alpha: r.coef[0], hedgeRatio: r.coef[1], adf: a, halfLifeDays: halfLife(r.resid) };
}

export type PairCandidate = {
  peer: string;
  hedgeRatio: number;
  adfStat: number;
  critical: number;
  cointegrated: boolean;
  /** Same spread's ADF on the held-out 30% (frozen hedge ratio). */
  oosAdfStat: number | null;
  oosHalfLifeDays: number | null;
  halfLifeDays: number;
  /** Today's spread z-score vs the training mean/sd. Positive = this stock rich vs the peer. */
  zNow: number;
};

export type PairsReport = {
  tested: number;
  level: "1%" | "5%";
  best: PairCandidate | null;
  candidates: PairCandidate[];
};

/**
 * Pairs scan over same-sector peers on aligned log prices. Hedge ratios are
 * fitted on the first 70% and validated on the rest. With five or more peers
 * the bar is the 1% critical value (multiple-testing control), else 5%.
 */
export function pairsScan(own: readonly number[], peers: readonly { symbol: string; logp: readonly number[] }[]): PairsReport {
  const level: "1%" | "5%" = peers.length >= 5 ? "1%" : "5%";
  const cands: PairCandidate[] = [];
  for (const p of peers) {
    const n = Math.min(own.length, p.logp.length);
    if (n < 250) continue;
    const y = own.slice(-n), x = p.logp.slice(-n);
    const split = Math.floor(n * 0.7);
    const eg = engleGranger(y.slice(0, split), x.slice(0, split));
    if (!eg) continue;
    const spread = y.map((v, i) => v - eg.alpha - eg.hedgeRatio * x[i]);
    const trainS = spread.slice(0, split);
    const m = mean(trainS), sd = std(trainS);
    const test = spread.slice(split);
    const oos = test.length >= 50 ? adf(test.map((v) => v - m), { nVars: 2 }) : null;
    const crit = eg.adf.crit[level];
    cands.push({
      peer: p.symbol,
      hedgeRatio: eg.hedgeRatio,
      adfStat: eg.adf.stat,
      critical: crit,
      cointegrated: eg.adf.stat < crit && (oos ? oos.stat < oos.crit["10%"] : false),
      oosAdfStat: oos?.stat ?? null,
      oosHalfLifeDays: test.length >= 50 ? halfLife(test) : null,
      halfLifeDays: eg.halfLifeDays,
      zNow: sd > 0 ? (spread[n - 1] - m) / sd : 0,
    });
  }
  cands.sort((a, b) => a.adfStat - b.adfStat);
  return { tested: cands.length, level, best: cands.find((c) => c.cointegrated) ?? null, candidates: cands };
}

// ── Markov regime switching ────────────────────────────────────────────────

export type RegimeState = { mu: number; sigma: number; label: "bull" | "bear"; expectedDuration: number };

export type RegimeReport = {
  states: [RegimeState, RegimeState];
  /** P[i][j] = P(sₜ = j | sₜ₋₁ = i). */
  transition: [[number, number], [number, number]];
  current: "bull" | "bear";
  probBull: number;
  /** Filtered P(bull) for each observation (no look-ahead). */
  probBullPath: number[];
  logLik: number;
  iterations: number;
};

const npdf = (x: number, mu: number, s: number) => Math.exp(-0.5 * ((x - mu) / s) ** 2) / (s * Math.sqrt(2 * Math.PI));

/**
 * Two-state Gaussian Markov-switching model fitted by EM (Hamilton filter +
 * Kim smoother). The state with the higher mean is labelled bull; both
 * states' volatility is reported because bear regimes are usually the
 * high-volatility ones.
 */
export function markovSwitching(x: readonly number[], opts: { maxIter?: number; tol?: number } = {}): RegimeReport | null {
  const T = x.length;
  if (T < 60) return null;
  const sd = std(x), m = mean(x);
  let mu = [m + 0.25 * sd, m - 0.25 * sd];
  let sg = [0.7 * sd, 1.4 * sd];
  let P = [[0.95, 0.05], [0.05, 0.95]];
  let pi = [0.5, 0.5];
  let llOld = -Infinity, ll = -Infinity, it = 0;
  let filt: number[][] = [], pred: number[][] = [];
  const maxIter = opts.maxIter ?? 500, tol = opts.tol ?? 1e-8;
  for (; it < maxIter; it++) {
    // E-step: Hamilton filter
    filt = []; pred = [];
    ll = 0;
    let prev = pi;
    for (let t = 0; t < T; t++) {
      const pr = t === 0 ? prev : [prev[0] * P[0][0] + prev[1] * P[1][0], prev[0] * P[0][1] + prev[1] * P[1][1]];
      const f0 = pr[0] * npdf(x[t], mu[0], sg[0]);
      const f1 = pr[1] * npdf(x[t], mu[1], sg[1]);
      const s = f0 + f1 || 1e-300;
      ll += Math.log(s);
      pred.push(pr);
      prev = [f0 / s, f1 / s];
      filt.push(prev);
    }
    // Kim smoother
    const sm: number[][] = new Array(T);
    sm[T - 1] = filt[T - 1];
    const joint = [[0, 0], [0, 0]];
    for (let t = T - 2; t >= 0; t--) {
      const r0 = sm[t + 1][0] / Math.max(pred[t + 1][0], 1e-300);
      const r1 = sm[t + 1][1] / Math.max(pred[t + 1][1], 1e-300);
      const s0 = filt[t][0] * (P[0][0] * r0 + P[0][1] * r1);
      const s1 = filt[t][1] * (P[1][0] * r0 + P[1][1] * r1);
      sm[t] = [s0, s1];
      joint[0][0] += filt[t][0] * P[0][0] * r0;
      joint[0][1] += filt[t][0] * P[0][1] * r1;
      joint[1][0] += filt[t][1] * P[1][0] * r0;
      joint[1][1] += filt[t][1] * P[1][1] * r1;
    }
    // M-step
    const nu = [0, 0], w = [0, 0], w2 = [0, 0];
    for (let t = 0; t < T; t++) for (let k = 0; k < 2; k++) { nu[k] += sm[t][k]; w[k] += sm[t][k] * x[t]; }
    mu = [w[0] / nu[0], w[1] / nu[1]];
    for (let t = 0; t < T; t++) for (let k = 0; k < 2; k++) w2[k] += sm[t][k] * (x[t] - mu[k]) ** 2;
    sg = [Math.max(Math.sqrt(w2[0] / nu[0]), sd * 0.05), Math.max(Math.sqrt(w2[1] / nu[1]), sd * 0.05)];
    const row0 = joint[0][0] + joint[0][1], row1 = joint[1][0] + joint[1][1];
    P = [
      [clamp(joint[0][0] / row0, 1e-4, 1 - 1e-4), 0],
      [0, clamp(joint[1][1] / row1, 1e-4, 1 - 1e-4)],
    ];
    P[0][1] = 1 - P[0][0];
    P[1][0] = 1 - P[1][1];
    pi = sm[0];
    if (Math.abs(ll - llOld) < tol * (1 + Math.abs(ll))) break;
    llOld = ll;
  }
  const bull = mu[0] >= mu[1] ? 0 : 1, bear = 1 - bull;
  const st = (k: number, label: "bull" | "bear"): RegimeState => ({ mu: mu[k], sigma: sg[k], label, expectedDuration: 1 / (1 - P[k][k]) });
  const probBullPath = filt.map((f) => f[bull]);
  const pb = probBullPath[T - 1];
  return {
    states: [st(bull, "bull"), st(bear, "bear")],
    transition: [[P[bull][bull], P[bull][bear]], [P[bear][bull], P[bear][bear]]],
    current: pb >= 0.5 ? "bull" : "bear",
    probBull: pb,
    probBullPath,
    logLik: ll,
    iterations: it,
  };
}

