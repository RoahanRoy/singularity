import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fitGbm, gbmProbAbove, gbmQuantile, monteCarloReport,
  fitMerton, simulateMerton, mertonDensity,
  fitOu, ouSeriesReport, residualLevel,
  bsPrice, bsGreeks, impliedVol, parseOccSymbol, impliedVolSummary, volRiskPremium, impliedVolProxy,
  type OptionQuote,
} from "./stochastic";
import { mulberry32, normalSampler, normCdf } from "./stats";

const close = (a: number, b: number, tol: number, msg?: string) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg ?? ""} expected ${b} ± ${tol}, got ${a}`);

const gbmRets = (n: number, mu: number, sigma: number, seed: number) => {
  const g = normalSampler(mulberry32(seed));
  return Array.from({ length: n }, () => (mu - sigma * sigma / 2) / 252 + (sigma / Math.sqrt(252)) * g());
};

test("GBM fit and closed forms", () => {
  const f = fitGbm(gbmRets(20000, 0.08, 0.3, 1))!;
  close(f.sigma, 0.3, 0.006, "σ");
  close(f.mu, 0.08, 0.1, "μ (noisy by nature)");
  close(gbmProbAbove(100, 100, 0.08, 0.3, 1), normCdf((0.08 - 0.045) / 0.3), 1e-12);
  close(gbmQuantile(100, 0.08, 0.3, 1, 0), 100 * Math.exp(0.035), 1e-9, "median = S₀e^{(μ−σ²/2)T}");
});

test("Monte Carlo engines agree with GBM on i.i.d. Gaussian returns", () => {
  const rets = gbmRets(2500, 0.1, 0.25, 2);
  const sd = 0.25 / Math.sqrt(252);
  const mc = monteCarloReport({
    s0: 100, logRets: rets, muAnnual: 0.07, muSource: "test",
    garch: { omega: sd * sd, alpha: 0, beta: 0, sigma2Next: sd * sd },
    fairValue: 110, paths: 20000, seed: 3,
  })!;
  const ref = mc.gbm.horizons[0];
  for (const engine of [mc.garch![0], mc.bootstrap[0]]) {
    assert.equal(engine.days, 21);
    close(engine.p50, ref.p50, 0.6, "median");
    close(engine.p5, ref.p5, 1, "5th percentile");
    close(engine.probUp, ref.probUp, 0.02, "P(up)");
    assert.ok(engine.var95 > 0 && engine.cvar95 > engine.var95, "CVaR beyond VaR");
    assert.ok(engine.probAboveFair! < 0.2, "a 10% gain in a month is unlikely at 25% vol");
  }
  close(mc.garch![0].mean, 100 * Math.exp(0.07 * 21 / 252), 0.3, "E[S_T] = S₀e^{μT}");
  assert.equal(mc.garch![1].days, 63);
  assert.ok(mc.garch![1].p95 - mc.garch![1].p5 > mc.garch![0].p95 - mc.garch![0].p5, "wider at 63d");
  assert.equal(monteCarloReport({ s0: 100, logRets: rets.slice(0, 50), muAnnual: 0.07, muSource: "t", seed: 1 }), null);
});

test("Merton jump diffusion: density integrates to 1, MLE finds the jumps", () => {
  const p = { m: 0.0005, sigma: 0.01, lambda: 0.02, muJ: -0.03, sigmaJ: 0.04 };
  let area = 0;
  for (let x = -0.5; x <= 0.5; x += 0.0005) area += mertonDensity(x, p) * 0.0005;
  close(area, 1, 1e-6, "∫ density");
  const r = fitMerton(simulateMerton(p, 6000, mulberry32(4)))!;
  close(r.params.sigma, 0.01, 0.0012, "diffusion σ");
  close(r.params.lambda, 0.02, 0.012, "λ");
  close(r.jumpShareOfVariance, 1 / 3, 0.12, "jump share of variance");
  assert.ok(r.jumpsSignificant, `LR ${r.lrStat}`);
  assert.ok(r.probDrop10pct21d.jump > r.probDrop10pct21d.gaussian, "negative jumps fatten the left tail");

  const g = normalSampler(mulberry32(5));
  const calm = fitMerton(Array.from({ length: 3000 }, () => 0.01 * g()))!;
  assert.ok(!calm.jumpsSignificant, `Gaussian data LR p ${calm.lrP}`);
});

test("Ornstein-Uhlenbeck recovers speed, mean and stationary spread", () => {
  const theta = 5, mu = 0.2, sigma = 0.3, dt = 1 / 252;
  const b = Math.exp(-theta * dt), sdE = sigma * Math.sqrt((1 - b * b) / (2 * theta));
  const g = normalSampler(mulberry32(6));
  const x = [mu];
  for (let t = 1; t < 6000; t++) x.push(mu + b * (x[t - 1] - mu) + sdE * g());
  const f = fitOu(x)!;
  close(f.halfLifeDays, (Math.LN2 / theta) * 252, 10, "half-life days");
  close(f.mu, mu, 0.03, "μ");
  close(f.stationarySd, sigma / Math.sqrt(2 * theta), 0.015, "stationary sd");
  const rep = ouSeriesReport("spread", x);
  assert.ok(rep.meanReverting);
  assert.ok(Math.abs(rep.zNow!) < 4);

  let w = 0;
  const walk = Array.from({ length: 2000 }, () => (w += 0.01 * g()));
  assert.ok(!ouSeriesReport("walk", walk).meanReverting, "a random walk is not mean-reverting");

  const mkt = Array.from({ length: 500 }, () => 0.01 * g());
  const stock = mkt.map((m) => 1.3 * m + 0.01 * g());
  close(residualLevel(stock, mkt)!.beta, 1.3, 0.1);
});

test("Black-Scholes prices, parity, greeks and implied vol", () => {
  close(bsPrice("call", 100, 100, 1, 0.05, 0.2), 10.450584, 1e-5, "textbook call");
  close(bsPrice("put", 100, 100, 1, 0.05, 0.2), 5.573526, 1e-5, "textbook put");
  const [S, K, T, r, s, q] = [120, 110, 0.4, 0.03, 0.35, 0.01];
  close(bsPrice("call", S, K, T, r, s, q) - bsPrice("put", S, K, T, r, s, q), S * Math.exp(-q * T) - K * Math.exp(-r * T), 1e-9, "put-call parity");
  for (const type of ["call", "put"] as const) {
    const gk = bsGreeks(type, S, K, T, r, s, q);
    const h = 1e-3;
    close(gk.delta, (bsPrice(type, S + h, K, T, r, s, q) - bsPrice(type, S - h, K, T, r, s, q)) / (2 * h), 1e-6, `${type} delta`);
    close(gk.gamma, (bsPrice(type, S + h, K, T, r, s, q) - 2 * bsPrice(type, S, K, T, r, s, q) + bsPrice(type, S - h, K, T, r, s, q)) / (h * h), 1e-4, `${type} gamma`);
    close(gk.vega, (bsPrice(type, S, K, T, r, s + h, q) - bsPrice(type, S, K, T, r, s - h, q)) / (2 * h), 1e-4, `${type} vega`);
    close(gk.theta, -(bsPrice(type, S, K, T + h, r, s, q) - bsPrice(type, S, K, T - h, r, s, q)) / (2 * h), 1e-4, `${type} theta`);
    close(gk.rho, (bsPrice(type, S, K, T, r + h, s, q) - bsPrice(type, S, K, T, r - h, s, q)) / (2 * h), 1e-4, `${type} rho`);
  }
  for (const [k, vol] of [[100, 0.37], [60, 0.8], [150, 0.25], [100, 0.05]] as const) {
    const px = bsPrice("call", 100, k, 0.5, 0.04, vol);
    close(impliedVol(px, "call", 100, k, 0.5, 0.04)!, vol, 1e-6, `IV round trip K=${k}`);
  }
  assert.equal(impliedVol(0.0001, "call", 100, 50, 0.5, 0.04), null, "below intrinsic");
  assert.equal(impliedVol(101, "call", 100, 100, 0.5, 0.04), null, "above the stock price");
});

test("options summary: OCC parsing, 30-day IV, skew, term structure", () => {
  assert.deepEqual(parseOccSymbol("AAPL261120C00150000"), { root: "AAPL", expiry: "2026-11-20", type: "call", strike: 150 });
  assert.deepEqual(parseOccSymbol("BRK.B270115P00400500"), { root: "BRK.B", expiry: "2027-01-15", type: "put", strike: 400.5 });
  assert.equal(parseOccSymbol("garbage"), null);

  const asOf = new Date("2026-10-18T20:00:00Z");
  const spot = 100, r = 0.04;
  const iso = (d: number) => new Date(asOf.getTime() + d * 86_400_000).toISOString().slice(0, 10);
  const surface = (volFor: (type: "call" | "put", k: number) => number): OptionQuote[] => {
    const out: OptionQuote[] = [];
    for (const dte of [14, 45, 90]) {
      for (let k = 70; k <= 130; k += 2.5) {
        for (const type of ["call", "put"] as const) {
          const px = bsPrice(type, spot, k, dte / 365, r, volFor(type, k));
          out.push({ expiry: iso(dte), type, strike: k, bid: px * 0.99, ask: px * 1.01, openInterest: type === "put" ? 2 : 1, volume: 1 });
        }
      }
    }
    return out;
  };
  const flat = impliedVolSummary(surface(() => 0.25), spot, asOf, r);
  close(flat.iv30!, 0.25, 0.003, "flat surface iv30");
  close(flat.skew25d!, 0, 0.005, "no skew");
  close(flat.termSlope!, 0, 0.005);
  close(flat.putCallOiRatio!, 2, 1e-12);
  close(flat.expectedMove21d!.pct, 25 * Math.sqrt(21 / 252), 0.1);
  assert.equal(flat.expiriesUsed, 3);

  const skewed = impliedVolSummary(surface((_, k) => (k < spot ? 0.32 : 0.22)), spot, asOf, r);
  assert.ok(skewed.skew25d! > 0.07, `downside skew ${skewed.skew25d}`);

  close(volRiskPremium(0.3, 0.25).gap, 0.05, 1e-12);
  close(impliedVolProxy(0.15, 1, 0.2), 0.25, 1e-12);
});
