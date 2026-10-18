import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mean, variance, std, quantile, median, skewness, excessKurtosis, spearman, rank,
  inverse, matMul, identity, ols, ridge, lasso, normCdf, normInv, studentTCdf, tTwoSidedP,
  chiSquareCdf, nelderMead, mulberry32, normalSampler, ljungBox, logGamma, percentileOf,
} from "./stats";

const close = (a: number, b: number, tol: number, msg?: string) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg ?? ""} expected ${b}, got ${a} (tol ${tol})`);

test("moments and order statistics", () => {
  const xs = [2, 4, 4, 4, 5, 5, 7, 9];
  assert.equal(mean(xs), 5);
  close(variance(xs, 0), 4, 1e-12);
  close(std(xs, 0), 2, 1e-12);
  close(quantile([1, 2, 3, 4], 0.25), 1.75, 1e-12, "type-7 quantile");
  assert.equal(median([3, 1, 2]), 2);
  close(skewness([1, 2, 3, 4, 5]), 0, 1e-12);
  assert.ok(excessKurtosis([1, 2, 3, 4, 5]) < 0, "uniform-ish is platykurtic");
  assert.deepEqual(rank([10, 20, 20, 5]), [2, 3.5, 3.5, 1]);
  close(spearman([1, 2, 3, 4], [10, 20, 30, 40]), 1, 1e-12);
  close(percentileOf([1, 2, 3, 4], 3), 0.625, 1e-12);
});

test("matrix inverse round-trips", () => {
  const a = [[4, 7, 2], [3, 6, 1], [2, 5, 3]];
  const inv = inverse(a);
  assert.ok(inv);
  const p = matMul(a, inv!);
  const I = identity(3);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) close(p[i][j], I[i][j], 1e-10);
  assert.equal(inverse([[1, 2], [2, 4]]), null, "singular matrix");
});

test("OLS recovers known coefficients", () => {
  const rng = normalSampler(mulberry32(7));
  const X: number[][] = [];
  const y: number[] = [];
  for (let i = 0; i < 2000; i++) {
    const x1 = rng(), x2 = rng();
    X.push([x1, x2]);
    y.push(1.5 + 2 * x1 - 0.5 * x2 + 0.1 * rng());
  }
  const r = ols(y, X)!;
  close(r.coef[0], 1.5, 0.01);
  close(r.coef[1], 2, 0.01);
  close(r.coef[2], -0.5, 0.01);
  assert.ok(r.r2 > 0.99);
  assert.ok(r.p[1] < 1e-6);
  const nw = ols(y, X, { neweyWestLags: 5 })!;
  close(nw.coef[1], r.coef[1], 1e-12, "HAC changes SEs, not estimates");
  assert.ok(nw.covType.startsWith("newey-west"));
});

test("ridge and lasso", () => {
  const rng = normalSampler(mulberry32(11));
  const X: number[][] = [];
  const y: number[] = [];
  for (let i = 0; i < 500; i++) {
    const row = [rng(), rng(), rng(), rng()];
    X.push(row);
    y.push(3 * row[0] + 0.05 * rng());
  }
  const r0 = ridge(y, X, 1e-9)!;
  close(r0.coef[0], 3, 0.02, "ridge λ→0 ≈ OLS");
  const r1 = ridge(y, X, 10)!;
  assert.ok(Math.abs(r1.coef[0]) < Math.abs(r0.coef[0]), "ridge shrinks");
  const l = lasso(y, X, 0.1)!;
  assert.ok(Math.abs(l.coef[0]) > 2.5, "lasso keeps the true feature");
  for (let j = 1; j < 4; j++) assert.equal(l.coef[j], 0, `lasso zeroes noise feature ${j}`);
});

test("distribution functions", () => {
  close(normCdf(0), 0.5, 1e-7);
  close(normCdf(1.959964), 0.975, 1e-6);
  close(normInv(0.975), 1.959964, 1e-6);
  close(normInv(0.01), -2.326348, 1e-6);
  close(studentTCdf(2, 10), 0.963306, 1e-5);
  close(tTwoSidedP(2.228139, 10), 0.05, 1e-5);
  close(chiSquareCdf(3.841459, 1), 0.95, 1e-6);
  close(chiSquareCdf(18.307038, 10), 0.95, 1e-6);
  close(logGamma(5), Math.log(24), 1e-10);
});

test("Nelder-Mead minimizes Rosenbrock", () => {
  const f = (x: number[]) => (1 - x[0]) ** 2 + 100 * (x[1] - x[0] ** 2) ** 2;
  const r = nelderMead(f, [-1.2, 1], { maxIter: 5000, step: 0.5 });
  close(r.x[0], 1, 1e-3);
  close(r.x[1], 1, 2e-3);
});

test("seeded RNG is reproducible and roughly normal", () => {
  const a = normalSampler(mulberry32(42));
  const b = normalSampler(mulberry32(42));
  const xs = Array.from({ length: 20000 }, () => a());
  assert.equal(xs[0], b());
  close(mean(xs), 0, 0.03);
  close(std(xs), 1, 0.03);
  const lb = ljungBox(xs, 10);
  assert.ok(lb.p > 0.01, `white noise should pass Ljung-Box (p=${lb.p})`);
});
