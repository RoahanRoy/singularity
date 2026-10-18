/**
 * Core numerics for the MERIDIAN quant agents — pure TypeScript, no I/O, no
 * dependencies, deterministic (every random draw comes from a seeded RNG).
 *
 * Everything in src/lib/quant/ is framework-free so the agent scripts (tsx) and
 * the Next.js app can share it, and so it can be unit-tested against synthetic
 * data with known answers (see *.test.ts next to each module).
 */

export type Vec = number[];
export type Mat = number[][];

export const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

export function sum(xs: readonly number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s;
}

export function mean(xs: readonly number[]): number {
  return xs.length ? sum(xs) / xs.length : NaN;
}

export function variance(xs: readonly number[], ddof = 1): number {
  const n = xs.length;
  if (n - ddof <= 0) return NaN;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return s / (n - ddof);
}

export function std(xs: readonly number[], ddof = 1): number {
  return Math.sqrt(variance(xs, ddof));
}

export function covariance(a: readonly number[], b: readonly number[], ddof = 1): number {
  const n = Math.min(a.length, b.length);
  if (n - ddof <= 0) return NaN;
  const ma = mean(a.slice(0, n));
  const mb = mean(b.slice(0, n));
  let s = 0;
  for (let i = 0; i < n; i++) s += (a[i] - ma) * (b[i] - mb);
  return s / (n - ddof);
}

export function correlation(a: readonly number[], b: readonly number[]): number {
  const c = covariance(a, b);
  const d = std(a.slice(0, b.length)) * std(b.slice(0, a.length));
  return d > 0 ? c / d : NaN;
}

/** Sample skewness from population moments (m3 / m2^1.5). */
export function skewness(xs: readonly number[]): number {
  const n = xs.length;
  if (n < 3) return NaN;
  const m = mean(xs);
  let m2 = 0, m3 = 0;
  for (const x of xs) { const d = x - m; m2 += d * d; m3 += d * d * d; }
  m2 /= n; m3 /= n;
  return m2 > 0 ? m3 / Math.pow(m2, 1.5) : 0;
}

/** Excess kurtosis from population moments (m4 / m2² − 3). */
export function excessKurtosis(xs: readonly number[]): number {
  const n = xs.length;
  if (n < 4) return NaN;
  const m = mean(xs);
  let m2 = 0, m4 = 0;
  for (const x of xs) { const d = x - m; const d2 = d * d; m2 += d2; m4 += d2 * d2; }
  m2 /= n; m4 /= n;
  return m2 > 0 ? m4 / (m2 * m2) - 3 : 0;
}

/** Quantile with linear interpolation between order statistics (R type 7). */
export function quantile(xs: readonly number[], q: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return quantileSorted(s, q);
}

export function quantileSorted(sorted: readonly number[], q: number): number {
  const n = sorted.length;
  if (!n) return NaN;
  const h = (n - 1) * clamp(q, 0, 1);
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

export function median(xs: readonly number[]): number {
  return quantile(xs, 0.5);
}

/** Ranks 1..n with ties sharing their average rank. */
export function rank(xs: readonly number[]): number[] {
  const idx = xs.map((_, i) => i).sort((a, b) => xs[a] - xs[b]);
  const r = new Array<number>(xs.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && xs[idx[j + 1]] === xs[idx[i]]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k]] = avg;
    i = j + 1;
  }
  return r;
}

/** Spearman rank correlation — the "information coefficient" of a forecast. */
export function spearman(a: readonly number[], b: readonly number[]): number {
  return correlation(rank(a), rank(b));
}

/** Percentile rank of `x` within `xs` (0..1, ties count half). */
export function percentileOf(xs: readonly number[], x: number): number {
  if (!xs.length) return NaN;
  let below = 0, equal = 0;
  for (const v of xs) { if (v < x) below++; else if (v === x) equal++; }
  return (below + 0.5 * equal) / xs.length;
}

export function diff(xs: readonly number[], lag = 1): number[] {
  const out: number[] = [];
  for (let i = lag; i < xs.length; i++) out.push(xs[i] - xs[i - lag]);
  return out;
}

export function logReturns(prices: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < prices.length; i++) out.push(Math.log(prices[i] / prices[i - 1]));
  return out;
}

export function simpleReturns(prices: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < prices.length; i++) out.push(prices[i] / prices[i - 1] - 1);
  return out;
}

export function standardize(xs: readonly number[]): { z: number[]; mean: number; sd: number } {
  const m = mean(xs);
  const sd = std(xs);
  return { z: xs.map((x) => (sd > 0 ? (x - m) / sd : 0)), mean: m, sd };
}

export function linspace(a: number, b: number, n: number): number[] {
  if (n <= 1) return [a];
  return Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1));
}

/** Round for display/persistence; leaves non-finite values as null. */
export function rnd(x: number | null | undefined, dp = 4): number | null {
  if (x == null || !Number.isFinite(x)) return null;
  const f = Math.pow(10, dp);
  return Math.round(x * f) / f;
}

// ── Linear algebra ──────────────────────────────────────────────────────────

export function zeros(r: number, c: number): Mat {
  return Array.from({ length: r }, () => new Array<number>(c).fill(0));
}

export function identity(n: number): Mat {
  const m = zeros(n, n);
  for (let i = 0; i < n; i++) m[i][i] = 1;
  return m;
}

export function transpose(a: Mat): Mat {
  if (!a.length) return [];
  const r = a.length, c = a[0].length;
  const t = zeros(c, r);
  for (let i = 0; i < r; i++) for (let j = 0; j < c; j++) t[j][i] = a[i][j];
  return t;
}

export function matMul(a: Mat, b: Mat): Mat {
  const n = a.length, m = b[0]?.length ?? 0, k = b.length;
  const out = zeros(n, m);
  for (let i = 0; i < n; i++) {
    const ai = a[i], oi = out[i];
    for (let p = 0; p < k; p++) {
      const v = ai[p];
      if (v === 0) continue;
      const bp = b[p];
      for (let j = 0; j < m; j++) oi[j] += v * bp[j];
    }
  }
  return out;
}

export function matVec(a: Mat, x: readonly number[]): number[] {
  return a.map((row) => {
    let s = 0;
    for (let j = 0; j < row.length; j++) s += row[j] * x[j];
    return s;
  });
}

export function dot(a: readonly number[], b: readonly number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** Gauss-Jordan inverse with partial pivoting; null when (numerically) singular. */
export function inverse(a: Mat): Mat | null {
  const n = a.length;
  let scale = 0;
  for (const row of a) for (const v of row) scale = Math.max(scale, Math.abs(v));
  if (!(scale > 0)) return null;
  const m = a.map((row, i) => {
    const ext = new Array<number>(2 * n).fill(0);
    for (let j = 0; j < n; j++) ext[j] = row[j];
    ext[n + i] = 1;
    return ext;
  });
  for (let col = 0; col < n; col++) {
    let piv = col;
    let best = Math.abs(m[col][col]);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(m[r][col]);
      if (v > best) { best = v; piv = r; }
    }
    if (best <= 1e-13 * scale) return null;
    if (piv !== col) { const tmp = m[col]; m[col] = m[piv]; m[piv] = tmp; }
    const pr = m[col];
    const pv = pr[col];
    for (let j = 0; j < 2 * n; j++) pr[j] /= pv;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r][col];
      if (f === 0) continue;
      const rr = m[r];
      for (let j = 0; j < 2 * n; j++) rr[j] -= f * pr[j];
    }
  }
  return m.map((row) => row.slice(n));
}

export function solve(a: Mat, b: readonly number[]): number[] | null {
  const inv = inverse(a);
  return inv ? matVec(inv, b) : null;
}

// ── Regression ──────────────────────────────────────────────────────────────

export type OlsResult = {
  coef: number[];
  se: number[];
  t: number[];
  p: number[];
  names: string[];
  r2: number;
  adjR2: number;
  resid: number[];
  fitted: number[];
  sigma2: number;
  n: number;
  k: number;
  /** "classical" or "newey-west(L)" — which covariance produced se/t/p. */
  covType: string;
};

/**
 * Ordinary least squares with optional Newey-West (HAC) standard errors.
 * `X` is row-major (one row per observation). With `intercept` (default) a
 * constant column is prepended and reported first as "const".
 */
export function ols(
  y: readonly number[],
  X: readonly (readonly number[])[],
  opts: { intercept?: boolean; neweyWestLags?: number; names?: string[] } = {},
): OlsResult | null {
  const intercept = opts.intercept ?? true;
  const n = y.length;
  if (!n || X.length !== n) return null;
  const rows: Mat = X.map((r) => (intercept ? [1, ...r] : [...r]));
  const k = rows[0].length;
  if (n <= k) return null;
  const names = [...(intercept ? ["const"] : []), ...(opts.names ?? Array.from({ length: k - (intercept ? 1 : 0) }, (_, i) => `x${i + 1}`))];

  const xtx = zeros(k, k);
  const xty = new Array<number>(k).fill(0);
  for (let t = 0; t < n; t++) {
    const r = rows[t];
    for (let i = 0; i < k; i++) {
      xty[i] += r[i] * y[t];
      for (let j = i; j < k; j++) xtx[i][j] += r[i] * r[j];
    }
  }
  for (let i = 0; i < k; i++) for (let j = 0; j < i; j++) xtx[i][j] = xtx[j][i];
  const inv = inverse(xtx);
  if (!inv) return null;
  const coef = matVec(inv, xty);
  const fitted = rows.map((r) => dot(r, coef));
  const resid = y.map((v, t) => v - fitted[t]);
  const sse = sum(resid.map((e) => e * e));
  const sigma2 = sse / (n - k);
  const yBar = intercept ? mean(y) : 0;
  const sst = sum(y.map((v) => (v - yBar) * (v - yBar)));
  const r2 = sst > 0 ? 1 - sse / sst : 0;
  const adjR2 = 1 - (1 - r2) * ((n - (intercept ? 1 : 0)) / (n - k));

  let cov: Mat;
  let covType = "classical";
  const L = opts.neweyWestLags ?? 0;
  if (L > 0) {
    // S = Σ e²xx' + Σ_l w_l Σ_t e_t e_{t-l}(x_t x_{t-l}' + x_{t-l} x_t'), Bartlett weights.
    const S = zeros(k, k);
    for (let t = 0; t < n; t++) {
      const e2 = resid[t] * resid[t];
      const r = rows[t];
      for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) S[i][j] += e2 * r[i] * r[j];
    }
    for (let l = 1; l <= L; l++) {
      const w = 1 - l / (L + 1);
      for (let t = l; t < n; t++) {
        const ee = resid[t] * resid[t - l] * w;
        const a = rows[t], b = rows[t - l];
        for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) S[i][j] += ee * (a[i] * b[j] + b[i] * a[j]);
      }
    }
    const corr = n / (n - k);
    cov = matMul(matMul(inv, S), inv).map((row) => row.map((v) => v * corr));
    covType = `newey-west(${L})`;
  } else {
    cov = inv.map((row) => row.map((v) => v * sigma2));
  }
  const se = coef.map((_, i) => Math.sqrt(Math.max(cov[i][i], 0)));
  const t = coef.map((c, i) => (se[i] > 0 ? c / se[i] : 0));
  const p = t.map((tv) => tTwoSidedP(tv, n - k));
  return { coef, se, t, p, names, r2, adjR2, resid, fitted, sigma2, n, k, covType };
}

/** Column means / standard deviations (ddof 0) for feature standardization. */
export function columnStats(X: readonly (readonly number[])[]): { mean: number[]; sd: number[] } {
  const k = X[0]?.length ?? 0;
  const n = X.length;
  const m = new Array<number>(k).fill(0);
  const s = new Array<number>(k).fill(0);
  for (const r of X) for (let j = 0; j < k; j++) m[j] += r[j];
  for (let j = 0; j < k; j++) m[j] /= n || 1;
  for (const r of X) for (let j = 0; j < k; j++) s[j] += (r[j] - m[j]) ** 2;
  for (let j = 0; j < k; j++) s[j] = Math.sqrt(s[j] / (n || 1));
  return { mean: m, sd: s };
}

export type LinearModel = { intercept: number; coef: number[]; predict: (row: readonly number[]) => number };

function linearModel(intercept: number, coef: number[]): LinearModel {
  return { intercept, coef, predict: (row) => intercept + dot(row, coef) };
}

/** Ridge regression on standardized features; the intercept is not penalized. */
export function ridge(y: readonly number[], X: readonly (readonly number[])[], lambda: number): LinearModel | null {
  const n = y.length;
  if (!n) return null;
  const { mean: mu, sd } = columnStats(X);
  const k = mu.length;
  const yBar = mean(y);
  const Z = X.map((r) => r.map((v, j) => (sd[j] > 0 ? (v - mu[j]) / sd[j] : 0)));
  const a = zeros(k, k);
  const b = new Array<number>(k).fill(0);
  for (let t = 0; t < n; t++) {
    const r = Z[t];
    for (let i = 0; i < k; i++) {
      b[i] += r[i] * (y[t] - yBar);
      for (let j = 0; j < k; j++) a[i][j] += r[i] * r[j];
    }
  }
  for (let i = 0; i < k; i++) a[i][i] += lambda * n;
  const beta = solve(a, b);
  if (!beta) return null;
  const coef = beta.map((bj, j) => (sd[j] > 0 ? bj / sd[j] : 0));
  return linearModel(yBar - dot(coef, mu), coef);
}

/**
 * Lasso by cyclic coordinate descent on standardized features, minimizing
 * (1/2n)‖y − Xβ‖² + λ‖β‖₁. Coefficients that shrink to exactly 0 are the
 * features the model discarded — reported so the agent can say which.
 */
export function lasso(
  y: readonly number[],
  X: readonly (readonly number[])[],
  lambda: number,
  opts: { maxIter?: number; tol?: number } = {},
): LinearModel | null {
  const n = y.length;
  if (!n) return null;
  const { mean: mu, sd } = columnStats(X);
  const k = mu.length;
  const yBar = mean(y);
  const Z = X.map((r) => r.map((v, j) => (sd[j] > 0 ? (v - mu[j]) / sd[j] : 0)));
  const yc = y.map((v) => v - yBar);
  const beta = new Array<number>(k).fill(0);
  const resid = yc.slice();
  const maxIter = opts.maxIter ?? 1000;
  const tol = opts.tol ?? 1e-8;
  for (let it = 0; it < maxIter; it++) {
    let maxDelta = 0;
    for (let j = 0; j < k; j++) {
      if (!(sd[j] > 0)) continue;
      let rho = 0;
      for (let t = 0; t < n; t++) rho += Z[t][j] * (resid[t] + Z[t][j] * beta[j]);
      rho /= n;
      const next = Math.sign(rho) * Math.max(Math.abs(rho) - lambda, 0);
      const delta = next - beta[j];
      if (delta !== 0) {
        for (let t = 0; t < n; t++) resid[t] -= Z[t][j] * delta;
        beta[j] = next;
        maxDelta = Math.max(maxDelta, Math.abs(delta));
      }
    }
    if (maxDelta < tol) break;
  }
  const coef = beta.map((bj, j) => (sd[j] > 0 ? bj / sd[j] : 0));
  return linearModel(yBar - dot(coef, mu), coef);
}

// ── Special functions & distributions ───────────────────────────────────────

const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
  1.5056327351493116e-7,
];

export function logGamma(x: number): number {
  if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - logGamma(1 - x);
  const z = x - 1;
  let a = LANCZOS[0];
  const t = z + 7.5;
  for (let i = 1; i < 9; i++) a += LANCZOS[i] / (z + i);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

function betacf(a: number, b: number, x: number): number {
  const FPMIN = 1e-300;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 3e-14) break;
  }
  return h;
}

/** Regularized incomplete beta I_x(a, b). */
export function incompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}

export function studentTCdf(t: number, df: number): number {
  if (!Number.isFinite(t)) return t > 0 ? 1 : 0;
  const tail = 0.5 * incompleteBeta(df / (df + t * t), df / 2, 0.5);
  return t >= 0 ? 1 - tail : tail;
}

/** Two-sided p-value of a t statistic. */
export function tTwoSidedP(t: number, df: number): number {
  if (!Number.isFinite(t)) return 0;
  if (df <= 0) return NaN;
  return incompleteBeta(df / (df + t * t), df / 2, 0.5);
}

/** Regularized lower incomplete gamma P(a, x). */
export function gammaP(a: number, x: number): number {
  if (x <= 0) return 0;
  const lg = logGamma(a);
  if (x < a + 1) {
    let ap = a, s = 1 / a, del = s;
    for (let i = 0; i < 1000; i++) {
      ap += 1; del *= x / ap; s += del;
      if (Math.abs(del) < Math.abs(s) * 1e-15) break;
    }
    return s * Math.exp(-x + a * Math.log(x) - lg);
  }
  const FPMIN = 1e-300;
  let b = x + 1 - a, c = 1 / FPMIN, d = 1 / b, h = d;
  for (let i = 1; i < 1000; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = b + an / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return 1 - Math.exp(-x + a * Math.log(x) - lg) * h;
}

export function chiSquareCdf(x: number, k: number): number {
  return gammaP(k / 2, x / 2);
}

export function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/** Complementary error function (Numerical Recipes erfcc, rel. error < 1.2e-7). */
export function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const ans = t * Math.exp(
    -z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 +
    t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 +
    t * (-0.82215223 + t * 0.17087277)))))))),
  );
  return x >= 0 ? ans : 2 - ans;
}

export function normCdf(x: number): number {
  return 0.5 * erfc(-x / Math.SQRT2);
}

/** Inverse standard-normal CDF (Acklam, rel. error ≈ 1.15e-9). */
export function normInv(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const plow = 0.02425;
  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= 1 - plow) {
    const q = p - 0.5;
    const r = q * q;
    return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  const q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

// ── Seeded randomness ───────────────────────────────────────────────────────

export type Rng = () => number;

/** mulberry32 — small, fast, seedable PRNG returning [0, 1). */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable 32-bit seed from a string (e.g. ticker + date) so runs are reproducible. */
export function seedFrom(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Standard-normal sampler (Box-Muller, caches the spare draw). */
export function normalSampler(rng: Rng): () => number {
  let spare: number | null = null;
  return () => {
    if (spare !== null) { const s = spare; spare = null; return s; }
    let u = 0, v = 0;
    while (u <= 1e-300) u = rng();
    v = rng();
    const r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  };
}

export function poissonSample(rng: Rng, lambda: number, gauss?: () => number): number {
  if (lambda <= 0) return 0;
  if (lambda > 30 && gauss) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * gauss()));
  const L = Math.exp(-lambda);
  let k = 0, p = 1;
  do { k++; p *= rng(); } while (p > L);
  return k - 1;
}

// ── Optimization ────────────────────────────────────────────────────────────

export type OptResult = { x: number[]; fx: number; iterations: number; converged: boolean };

/**
 * Nelder-Mead simplex minimizer. Non-finite objective values are treated as
 * +∞, so callers enforce constraints by returning Infinity / NaN.
 */
export function nelderMead(
  f: (x: number[]) => number,
  x0: readonly number[],
  opts: { maxIter?: number; tolF?: number; tolX?: number; step?: number | number[] } = {},
): OptResult {
  const n = x0.length;
  const maxIter = opts.maxIter ?? 400 * n;
  const tolF = opts.tolF ?? 1e-10;
  const tolX = opts.tolX ?? 1e-9;
  const safe = (x: number[]) => { const v = f(x); return Number.isFinite(v) ? v : Infinity; };
  let simplex: number[][] = [x0.slice()];
  for (let i = 0; i < n; i++) {
    const x = x0.slice();
    const s = Array.isArray(opts.step) ? opts.step[i] : opts.step ?? 0.1;
    x[i] += s;
    simplex.push(x);
  }
  let fs = simplex.map(safe);
  let it = 0;
  let converged = false;
  for (; it < maxIter; it++) {
    const order = fs.map((_, i) => i).sort((a, b) => fs[a] - fs[b]);
    simplex = order.map((i) => simplex[i]);
    fs = order.map((i) => fs[i]);
    let xSpread = 0;
    for (let i = 1; i <= n; i++) for (let j = 0; j < n; j++) xSpread = Math.max(xSpread, Math.abs(simplex[i][j] - simplex[0][j]));
    const fSpread = Math.abs(fs[n] - fs[0]);
    if (Number.isFinite(fs[n]) && fSpread <= tolF * (1 + Math.abs(fs[0])) && xSpread <= tolX * (1 + Math.max(...simplex[0].map(Math.abs)))) {
      converged = true;
      break;
    }
    const c = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) c[j] += simplex[i][j] / n;
    const worst = simplex[n];
    const xr = c.map((cj, j) => cj + (cj - worst[j]));
    const fr = safe(xr);
    if (fr < fs[0]) {
      const xe = c.map((cj, j) => cj + 2 * (xr[j] - cj));
      const fe = safe(xe);
      if (fe < fr) { simplex[n] = xe; fs[n] = fe; } else { simplex[n] = xr; fs[n] = fr; }
      continue;
    }
    if (fr < fs[n - 1]) { simplex[n] = xr; fs[n] = fr; continue; }
    const outside = fr < fs[n];
    const xc = outside ? c.map((cj, j) => cj + 0.5 * (xr[j] - cj)) : c.map((cj, j) => cj + 0.5 * (worst[j] - cj));
    const fc = safe(xc);
    if (outside ? fc <= fr : fc < fs[n]) { simplex[n] = xc; fs[n] = fc; continue; }
    for (let i = 1; i <= n; i++) {
      simplex[i] = simplex[i].map((v, j) => simplex[0][j] + 0.5 * (v - simplex[0][j]));
      fs[i] = safe(simplex[i]);
    }
  }
  const best = fs.indexOf(Math.min(...fs));
  return { x: simplex[best], fx: fs[best], iterations: it, converged };
}

// ── Time-series diagnostics ─────────────────────────────────────────────────

export function acf(xs: readonly number[], maxLag: number): number[] {
  const n = xs.length;
  const m = mean(xs);
  let c0 = 0;
  for (const x of xs) c0 += (x - m) * (x - m);
  const out: number[] = [];
  for (let k = 1; k <= maxLag; k++) {
    let ck = 0;
    for (let t = k; t < n; t++) ck += (xs[t] - m) * (xs[t - k] - m);
    out.push(c0 > 0 ? ck / c0 : 0);
  }
  return out;
}

/** Ljung-Box Q test for residual autocorrelation. */
export function ljungBox(resid: readonly number[], lags: number, fitdf = 0): { q: number; df: number; p: number } {
  const n = resid.length;
  const r = acf(resid, lags);
  let q = 0;
  for (let k = 1; k <= lags; k++) q += (r[k - 1] * r[k - 1]) / (n - k);
  q *= n * (n + 2);
  const df = Math.max(1, lags - fitdf);
  return { q, df, p: 1 - chiSquareCdf(q, df) };
}
