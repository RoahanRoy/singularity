import { test } from "node:test";
import assert from "node:assert/strict";
import { annualizedVol, beta, sharpe, sortino, maxDrawdown, historicalVaR, parametricVaR, cornishFisherVaR, cvar, riskReport, curveCagr, positionVarPct, sharpeDifferenceTest, timingAlpha } from "./risk";
import { mulberry32, normalSampler } from "./stats";

const close = (a: number, b: number, tol: number, msg?: string) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg ?? ""} expected ${b}, got ${a}`);

const gauss = normalSampler(mulberry32(3));
const mkt = Array.from({ length: 5000 }, () => 0.0004 + 0.01 * gauss());
const stock = mkt.map((m) => 1.5 * m + 0.008 * gauss());

test("vol, beta, Sharpe, Sortino", () => {
  close(annualizedVol(mkt), 0.01 * Math.sqrt(252), 0.005);
  close(beta(stock, mkt), 1.5, 0.03);
  const s = sharpe(mkt, 0);
  close(s, (0.0004 / 0.01) * Math.sqrt(252), 0.25);
  assert.ok(sortino(mkt, 0) > s, "symmetric returns: Sortino ≈ √2 × Sharpe");
});

test("max drawdown finds peak, trough, recovery", () => {
  const dd = maxDrawdown([100, 120, 90, 60, 80, 125, 110]);
  close(dd.maxDrawdown, 0.5, 1e-12);
  assert.equal(dd.peakIndex, 1);
  assert.equal(dd.troughIndex, 3);
  assert.equal(dd.recoveryIndex, 5);
  close(dd.current, 1 - 110 / 125, 1e-12);
  close(curveCagr([100, 110], 1), 0.1, 1e-12);
});

test("VaR estimators agree on Gaussian data", () => {
  const rets = Array.from({ length: 20000 }, () => 0.01 * gauss());
  const want = 1.645 * 0.01;
  close(historicalVaR(rets), want, 0.0006);
  close(parametricVaR(0, 0.01), want, 1e-4);
  close(cornishFisherVaR(rets), want, 0.0006);
  assert.ok(cvar(rets) > historicalVaR(rets), "CVaR is beyond VaR");
  close(positionVarPct(5, 0.02), 0.1, 1e-12);
});

test("risk report on a price path", () => {
  let p = 100;
  const prices = [p, ...stock.slice(0, 600).map((r) => (p *= 1 + r))];
  let m = 100;
  const mp = [m, ...mkt.slice(0, 600).map((r) => (m *= 1 + r))];
  const r = riskReport(prices, 0.04, mp)!;
  assert.equal(r.observations, 600);
  close(r.beta!, 1.5, 0.1);
  assert.ok(r.var95.historical > 0 && r.cvar95 > 0);
  assert.equal(riskReport(prices.slice(0, 10), 0.04), null);
});

test("Sharpe-difference test is calibrated under the null and detects a real gap", () => {
  const g = normalSampler(mulberry32(17));
  // Equal true Sharpe (0.05 daily), correlation 0.5: |z| > 1.96 should happen ~5% of the time.
  let rejections = 0;
  const trials = 600;
  for (let k = 0; k < trials; k++) {
    const a: number[] = [], b: number[] = [];
    for (let i = 0; i < 500; i++) {
      const c = g(), u = g(), v = g();
      a.push(0.0005 + 0.01 * (Math.SQRT1_2 * c + Math.SQRT1_2 * u));
      b.push(0.001 + 0.02 * (Math.SQRT1_2 * c + Math.SQRT1_2 * v));
    }
    if (Math.abs(sharpeDifferenceTest(a, b)!.z) > 1.96) rejections++;
  }
  const rate = rejections / trials;
  assert.ok(rate > 0.025 && rate < 0.08, `false-positive rate ${rate}`);
  // A 0.25 daily Sharpe gap over 750 days: expected z ≈ 0.25 / √(2.05 / 750) ≈ 4.8.
  const a = Array.from({ length: 750 }, () => 0.003 + 0.01 * g());
  const b = Array.from({ length: 750 }, () => 0.0005 + 0.01 * g());
  const t = sharpeDifferenceTest(a, b)!;
  assert.ok(t.z > 2 && t.p < 0.05 && t.sharpeA > t.sharpeB, `z ${t.z}`);
  assert.equal(sharpeDifferenceTest(a.slice(0, 10), b.slice(0, 10)), null);
  assert.equal(sharpeDifferenceTest(a, a.map(() => 0)), null, "a series with no variance has no Sharpe");
});

test("timing alpha ignores drift and detects informed timing", () => {
  const g = normalSampler(mulberry32(17));
  const rng = mulberry32(18);
  // A falling asset and a position that knows nothing: out of it 70% of the time.
  const r = Array.from({ length: 3000 }, () => -0.003 + 0.015 * g());
  const blind = r.map(() => (rng() < 0.3 ? 1 : 0));
  const blindRet = r.map((x, i) => blind[i] * x);
  const ta = timingAlpha(blindRet, r)!;
  assert.ok(Math.abs(ta.t) < 2.5, `uninformed timing: alpha t ${ta.t}`);
  close(ta.beta, 0.3, 0.05, "beta is the average exposure");
  // …yet its Sharpe beats buy-and-hold, because cash beats a falling asset.
  const z = sharpeDifferenceTest(blindRet, r)!.z;
  assert.ok(z > 2, `Sharpe-difference z ${z}`);
  // A position that is right 60% of the time about whether the day beats the drift.
  const informed = r.map((x) => ((x > -0.003) === (rng() < 0.6) ? 1 : 0));
  const good = timingAlpha(r.map((x, i) => informed[i] * x), r)!;
  assert.ok(good.alpha > 0 && good.t > 3, `informed timing: alpha ${good.alpha} t ${good.t}`);
  assert.equal(timingAlpha(r.slice(0, 59), r.slice(0, 59)), null);
});
