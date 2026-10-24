/**
 * Portfolio construction — weights that buy the most expected excess return
 * the desk's tracking-error budget allows, measured against its index.
 *
 *   maximise  αᵀx − (λ/2)·TE²(x)   over  lo ≤ x ≤ hi,  Σx ≤ 1  (the rest is cash)
 *
 *  - x: each asset's weight in NAV. Cash earns nothing against the index, so
 *    an uninvested book trails it by the index's whole vol: the core (the
 *    desk index's ETF, α 0) closes that gap, and single names are tilts.
 *  - α: a name's expected annual return beyond what its market risk earns,
 *    the ensemble's confidence × the valuation blend's upside. The DCF behind
 *    that upside discounts at rf + β·ERP, so it is already net of the name's
 *    beta. The ERP the index itself earns over cash is left out (the valuation
 *    models assume one rather than measure it); the TE term is what keeps the
 *    book's beta at the index's.
 *  - TE²: annualised variance of the book's daily return less the index's
 *    over the measured window, the same sample measure the risk report and
 *    the trade gate use, so the plan's TE is what the gate will see.
 *  - λ is not chosen: it is solved for so the book's TE meets the operator's
 *    target. Any common scale on α (the horizon the upside is earned over)
 *    then cancels. When the bounds stop the book short of the target, or no
 *    allowed book gets down to it, the result says so (`binding`).
 *  - Bounds are the callers': a name's one-name risk cap (risk-budget.ts),
 *    weights that can't trade fixed at their current value, buy-only books
 *    floored at it.
 *
 * Solved by accelerated projected gradient (FISTA) on the box ∩ budget set;
 * the iteration limits and tolerances are numerical, not decision numbers.
 * Pure: no I/O.
 */
import { TRADING_DAYS } from "../quant/risk";

export type ConstructAsset = {
  ticker: string;
  /** Expected annual excess return (fraction). The core's is 0. */
  alpha: number;
  /** Bounds on the weight in NAV. */
  lo: number;
  hi: number;
  /** Daily returns on the index's calendar (same length as `index`). */
  returns: readonly number[];
};

export type ConstructInput = {
  assets: readonly ConstructAsset[];
  /** The desk index's daily returns over the window. */
  index: readonly number[];
  /** Target annual tracking error (fraction). */
  targetTe: number;
};

export type Construction = {
  weights: number[];
  /** Annual tracking error of the planned book. */
  te: number;
  /** αᵀx: the planned book's expected annual excess return. */
  alpha: number;
  /** ∂TE/∂xᵢ: what one more unit of each asset adds to the book's TE. */
  marginalTe: number[];
  /**
   * "target": TE meets the target.
   * "bounds": every asset with α > 0 is at its cap and TE is still under target.
   * "floor": the lowest TE the bounds allow is above target; this is that book.
   */
  binding: "target" | "bounds" | "floor";
  lambda: number | null;
};

const MAX_ITER = 20_000;
const STEP_TOL = 1e-11;
const TE_TOL = 1e-6;

function mean(xs: readonly number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return xs.length ? s / xs.length : 0;
}

/** Sample covariance (n − 1) of each asset with each, and with the index. */
function moments(assets: readonly ConstructAsset[], index: readonly number[]) {
  const T = index.length;
  const N = assets.length;
  const mi = mean(index);
  const Z = assets.map((a) => {
    const m = mean(a.returns);
    return a.returns.map((r) => r - m);
  });
  const zi = index.map((r) => r - mi);
  const S = Array.from({ length: N }, () => new Array<number>(N).fill(0));
  const c = new Array<number>(N).fill(0);
  for (let i = 0; i < N; i++) {
    for (let j = i; j < N; j++) {
      let s = 0;
      for (let t = 0; t < T; t++) s += Z[i][t] * Z[j][t];
      S[i][j] = S[j][i] = s / (T - 1);
    }
    let s = 0;
    for (let t = 0; t < T; t++) s += Z[i][t] * zi[t];
    c[i] = s / (T - 1);
  }
  let v = 0;
  for (const z of zi) v += z * z;
  return { S, c, v: v / (T - 1) };
}

/** Euclidean projection onto {lo ≤ x ≤ hi, Σx ≤ 1}. */
function project(y: readonly number[], lo: readonly number[], hi: readonly number[]): number[] {
  const clip = (tau: number) => y.map((v, i) => Math.min(hi[i], Math.max(lo[i], v - tau)));
  const sum = (x: number[]) => x.reduce((s, v) => s + v, 0);
  const x0 = clip(0);
  if (sum(x0) <= 1) return x0;
  let a = 0;
  let b = Math.max(...y.map((v, i) => v - lo[i]));
  for (let k = 0; k < 100 && b - a > 1e-15; k++) {
    const m = (a + b) / 2;
    if (sum(clip(m)) > 1) a = m;
    else b = m;
  }
  return clip(b);
}

export function construct(input: ConstructInput): Construction | null {
  const { assets, index, targetTe } = input;
  const N = assets.length;
  const T = index.length;
  if (!N || T < 2 || !(targetTe > 0) || assets.some((a) => a.returns.length !== T)) return null;
  const lo = assets.map((a) => Math.max(0, a.lo));
  const hi = assets.map((a, i) => Math.max(lo[i], a.hi));
  if (lo.reduce((s, v) => s + v, 0) > 1 + 1e-12) return null;
  const alpha = assets.map((a) => (Number.isFinite(a.alpha) ? a.alpha : 0));

  const { S, c, v } = moments(assets, index);
  const Sx = (x: readonly number[]) => S.map((row) => row.reduce((s, sij, j) => s + sij * x[j], 0));
  const teOf = (x: readonly number[]) => {
    const sx = Sx(x);
    const daily = x.reduce((s, xi, i) => s + xi * (sx[i] - 2 * c[i]), 0) + v;
    return Math.sqrt(Math.max(0, daily) * TRADING_DAYS);
  };
  // ‖S‖_F bounds S's largest eigenvalue, so 1/(λ·252·‖S‖_F) is a safe step.
  let frob = 0;
  for (const row of S) for (const s of row) frob += s * s;
  frob = Math.sqrt(frob) || 1e-12;

  // Maximise αᵀx − (λ/2)·252·(xᵀSx − 2cᵀx + v); λ = Infinity minimises TE alone.
  const solve = (lambda: number, start: readonly number[]): number[] => {
    const minTe = !Number.isFinite(lambda);
    const L = (minTe ? 1 : lambda) * TRADING_DAYS * frob;
    let x = project(start, lo, hi);
    let yk = x.slice();
    let tk = 1;
    for (let k = 0; k < MAX_ITER; k++) {
      const sy = Sx(yk);
      const grad = yk.map((_, i) => (minTe ? 0 : alpha[i]) - (minTe ? 1 : lambda) * TRADING_DAYS * (sy[i] - c[i]));
      const next = project(yk.map((yi, i) => yi + grad[i] / L), lo, hi);
      let step = 0;
      for (let i = 0; i < N; i++) step = Math.max(step, Math.abs(next[i] - x[i]));
      const t1 = (1 + Math.sqrt(1 + 4 * tk * tk)) / 2;
      yk = next.map((xi, i) => xi + ((tk - 1) / t1) * (xi - x[i]));
      x = next;
      tk = t1;
      if (step < STEP_TOL) break;
    }
    return x;
  };

  const finish = (x: number[], binding: Construction["binding"], lambda: number | null): Construction => {
    const te = teOf(x);
    const sx = Sx(x);
    const marginalTe = x.map((_, i) => (te > 0 ? ((sx[i] - c[i]) * TRADING_DAYS) / te : 0));
    return { weights: x, te, alpha: x.reduce((s, xi, i) => s + xi * alpha[i], 0), marginalTe, binding, lambda };
  };

  const start = lo.slice();
  const floor = solve(Infinity, start);
  const floorTe = teOf(floor);
  if (floorTe >= targetTe - TE_TOL) return finish(floor, "floor", null);
  if (!alpha.some((a, i) => a > 0 && hi[i] > lo[i])) return finish(floor, "bounds", null);

  // TE falls as λ rises. Bracket the λ where it meets the target, then bisect in log λ.
  let lam = 1;
  let x = solve(lam, floor);
  let te = teOf(x);
  let loLam: number, hiLam: number, hiX: number[];
  if (te > targetTe) {
    loLam = lam;
    while (te > targetTe && lam < 1e12) { loLam = lam; lam *= 10; x = solve(lam, x); te = teOf(x); }
    if (te > targetTe) return finish(floor, "floor", null);
    hiLam = lam;
    hiX = x;
  } else {
    hiLam = lam;
    hiX = x;
    while (te <= targetTe && lam > 1e-12) {
      hiLam = lam;
      hiX = x;
      lam /= 10;
      x = solve(lam, x);
      te = teOf(x);
    }
    // Even with α nearly unpenalised the bounds keep TE under target.
    if (te <= targetTe) return finish(x, "bounds", lam);
    loLam = lam;
  }
  for (let k = 0; k < 60; k++) {
    const mid = Math.sqrt(loLam * hiLam);
    const xm = solve(mid, hiX);
    const tm = teOf(xm);
    if (tm > targetTe) loLam = mid;
    else { hiLam = mid; hiX = xm; }
    if (Math.abs(tm - targetTe) < TE_TOL || hiLam / loLam < 1 + 1e-9) break;
  }
  return finish(hiX, "target", hiLam);
}
