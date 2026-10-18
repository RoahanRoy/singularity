/**
 * Stochastic price models: geometric Brownian motion, Monte Carlo price
 * distributions (GARCH-driven and block-bootstrap), Merton jump diffusion,
 * Ornstein-Uhlenbeck mean reversion, and Black-Scholes / implied volatility.
 *
 * Simulations use a real-world drift of rf + β·ERP (the CAPM expected
 * return), never the historical mean return, which is mostly noise.
 */

import { mean, std, variance, normCdf, normPdf, nelderMead, chiSquareCdf, mulberry32, normalSampler, poissonSample, clamp, ols, type Rng } from "./stats";
import { adf, type AdfResult } from "./timeseries";

const DAYS = 252;

// ── GBM: dS = μS·dt + σS·dW ─────────────────────────────────────────────────

export type GbmFit = { mu: number; sigma: number; n: number };

/** Annualized GBM parameters from daily log returns: σ = sd·√252, μ = mean·252 + σ²/2. */
export function fitGbm(logRets: readonly number[]): GbmFit | null {
  if (logRets.length < 20) return null;
  const sigma = std(logRets) * Math.sqrt(DAYS);
  return { mu: mean(logRets) * DAYS + (sigma * sigma) / 2, sigma, n: logRets.length };
}

/** P(S_T > K) under GBM with real-world drift μ: N(d₂). T in years. */
export function gbmProbAbove(s0: number, k: number, mu: number, sigma: number, T: number): number {
  if (!(s0 > 0 && k > 0 && sigma > 0 && T > 0)) return NaN;
  return normCdf((Math.log(s0 / k) + (mu - (sigma * sigma) / 2) * T) / (sigma * Math.sqrt(T)));
}

/** GBM terminal-price quantile: S₀·exp((μ − σ²/2)T + σ√T·z_q). */
export function gbmQuantile(s0: number, mu: number, sigma: number, T: number, z: number): number {
  return s0 * Math.exp((mu - (sigma * sigma) / 2) * T + sigma * Math.sqrt(T) * z);
}

// ── Monte Carlo ─────────────────────────────────────────────────────────────

export type HorizonDist = {
  days: number;
  p5: number;
  p25: number;
  p50: number;
  p75: number;
  p95: number;
  mean: number;
  probUp: number;
  probAboveFair: number | null;
  /** 95% VaR / CVaR of the horizon return, positive loss fractions. */
  var95: number;
  cvar95: number;
};

function summarize(s0: number, terminal: readonly number[], days: number, fair: number | null): HorizonDist {
  const sorted = [...terminal].sort((a, b) => a - b);
  const q = (p: number) => {
    const h = (sorted.length - 1) * p;
    const lo = Math.floor(h);
    return sorted[lo] + (h - lo) * ((sorted[Math.min(lo + 1, sorted.length - 1)] ?? sorted[lo]) - sorted[lo]);
  };
  const rets = sorted.map((v) => v / s0 - 1);
  const k = Math.max(1, Math.floor(rets.length * 0.05));
  const tail = rets.slice(0, k);
  return {
    days,
    p5: q(0.05), p25: q(0.25), p50: q(0.5), p75: q(0.75), p95: q(0.95),
    mean: mean(sorted),
    probUp: terminal.filter((v) => v > s0).length / terminal.length,
    probAboveFair: fair && fair > 0 ? terminal.filter((v) => v > fair).length / terminal.length : null,
    var95: Math.max(0, -q(0.05) / s0 + 1),
    cvar95: Math.max(0, -mean(tail)),
  };
}

export type GarchSimParams = { omega: number; alpha: number; beta: number };

/**
 * Simulate log-price paths whose variance follows GARCH(1,1), starting from
 * tomorrow's conditional variance. Per-step drift μ/252 − σ²ₜ/2 keeps
 * E[S_T] ≈ S₀·e^{μT}. Returns terminal prices at each requested horizon.
 */
export function simulateGarch(s0: number, g: GarchSimParams, sigma2Next: number, muAnnual: number, horizons: readonly number[], paths: number, rng: Rng): number[][] {
  const H = Math.max(...horizons);
  const gauss = normalSampler(rng);
  const out = horizons.map(() => new Array<number>(paths));
  const m = muAnnual / DAYS;
  for (let p = 0; p < paths; p++) {
    let s2 = sigma2Next, ls = 0, hi = 0;
    for (let d = 1; d <= H; d++) {
      const eps = Math.sqrt(s2) * gauss();
      ls += m - s2 / 2 + eps;
      s2 = g.omega + g.alpha * eps * eps + g.beta * s2;
      while (hi < horizons.length && horizons[hi] === d) { out[hi][p] = s0 * Math.exp(ls); hi++; }
    }
  }
  return out;
}

/**
 * Stationary block bootstrap (Politis-Romano, mean block length L) of
 * demeaned daily log returns, re-centred on the CAPM drift. Keeps fat tails
 * and short-range volatility clustering without assuming a distribution.
 */
export function simulateBootstrap(s0: number, logRets: readonly number[], muAnnual: number, horizons: readonly number[], paths: number, rng: Rng, meanBlock = 10): number[][] {
  const n = logRets.length;
  const H = Math.max(...horizons);
  const m = mean(logRets), v = variance(logRets);
  const shift = muAnnual / DAYS - v / 2 - m;
  const out = horizons.map(() => new Array<number>(paths));
  const pNew = 1 / meanBlock;
  for (let p = 0; p < paths; p++) {
    let idx = Math.floor(rng() * n), ls = 0, hi = 0;
    for (let d = 1; d <= H; d++) {
      if (d > 1) idx = rng() < pNew ? Math.floor(rng() * n) : (idx + 1) % n;
      ls += logRets[idx] + shift;
      while (hi < horizons.length && horizons[hi] === d) { out[hi][p] = s0 * Math.exp(ls); hi++; }
    }
  }
  return out;
}

export type MonteCarloReport = {
  s0: number;
  muAnnual: number;
  muSource: string;
  paths: number;
  seed: number;
  garch: HorizonDist[] | null;
  bootstrap: HorizonDist[];
  /** Closed-form GBM reference at the same drift and the sample volatility. */
  gbm: { sigma: number; horizons: { days: number; p5: number; p50: number; p95: number; probUp: number }[] };
};

export function monteCarloReport(i: {
  s0: number;
  logRets: readonly number[];
  muAnnual: number;
  muSource: string;
  garch?: (GarchSimParams & { sigma2Next: number }) | null;
  fairValue?: number | null;
  horizons?: number[];
  paths?: number;
  seed: number;
}): MonteCarloReport | null {
  if (!(i.s0 > 0) || i.logRets.length < 250) return null;
  const horizons = (i.horizons ?? [21, 63]).slice().sort((a, b) => a - b);
  const paths = i.paths ?? 5000;
  const fair = i.fairValue ?? null;
  const g = i.garch;
  const garch = g && g.alpha + g.beta < 1
    ? simulateGarch(i.s0, g, g.sigma2Next, i.muAnnual, horizons, paths, mulberry32(i.seed)).map((t, k) => summarize(i.s0, t, horizons[k], fair))
    : null;
  const boot = simulateBootstrap(i.s0, i.logRets, i.muAnnual, horizons, paths, mulberry32(i.seed + 1)).map((t, k) => summarize(i.s0, t, horizons[k], fair));
  const sigma = std(i.logRets) * Math.sqrt(DAYS);
  return {
    s0: i.s0, muAnnual: i.muAnnual, muSource: i.muSource, paths, seed: i.seed,
    garch, bootstrap: boot,
    gbm: {
      sigma,
      horizons: horizons.map((d) => {
        const T = d / DAYS;
        return { days: d, p5: gbmQuantile(i.s0, i.muAnnual, sigma, T, -1.6448536), p50: gbmQuantile(i.s0, i.muAnnual, sigma, T, 0), p95: gbmQuantile(i.s0, i.muAnnual, sigma, T, 1.6448536), probUp: gbmProbAbove(i.s0, i.s0, i.muAnnual, sigma, T) };
      }),
    },
  };
}

// ── Merton jump diffusion ───────────────────────────────────────────────────

/** Daily-unit parameters: r = m + σZ + Σᵢ Yᵢ, N ~ Poisson(λ), Yᵢ ~ N(μJ, σJ²). */
export type MertonParams = { m: number; sigma: number; lambda: number; muJ: number; sigmaJ: number };

export function mertonDensity(r: number, p: MertonParams, maxJumps = 10): number {
  let f = 0;
  let logPois = -p.lambda; // log P(N = 0)
  for (let n = 0; n <= maxJumps; n++) {
    if (n > 0) logPois += Math.log(p.lambda) - Math.log(n);
    const v = p.sigma * p.sigma + n * p.sigmaJ * p.sigmaJ;
    const z = r - p.m - n * p.muJ;
    f += Math.exp(logPois - 0.5 * Math.log(2 * Math.PI * v) - (z * z) / (2 * v));
  }
  return f;
}

export type MertonReport = {
  params: MertonParams;
  /** Jumps per year, mean jump (log), jump vol. */
  jumpsPerYear: number;
  meanJumpPct: number;
  jumpVolPct: number;
  diffusionVolAnnual: number;
  totalVolAnnual: number;
  /** λ(μJ² + σJ²) / total variance. */
  jumpShareOfVariance: number;
  logLikJump: number;
  logLikGauss: number;
  /** LR = 2(ℓ_jump − ℓ_gauss) vs χ²(3). Approximate: λ = 0 sits on the boundary. */
  lrStat: number;
  lrP: number;
  jumpsSignificant: boolean;
  /** P(≥ 10% fall over 21 days), jump model vs a Gaussian with the same variance, both drift-neutral. */
  probDrop10pct21d: { jump: number; gaussian: number };
};

/**
 * Jumps are rare, outsized moves: σJ ≥ 3σ and at most one every five days.
 * Left free, the MLE runs to λ ≈ 0.5/day with σJ ≈ σ on real stocks, a
 * mixture of two normals that soaks up volatility clustering and says
 * nothing about gaps (λ and σJ sit on a ridge of near-equal likelihood).
 */
const MERTON_MAX_LAMBDA = 0.2;
const MERTON_MIN_JUMP_RATIO = 3;

export function fitMerton(logRets: readonly number[]): MertonReport | null {
  const n = logRets.length;
  if (n < 250) return null;
  const m0 = mean(logRets), sd = std(logRets);
  const big = logRets.filter((r) => Math.abs(r - m0) > 3 * sd);
  const lam0 = clamp(big.length / n, 0.005, MERTON_MAX_LAMBDA * 0.8);
  const sj0 = Math.max(big.length >= 3 ? std(big) : 3 * sd, 1.2 * MERTON_MIN_JUMP_RATIO * 0.8 * sd);
  const unpack = (x: number[]): MertonParams => ({ m: x[0], sigma: Math.exp(x[1]), lambda: Math.exp(x[2]), muJ: x[3], sigmaJ: Math.exp(x[4]) });
  const nll = (x: number[]) => {
    const p = unpack(x);
    if (p.lambda > MERTON_MAX_LAMBDA || p.lambda < 1e-5 || p.sigmaJ < MERTON_MIN_JUMP_RATIO * p.sigma) return Infinity;
    let ll = 0;
    for (const r of logRets) ll += Math.log(Math.max(mertonDensity(r, p), 1e-300));
    return -ll;
  };
  const x0 = [m0, Math.log(sd * 0.8), Math.log(lam0), 0, Math.log(sj0)];
  let best = nelderMead(nll, x0, { step: [sd * 0.2, 0.3, 0.7, sd, 0.4], maxIter: 2500 });
  // One restart from the optimum shakes Nelder-Mead out of a flat corner.
  const again = nelderMead(nll, best.x, { step: [sd * 0.1, 0.15, 0.4, sd * 0.5, 0.2], maxIter: 1500 });
  if (again.fx < best.fx) best = again;
  if (!Number.isFinite(best.fx)) return null;
  const p = unpack(best.x);
  const vGauss = variance(logRets, 0);
  let llG = 0;
  for (const r of logRets) llG += -0.5 * Math.log(2 * Math.PI * vGauss) - ((r - m0) ** 2) / (2 * vGauss);
  const llJ = -best.fx;
  const lr = Math.max(0, 2 * (llJ - llG));
  const jumpVar = p.lambda * (p.muJ * p.muJ + p.sigmaJ * p.sigmaJ);
  const totVar = p.sigma * p.sigma + jumpVar;
  // 21-day fall probability (jump count ~ Poisson(21λ)), drift-neutral so the
  // comparison isolates tail shape: both models get a zero mean log return.
  const h = 21, L = p.lambda * h;
  const drift = p.m + p.lambda * p.muJ;
  let probJ = 0, logPois = -L;
  for (let k = 0; k <= 40; k++) {
    if (k > 0) logPois += Math.log(L) - Math.log(k);
    const mu = h * (p.m - drift) + k * p.muJ, v = h * p.sigma * p.sigma + k * p.sigmaJ * p.sigmaJ;
    probJ += Math.exp(logPois) * normCdf((Math.log(0.9) - mu) / Math.sqrt(v));
  }
  const probG = normCdf(Math.log(0.9) / Math.sqrt(h * totVar));
  return {
    params: p,
    jumpsPerYear: p.lambda * DAYS,
    meanJumpPct: (Math.exp(p.muJ) - 1) * 100,
    jumpVolPct: p.sigmaJ * 100,
    diffusionVolAnnual: p.sigma * Math.sqrt(DAYS),
    totalVolAnnual: Math.sqrt(totVar * DAYS),
    jumpShareOfVariance: totVar > 0 ? jumpVar / totVar : 0,
    logLikJump: llJ,
    logLikGauss: llG,
    lrStat: lr,
    lrP: 1 - chiSquareCdf(lr, 3),
    jumpsSignificant: 1 - chiSquareCdf(lr, 3) < 0.01,
    probDrop10pct21d: { jump: probJ, gaussian: probG },
  };
}

/** Simulate jump-diffusion daily log returns (for tests and stress paths). */
export function simulateMerton(p: MertonParams, n: number, rng: Rng): number[] {
  const gauss = normalSampler(rng);
  const out: number[] = [];
  for (let t = 0; t < n; t++) {
    let r = p.m + p.sigma * gauss();
    const k = poissonSample(rng, p.lambda, gauss);
    for (let j = 0; j < k; j++) r += p.muJ + p.sigmaJ * gauss();
    out.push(r);
  }
  return out;
}

// ── Ornstein-Uhlenbeck: dX = θ(μ − X)dt + σdW ──────────────────────────────

export type OuFit = {
  /** Annualized mean-reversion speed. */
  theta: number;
  mu: number;
  /** Annualized diffusion σ. */
  sigma: number;
  halfLifeDays: number;
  /** Stationary standard deviation σ/√(2θ). */
  stationarySd: number;
  b: number;
};

/** Exact discretization: X_{t+1} = a + bXₜ + ε ⇒ θ = −ln b/Δt, μ = a/(1−b), σ = sd(ε)·√(2θ/(1−b²)). */
export function fitOu(x: readonly number[], dt = 1 / DAYS): OuFit | null {
  if (x.length < 30) return null;
  const r = ols(x.slice(1), x.slice(0, -1).map((v) => [v]));
  if (!r) return null;
  const [a, b] = r.coef;
  if (!(b > 0 && b < 1)) return null;
  const theta = -Math.log(b) / dt;
  const sdE = Math.sqrt(r.sigma2);
  const sigma = sdE * Math.sqrt((2 * theta) / (1 - b * b));
  return { theta, mu: a / (1 - b), sigma, halfLifeDays: Math.LN2 / theta / dt, stationarySd: sigma / Math.sqrt(2 * theta), b };
}

export type OuSeriesReport = {
  series: string;
  adf: AdfResult | null;
  meanReverting: boolean;
  fit: OuFit | null;
  /** (X_T − μ) / stationary sd: positive = stretched above its mean. */
  zNow: number | null;
  /** E[X_{T+21}] − X_T = (μ − X_T)(1 − e^{−θ·21/252}). In log units for log series. */
  expectedMove21d: number | null;
};

/**
 * The mean-reversion gate needs ADF at 1%, not 5%: the desk tests two series
 * per ticker across the whole universe, so 5% would flag about one random
 * walk in twenty as tradeable.
 */
export function ouSeriesReport(series: string, x: readonly number[]): OuSeriesReport {
  const a = adf(x);
  const fit = fitOu(x);
  const meanReverting = !!a && a.pBucket === "<1%" && !!fit && fit.halfLifeDays < 126;
  const last = x[x.length - 1];
  return {
    series,
    adf: a,
    meanReverting,
    fit,
    zNow: fit && fit.stationarySd > 0 ? (last - fit.mu) / fit.stationarySd : null,
    expectedMove21d: fit ? (fit.mu - last) * (1 - Math.exp((-fit.theta * 21) / DAYS)) : null,
  };
}

/**
 * Cumulative market-model residual: Σ(rₛ − α − β·rₘ). The level is
 * descriptive (β uses the whole window); the trading read is whether it
 * mean-reverts and how stretched it is now.
 */
export function residualLevel(stock: readonly number[], market: readonly number[]): { level: number[]; beta: number } | null {
  const n = Math.min(stock.length, market.length);
  if (n < 120) return null;
  const s = stock.slice(-n), m = market.slice(-n);
  const r = ols(s, m.map((v) => [v]));
  if (!r) return null;
  let acc = 0;
  return { level: r.resid.map((e) => (acc += e)), beta: r.coef[1] };
}

// ── Black-Scholes and implied volatility ────────────────────────────────────

export type OptionType = "call" | "put";

export function bsPrice(type: OptionType, S: number, K: number, T: number, r: number, sigma: number, q = 0): number {
  if (T <= 0 || sigma <= 0) return Math.max(0, type === "call" ? S - K : K - S);
  const sq = sigma * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + (sigma * sigma) / 2) * T) / sq;
  const d2 = d1 - sq;
  const dq = Math.exp(-q * T), dr = Math.exp(-r * T);
  return type === "call" ? S * dq * normCdf(d1) - K * dr * normCdf(d2) : K * dr * normCdf(-d2) - S * dq * normCdf(-d1);
}

export type Greeks = { delta: number; gamma: number; vega: number; theta: number; rho: number };

/** Vega per 1.00 of vol, theta per year. */
export function bsGreeks(type: OptionType, S: number, K: number, T: number, r: number, sigma: number, q = 0): Greeks {
  const sqT = Math.sqrt(T), sq = sigma * sqT;
  const d1 = (Math.log(S / K) + (r - q + (sigma * sigma) / 2) * T) / sq;
  const d2 = d1 - sq;
  const dq = Math.exp(-q * T), dr = Math.exp(-r * T);
  const pdf = normPdf(d1);
  const gamma = (dq * pdf) / (S * sq);
  const vega = S * dq * pdf * sqT;
  if (type === "call") {
    return { delta: dq * normCdf(d1), gamma, vega, theta: (-S * dq * pdf * sigma) / (2 * sqT) - r * K * dr * normCdf(d2) + q * S * dq * normCdf(d1), rho: K * T * dr * normCdf(d2) };
  }
  return { delta: dq * (normCdf(d1) - 1), gamma, vega, theta: (-S * dq * pdf * sigma) / (2 * sqT) + r * K * dr * normCdf(-d2) - q * S * dq * normCdf(-d1), rho: -K * T * dr * normCdf(-d2) };
}

/** Newton-Raphson from the Brenner-Subrahmanyam guess, falling back to bisection. Null outside no-arbitrage bounds. */
export function impliedVol(price: number, type: OptionType, S: number, K: number, T: number, r: number, q = 0): number | null {
  if (!(price > 0 && S > 0 && K > 0 && T > 0)) return null;
  const dq = Math.exp(-q * T), dr = Math.exp(-r * T);
  const lower = type === "call" ? Math.max(0, S * dq - K * dr) : Math.max(0, K * dr - S * dq);
  const upper = type === "call" ? S * dq : K * dr;
  if (price <= lower + 1e-12 || price >= upper) return null;
  let s = clamp(Math.sqrt((2 * Math.PI) / T) * (price / S), 0.05, 2);
  for (let i = 0; i < 50; i++) {
    const diff = bsPrice(type, S, K, T, r, s, q) - price;
    if (Math.abs(diff) < 1e-10 * Math.max(1, price)) return s;
    const v = bsGreeks(type, S, K, T, r, s, q).vega;
    if (v < 1e-10) break;
    const next = s - diff / v;
    if (!(next > 1e-4 && next < 5)) break;
    s = next;
  }
  let lo = 1e-4, hi = 5;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (bsPrice(type, S, K, T, r, mid, q) > price) hi = mid; else lo = mid;
    if (hi - lo < 1e-9) break;
  }
  return (lo + hi) / 2;
}

// ── Options-implied volatility summary ──────────────────────────────────────

export type OptionQuote = {
  expiry: string;
  type: OptionType;
  strike: number;
  bid: number;
  ask: number;
  /** Vendor IV (decimal), if supplied. */
  iv?: number | null;
  delta?: number | null;
  openInterest?: number | null;
  volume?: number | null;
};

/** OCC symbol: ROOT + YYMMDD + C|P + strike × 1000 (8 digits), e.g. AAPL261120C00150000. */
export function parseOccSymbol(sym: string): { root: string; expiry: string; type: OptionType; strike: number } | null {
  const m = /^([A-Z.]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(sym.trim());
  if (!m) return null;
  return { root: m[1], expiry: `20${m[2]}-${m[3]}-${m[4]}`, type: m[5] === "C" ? "call" : "put", strike: Number(m[6]) / 1000 };
}

export type IvSummary = {
  spot: number;
  /** 30-calendar-day ATM IV, interpolated in total variance. */
  iv30: number | null;
  atmNear: { expiry: string; dte: number; iv: number } | null;
  atmFar: { expiry: string; dte: number; iv: number } | null;
  /** Far − near ATM IV: negative (inverted) when the market prices near-term stress. */
  termSlope: number | null;
  /** IV of the ~25Δ put minus the ~25Δ call near 30 days: positive = downside protection bid. */
  skew25d: number | null;
  putCallOiRatio: number | null;
  putCallVolumeRatio: number | null;
  /** ± one-sigma move over 21 trading days implied by iv30, in price and %. */
  expectedMove21d: { price: number; pct: number } | null;
  expiriesUsed: number;
};

const DAY_MS = 86_400_000;

function quoteIv(o: OptionQuote, S: number, T: number, r: number, q: number): number | null {
  if (o.iv != null && o.iv > 0.01 && o.iv < 5) return o.iv;
  if (!(o.bid > 0 && o.ask >= o.bid)) return null;
  return impliedVol((o.bid + o.ask) / 2, o.type, S, o.strike, T, r, q);
}

export function impliedVolSummary(quotes: readonly OptionQuote[], spot: number, asOf: Date, r: number, q = 0): IvSummary {
  const byExp = new Map<string, OptionQuote[]>();
  for (const o of quotes) {
    if (!(o.strike > 0)) continue;
    const arr = byExp.get(o.expiry) ?? [];
    arr.push(o);
    byExp.set(o.expiry, arr);
  }
  type Row = { expiry: string; dte: number; T: number; atm: number; quotes: OptionQuote[] };
  const rows: Row[] = [];
  for (const [expiry, qs] of byExp) {
    const dte = Math.round((Date.parse(`${expiry}T20:00:00Z`) - asOf.getTime()) / DAY_MS);
    if (dte < 7 || dte > 120) continue;
    const T = dte / 365;
    const strikes = [...new Set(qs.map((o) => o.strike))].sort((a, b) => Math.abs(a - spot) - Math.abs(b - spot));
    let atm: number | null = null;
    for (const k of strikes.slice(0, 3)) {
      const ivs = qs.filter((o) => o.strike === k).map((o) => quoteIv(o, spot, T, r, q)).filter((v): v is number => v != null);
      if (ivs.length) { atm = mean(ivs); break; }
    }
    if (atm != null) rows.push({ expiry, dte, T, atm, quotes: qs });
  }
  rows.sort((a, b) => a.dte - b.dte);
  const empty: IvSummary = { spot, iv30: null, atmNear: null, atmFar: null, termSlope: null, skew25d: null, putCallOiRatio: null, putCallVolumeRatio: null, expectedMove21d: null, expiriesUsed: 0 };
  if (!rows.length) return empty;

  // Total-variance interpolation to 30 days.
  const target = 30 / 365;
  let iv30: number;
  const after = rows.findIndex((x) => x.T >= target);
  if (after <= 0) {
    const x = rows[after === 0 ? 0 : rows.length - 1];
    iv30 = x.atm;
  } else {
    const a = rows[after - 1], b = rows[after];
    const wa = a.atm * a.atm * a.T, wb = b.atm * b.atm * b.T;
    const w = wa + ((wb - wa) * (target - a.T)) / (b.T - a.T);
    iv30 = Math.sqrt(Math.max(w, 0) / target);
  }

  // 25-delta skew on the expiry nearest 30 days.
  const near30 = rows.reduce((best, x) => (Math.abs(x.dte - 30) < Math.abs(best.dte - 30) ? x : best), rows[0]);
  const withDelta = near30.quotes
    .map((o) => {
      const iv = quoteIv(o, spot, near30.T, r, q);
      if (iv == null) return null;
      const d = o.delta ?? bsGreeks(o.type, spot, o.strike, near30.T, r, iv, q).delta;
      return { o, iv, d };
    })
    .filter((x): x is { o: OptionQuote; iv: number; d: number } => x != null);
  const pick = (type: OptionType, want: number) => {
    const c = withDelta.filter((x) => x.o.type === type && Math.abs(x.d - want) < 0.15);
    return c.length ? c.reduce((b, x) => (Math.abs(x.d - want) < Math.abs(b.d - want) ? x : b)).iv : null;
  };
  const p25 = pick("put", -0.25), c25 = pick("call", 0.25);

  const sumBy = (type: OptionType, f: (o: OptionQuote) => number | null | undefined) =>
    quotes.filter((o) => o.type === type).reduce((s, o) => s + (f(o) ?? 0), 0);
  const oiC = sumBy("call", (o) => o.openInterest), oiP = sumBy("put", (o) => o.openInterest);
  const vC = sumBy("call", (o) => o.volume), vP = sumBy("put", (o) => o.volume);
  const near = rows[0], far = rows[rows.length - 1];
  const move = spot * iv30 * Math.sqrt(21 / 252);
  return {
    spot,
    iv30,
    atmNear: { expiry: near.expiry, dte: near.dte, iv: near.atm },
    atmFar: rows.length > 1 ? { expiry: far.expiry, dte: far.dte, iv: far.atm } : null,
    termSlope: rows.length > 1 ? far.atm - near.atm : null,
    skew25d: p25 != null && c25 != null ? p25 - c25 : null,
    putCallOiRatio: oiC > 0 ? oiP / oiC : null,
    putCallVolumeRatio: vC > 0 ? vP / vC : null,
    expectedMove21d: { price: move, pct: iv30 * Math.sqrt(21 / 252) * 100 },
    expiriesUsed: rows.length,
  };
}

/**
 * Variance risk premium read: implied minus forecast realized vol. Implied
 * usually exceeds realized (insurance premium); a negative gap means the
 * options market is calmer than the GARCH forecast.
 */
export function volRiskPremium(impliedAnnual: number, forecastAnnual: number) {
  return { gap: impliedAnnual - forecastAnnual, ratio: forecastAnnual > 0 ? impliedAnnual / forecastAnnual : null };
}

/**
 * Single-stock implied-vol proxy from an index IV (India VIX) when no
 * single-stock chain is available: √(β²·IV²_index + σ²_idio). Labelled a proxy.
 */
export function impliedVolProxy(indexIv: number, beta: number, idioVolAnnual: number): number {
  return Math.sqrt(beta * beta * indexIv * indexIv + idioVolAnnual * idioVolAnnual);
}

