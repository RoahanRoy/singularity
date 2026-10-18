import { test } from "node:test";
import assert from "node:assert/strict";
import {
  arStationary, maInvertible, fitArma, selectArma, armaForecast, arimaReport,
  fitGarch, garchTermStructure, garchReport,
  holt, holtForecast, fitSes, fitHoltDamped, smoothingReport,
  kalmanTrendReport, kalmanBeta,
  mackinnonCrit, adf, halfLife, engleGranger, pairsScan,
  markovSwitching,
} from "./timeseries";
import { alignOnDates, sampleEvery, closeOnOrBefore, alignMap } from "./series";
import { mulberry32, normalSampler, mean } from "./stats";
import type { Bar } from "./types";

const close = (a: number, b: number, tol: number, msg?: string) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg ?? ""} expected ${b} ± ${tol}, got ${a}`);

const ar1 = (n: number, c: number, phi: number, sd: number, seed: number) => {
  const g = normalSampler(mulberry32(seed));
  const x = [c / (1 - phi)];
  for (let t = 1; t < n; t++) x.push(c + phi * x[t - 1] + sd * g());
  return x;
};
const randomWalk = (n: number, sd: number, seed: number, start = 0) => {
  const g = normalSampler(mulberry32(seed));
  const x = [start];
  for (let t = 1; t < n; t++) x.push(x[t - 1] + sd * g());
  return x;
};

test("ARMA: stationarity triangle, AR(1) and MA(1) recovery, forecasts decay to the mean", () => {
  assert.ok(arStationary([0.5]) && !arStationary([1.01]));
  assert.ok(arStationary([0.5, 0.3]) && !arStationary([0.6, 0.5]) && !arStationary([0.2, -1.1]));
  assert.ok(maInvertible([0.4]) && !maInvertible([-1.2]));

  const x = ar1(3000, 0.0005, 0.5, 0.01, 11);
  const f = fitArma(x, 1, 0)!;
  close(f.phi[0], 0.5, 0.04, "φ");
  close(f.c / (1 - f.phi[0]), 0.001, 0.0005, "unconditional mean");
  close(Math.sqrt(f.sigma2), 0.01, 0.0005, "σ");

  const g = normalSampler(mulberry32(12));
  const e = Array.from({ length: 3000 }, () => 0.01 * g());
  const ma = e.map((v, t) => v + (t ? 0.4 * e[t - 1] : 0));
  close(fitArma(ma, 0, 1)!.theta[0], 0.4, 0.05, "θ");

  const sel = selectArma(x)!;
  assert.ok(sel.p >= 1, `AIC should keep the AR term (picked ${sel.p},${sel.q})`);
  const fc = armaForecast(f, x, 50);
  close(fc[49], f.c / (1 - f.phi[0]), 1e-6, "long-horizon forecast → mean");
});

test("ARIMA report: beats the random walk on AR data, not on white noise", () => {
  const ar = ar1(1200, 0, 0.4, 0.01, 21);
  const r = arimaReport(ar)!;
  // Oracle: the true AR(1) predictor scored on the same held-out window.
  const split = Math.floor(ar.length * 0.7), drift = mean(ar.slice(0, split));
  let sm = 0, sb = 0;
  for (let t = split; t < ar.length; t++) { sm += (ar[t] - 0.4 * ar[t - 1]) ** 2; sb += (ar[t] - drift) ** 2; }
  assert.ok(r.oos.skill > 0.05, `skill on AR(1) data ${r.oos.skill}`);
  close(r.oos.skill, 1 - sm / sb, 0.02, "fitted model ≈ oracle skill");
  assert.ok(r.oos.hitRate! > 0.55);
  assert.ok(r.oos.dmT > 2, `Diebold-Mariano on AR(1) data ${r.oos.dmT}`);
  const g = normalSampler(mulberry32(22));
  const wn = Array.from({ length: 1200 }, () => 0.01 * g());
  const w = arimaReport(wn)!;
  assert.ok(w.oos.skill < 0.02, `white noise should not be forecastable, skill ${w.oos.skill}`);
  assert.ok(!(w.oos.dmT >= 2), `no significant edge on white noise, DM ${w.oos.dmT}`);
  assert.ok(w.ljungBoxP > 0.01);
  assert.equal(arimaReport(wn.slice(0, 100)), null);
});

test("GARCH(1,1): recovers parameters; forecasts revert to the long-run variance", () => {
  const g = normalSampler(mulberry32(31));
  const omega = 2e-6, alpha = 0.08, beta = 0.9;
  const lr = omega / (1 - alpha - beta);
  const rets: number[] = [];
  let s2 = lr;
  for (let t = 0; t < 6000; t++) {
    const r = Math.sqrt(s2) * g();
    rets.push(r);
    s2 = omega + alpha * r * r + beta * s2;
  }
  const fit = fitGarch(rets)!;
  close(fit.alpha, alpha, 0.03, "α");
  close(fit.beta, beta, 0.04, "β");
  close(fit.persistence, alpha + beta, 0.015, "α + β");
  const ts = garchTermStructure(fit, fit.longRunVar * 4, 2000);
  close(ts[0], fit.longRunVar * 4, 1e-15, "h = 1 is the next-day variance");
  close(ts[1999], fit.longRunVar, fit.longRunVar * 1e-3, "h → ∞ is the long-run variance");

  const rep = garchReport(rets)!;
  close(rep.halfLifeDays, Math.log(0.5) / Math.log(fit.persistence), 1e-9);
  close(rep.longRunVol, Math.sqrt(lr * 252), 0.03, "long-run vol");
  assert.ok(rep.oos.n > 1000);
  assert.ok(rep.oos.beatsNaive, `GARCH QLIKE ${rep.oos.qlikeGarch} vs naive ${rep.oos.qlikeNaive}`);
  assert.equal(garchReport(rets.slice(0, 200)), null);
});

test("exponential smoothing: SES on a level, Holt on a trend", () => {
  const g = normalSampler(mulberry32(41));
  const level = Array.from({ length: 400 }, () => 10 + 0.5 * g());
  const ses = fitSes(level);
  assert.ok(ses.alpha < 0.2, `noisy constant ⇒ small α, got ${ses.alpha}`);
  assert.equal(ses.phi, 0);

  const trend = Array.from({ length: 400 }, (_, t) => 5 + 0.02 * t + 0.05 * g());
  const h = fitHoltDamped(trend);
  const run = holt(trend, h.alpha, h.beta, h.phi);
  close(run.trend[run.trend.length - 1], 0.02, 0.01, "Holt slope");
  close(holtForecast(1, 0.5, 1, 4), 3, 1e-12, "φ = 1 ⇒ ℓ + h·b");
  close(holtForecast(1, 0.5, 0.5, 2), 1 + 0.5 * (0.5 + 0.25), 1e-12, "damped");

  const rw = randomWalk(800, 0.01, 42, Math.log(100));
  const rep = smoothingReport(rw)!;
  assert.ok(rep.oos.n > 200);
  assert.ok(Number.isFinite(rep.oos.skill));
  assert.ok(Number.isFinite(rep.oos.dmT) && rep.oos.dmT < 2, `a random walk has no forecastable trend, DM ${rep.oos.dmT}`);
});

test("Kalman: trend filter sees drift; dynamic beta tracks a beta of 1.2", () => {
  const g = normalSampler(mulberry32(51));
  const lp = [Math.log(50)];
  for (let t = 1; t < 1000; t++) lp.push(lp[t - 1] + 0.002 + 0.005 * g());
  const tr = kalmanTrendReport(lp)!;
  assert.equal(tr.signal, "uptrend");
  close(tr.slopeAnnual, 0.002 * 252, 0.25, "annualized slope");
  const flat = kalmanTrendReport(randomWalk(1000, 0.01, 52, Math.log(50)))!;
  assert.notEqual(flat.signal, "uptrend", `driftless walk read as ${flat.signal} (t ${flat.slopeT})`);

  const mkt = Array.from({ length: 1500 }, () => 0.01 * g());
  const asset = mkt.map((m) => 0.0002 + 1.2 * m + 0.006 * g());
  const kb = kalmanBeta(asset, mkt)!;
  close(kb.beta, 1.2, 0.15, "dynamic β");
  assert.equal(kb.path.length, 1500);
});

test("unit roots: MacKinnon values, ADF on walks vs AR(1), half-life", () => {
  close(mackinnonCrit(1e9, 1)["5%"], -2.86154, 1e-6);
  close(mackinnonCrit(100, 1)["5%"], -2.8909, 1e-3, "classic DF table, T = 100");
  close(mackinnonCrit(1e9, 2)["5%"], -3.33613, 1e-6);

  const walk = adf(randomWalk(1000, 1, 61))!;
  assert.ok(walk.stat > walk.crit["5%"], `random walk should not reject, τ = ${walk.stat}`);
  const stat = adf(ar1(1000, 0, 0.9, 1, 62))!;
  assert.equal(stat.pBucket, "<1%", `AR(0.9) should reject, τ = ${stat.stat}`);
  close(halfLife(ar1(5000, 0, 0.9, 1, 63)), Math.LN2 / -Math.log(0.9), 0.8, "half-life of AR(0.9)");
  assert.equal(halfLife(randomWalk(200, 1, 64).map((_, i) => i)), Infinity, "a trend never reverts");
});

test("Engle-Granger and pairs scan find the cointegrated peer", () => {
  const x = randomWalk(1200, 0.01, 71, Math.log(40));
  const noise = ar1(1200, 0, 0.6, 0.01, 72);
  const y = x.map((v, i) => 0.3 + 0.8 * v + noise[i]);
  const eg = engleGranger(y, x)!;
  close(eg.hedgeRatio, 0.8, 0.05);
  assert.ok(eg.adf.stat < eg.adf.crit["1%"]);
  const indep = engleGranger(y, randomWalk(1200, 0.01, 73, Math.log(40)))!;
  assert.ok(indep.adf.stat > indep.adf.crit["5%"], `independent walks τ = ${indep.adf.stat}`);

  const scan = pairsScan(y, [
    { symbol: "IND1", logp: randomWalk(1200, 0.01, 74, 3) },
    { symbol: "PEER", logp: x },
    { symbol: "IND2", logp: randomWalk(1200, 0.01, 75, 3) },
  ]);
  assert.equal(scan.tested, 3);
  assert.equal(scan.level, "5%");
  assert.equal(scan.best?.peer, "PEER");
  assert.ok(scan.best!.halfLifeDays < 5);
});

test("Markov switching recovers a bull/bear process", () => {
  const rng = mulberry32(81);
  const g = normalSampler(rng);
  const P = [[0.98, 0.02], [0.05, 0.95]];
  const mu = [0.001, -0.002], sg = [0.008, 0.02];
  let s = 0;
  const truth: number[] = [], x: number[] = [];
  for (let t = 0; t < 4000; t++) {
    if (t) s = rng() < P[s][s] ? s : 1 - s;
    truth.push(s);
    x.push(mu[s] + sg[s] * g());
  }
  const r = markovSwitching(x)!;
  const [bull, bear] = r.states;
  close(bull.sigma, 0.008, 0.001, "bull σ");
  close(bear.sigma, 0.02, 0.002, "bear σ");
  assert.ok(bull.mu > bear.mu);
  close(r.transition[0][0], 0.98, 0.015, "p(bull→bull)");
  close(r.transition[1][1], 0.95, 0.03, "p(bear→bear)");
  close(bull.expectedDuration, 1 / (1 - r.transition[0][0]), 1e-9);
  const acc = mean(r.probBullPath.map((p, t) => ((p >= 0.5 ? 0 : 1) === truth[t] ? 1 : 0)));
  assert.ok(acc > 0.85, `filtered-state accuracy ${acc}`);
});

test("series helpers align, resample and look up", () => {
  const bar = (date: string, c: number): Bar => ({ t: 0, date, open: c, high: c, low: c, close: c, adjClose: c, volume: 1 });
  const a = [bar("2026-01-02", 1), bar("2026-01-03", 2), bar("2026-01-06", 3)];
  const b = [bar("2026-01-03", 20), bar("2026-01-06", 30), bar("2026-01-07", 40)];
  assert.deepEqual(alignOnDates([a, b]), { dates: ["2026-01-03", "2026-01-06"], cols: [[2, 3], [20, 30]] });
  assert.deepEqual(sampleEvery([1, 2, 3, 4, 5, 6, 7], 3), [1, 4, 7]);
  assert.equal(closeOnOrBefore(a, "2026-01-05"), 2);
  assert.equal(closeOnOrBefore(a, "2025-12-31"), null);
  assert.deepEqual(alignMap(["x", "y", "z"], new Map([["y", 5]])), { idx: [1], vals: [5] });
});
