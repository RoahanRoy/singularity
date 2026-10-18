/**
 * Risk metrics: volatility, beta, Sharpe = (Rp − Rf)/σ, Sortino, maximum
 * drawdown, Calmar, and 1-day Value-at-Risk three ways (historical,
 * parametric, Cornish-Fisher) plus expected shortfall (CVaR).
 * VaR / CVaR are returned as positive loss fractions (0.023 = 2.3% loss).
 */

import { mean, std, covariance, correlation, variance, quantile, skewness, excessKurtosis, normInv, normCdf, isNum, ols } from "./stats";
import { neweyWestLags } from "./factors";

export const TRADING_DAYS = 252;

export function annualizedVol(rets: readonly number[], ppy = TRADING_DAYS): number {
  return std(rets) * Math.sqrt(ppy);
}

export function beta(asset: readonly number[], market: readonly number[]): number {
  const n = Math.min(asset.length, market.length);
  const a = asset.slice(asset.length - n), m = market.slice(market.length - n);
  const v = variance(m);
  return v > 0 ? covariance(a, m) / v : NaN;
}

/** Annualized Sharpe = (mean − rf) / σ · √ppy, rf given annually. */
export function sharpe(rets: readonly number[], rfAnnual: number, ppy = TRADING_DAYS): number {
  const sd = std(rets);
  return sd > 0 ? ((mean(rets) - rfAnnual / ppy) / sd) * Math.sqrt(ppy) : NaN;
}

/** Annualized Sortino: excess return over downside deviation below the minimum acceptable return. */
export function sortino(rets: readonly number[], marAnnual: number, ppy = TRADING_DAYS): number {
  const mar = marAnnual / ppy;
  let dd = 0;
  for (const r of rets) { const d = Math.min(0, r - mar); dd += d * d; }
  const downside = Math.sqrt(dd / Math.max(1, rets.length));
  return downside > 0 ? ((mean(rets) - mar) / downside) * Math.sqrt(ppy) : NaN;
}

/**
 * Jobson-Korkie test, with Memmel's correction, that two return series
 * observed over the same periods have equal Sharpe ratios. Positive z means
 * `a` has the higher Sharpe; p is two-sided. Null when either series has no
 * variance or there are fewer than 30 paired observations.
 */
export function sharpeDifferenceTest(a: readonly number[], b: readonly number[]): { z: number; p: number; sharpeA: number; sharpeB: number; rho: number } | null {
  const n = Math.min(a.length, b.length);
  if (n < 30) return null;
  const x = a.slice(0, n), y = b.slice(0, n);
  const sx = std(x), sy = std(y);
  if (!(sx > 0) || !(sy > 0)) return null;
  const srA = mean(x) / sx, srB = mean(y) / sy, rho = correlation(x, y);
  const theta = (2 * (1 - rho) + 0.5 * (srA * srA + srB * srB - 2 * srA * srB * rho * rho)) / n;
  if (!(theta > 0)) return null;
  const z = (srA - srB) / Math.sqrt(theta);
  return { z, p: 2 * (1 - normCdf(Math.abs(z))), sharpeA: srA * Math.sqrt(TRADING_DAYS), sharpeB: srB * Math.sqrt(TRADING_DAYS), rho };
}

/**
 * Timing alpha: regress a strategy's daily excess return on buy-and-hold's,
 * r_s = α + β·r_hold + ε, with Newey-West errors. If a long/flat position
 * says nothing about the next day's return, α is zero less costs whatever
 * the asset's drift, and β is the average exposure. (Comparing Sharpe ratios
 * instead favors any rule that is often in cash whenever the asset falls.)
 * Alpha is annualized; null under 60 observations.
 */
export function timingAlpha(strategy: readonly number[], hold: readonly number[]): { alpha: number; t: number; beta: number } | null {
  const n = Math.min(strategy.length, hold.length);
  if (n < 60) return null;
  const r = ols(strategy.slice(0, n), hold.slice(0, n).map((h) => [h]), { neweyWestLags: neweyWestLags(n) });
  if (!r) return null;
  return { alpha: r.coef[0] * TRADING_DAYS, t: r.sigma2 > 0 && Number.isFinite(r.t[0]) ? r.t[0] : NaN, beta: r.coef[1] };
}

export type Drawdown = {
  /** Worst peak-to-trough decline as a positive fraction. */
  maxDrawdown: number;
  peakIndex: number;
  troughIndex: number;
  /** First index after the trough that regains the peak, or null if never recovered. */
  recoveryIndex: number | null;
  /** Current drawdown from the running peak. */
  current: number;
};

export function maxDrawdown(levels: readonly number[]): Drawdown {
  let peak = levels[0] ?? 0, peakIdx = 0;
  let worst = 0, wPeak = 0, wTrough = 0;
  for (let i = 1; i < levels.length; i++) {
    if (levels[i] > peak) { peak = levels[i]; peakIdx = i; }
    const dd = peak > 0 ? 1 - levels[i] / peak : 0;
    if (dd > worst) { worst = dd; wPeak = peakIdx; wTrough = i; }
  }
  let rec: number | null = null;
  for (let i = wTrough + 1; i < levels.length; i++) if (levels[i] >= levels[wPeak]) { rec = i; break; }
  const runPeak = Math.max(...levels);
  const last = levels[levels.length - 1] ?? 0;
  return { maxDrawdown: worst, peakIndex: wPeak, troughIndex: wTrough, recoveryIndex: worst > 0 ? rec : null, current: runPeak > 0 ? 1 - last / runPeak : 0 };
}

/** Compound annual growth of an equity curve sampled `ppy` times a year. */
export function curveCagr(levels: readonly number[], ppy = TRADING_DAYS): number {
  if (levels.length < 2 || !(levels[0] > 0) || !(levels[levels.length - 1] > 0)) return NaN;
  const years = (levels.length - 1) / ppy;
  return Math.pow(levels[levels.length - 1] / levels[0], 1 / years) - 1;
}

export function calmar(levels: readonly number[], ppy = TRADING_DAYS): number {
  const mdd = maxDrawdown(levels).maxDrawdown;
  return mdd > 0 ? curveCagr(levels, ppy) / mdd : NaN;
}

/** Historical-simulation VaR: the (1 − level) empirical quantile of returns, as a loss. */
export function historicalVaR(rets: readonly number[], level = 0.95): number {
  return Math.max(0, -quantile(rets, 1 - level));
}

/** Gaussian VaR: −(μ + σ·Φ⁻¹(1 − level)). */
export function parametricVaR(mu: number, sigma: number, level = 0.95): number {
  return Math.max(0, -(mu + sigma * normInv(1 - level)));
}

/** Cornish-Fisher VaR: adjusts the Gaussian quantile for sample skew and excess kurtosis. */
export function cornishFisherVaR(rets: readonly number[], level = 0.95): number {
  const z = normInv(1 - level);
  const s = skewness(rets), k = excessKurtosis(rets);
  const zcf = z + ((z * z - 1) * s) / 6 + ((z ** 3 - 3 * z) * k) / 24 - ((2 * z ** 3 - 5 * z) * s * s) / 36;
  return Math.max(0, -(mean(rets) + std(rets) * zcf));
}

/** Expected shortfall: mean loss on the days at or beyond historical VaR. */
export function cvar(rets: readonly number[], level = 0.95): number {
  const cut = quantile(rets, 1 - level);
  const tail = rets.filter((r) => r <= cut);
  return tail.length ? Math.max(0, -mean(tail)) : 0;
}

export type RiskReport = {
  observations: number;
  annualVol: number;
  beta: number | null;
  sharpe: number;
  sortino: number;
  maxDrawdown: Drawdown;
  calmar: number;
  /** 1-day 95% VaR / CVaR of a long position, as positive fractions. */
  var95: { historical: number; parametric: number; cornishFisher: number };
  cvar95: number;
  var99Historical: number;
  skew: number;
  excessKurtosis: number;
};

/**
 * Risk bundle for a daily price series (and optionally the market's, for
 * beta). Uses simple daily returns over the window given.
 */
export function riskReport(prices: readonly number[], rfAnnual: number, marketPrices?: readonly number[]): RiskReport | null {
  if (prices.length < 60) return null;
  const rets: number[] = [];
  for (let i = 1; i < prices.length; i++) rets.push(prices[i] / prices[i - 1] - 1);
  let b: number | null = null;
  if (marketPrices && marketPrices.length >= 60) {
    const mr: number[] = [];
    for (let i = 1; i < marketPrices.length; i++) mr.push(marketPrices[i] / marketPrices[i - 1] - 1);
    const v = beta(rets, mr);
    b = isNum(v) ? v : null;
  }
  return {
    observations: rets.length,
    annualVol: annualizedVol(rets),
    beta: b,
    sharpe: sharpe(rets, rfAnnual),
    sortino: sortino(rets, rfAnnual),
    maxDrawdown: maxDrawdown(prices),
    calmar: calmar(prices),
    var95: { historical: historicalVaR(rets), parametric: parametricVaR(mean(rets), std(rets)), cornishFisher: cornishFisherVaR(rets) },
    cvar95: cvar(rets),
    var99Historical: historicalVaR(rets, 0.99),
    skew: skewness(rets),
    excessKurtosis: excessKurtosis(rets),
  };
}

/** Position VaR as % of NAV: weight% × the position's own 1-day VaR. */
export function positionVarPct(weightPct: number, dailyVar: number): number {
  return (weightPct / 100) * dailyVar * 100;
}
