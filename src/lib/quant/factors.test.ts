import { test } from "node:test";
import assert from "node:assert/strict";
import { fitFactorModels, US_FACTOR_MODELS, capmReport, preferredModel, styleTilts, fitMacroFactors, neweyWestLags, type FactorRow } from "./factors";
import { mulberry32, normalSampler } from "./stats";

const close = (a: number, b: number, tol: number, msg?: string) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg ?? ""} expected ${b} ± ${tol}, got ${a}`);

const g = normalSampler(mulberry32(7));
const N = 1500;
const dates = Array.from({ length: N }, (_, i) => new Date(Date.UTC(2019, 0, 1) + i * 86_400_000).toISOString().slice(0, 10));
const factors = new Map<string, FactorRow>();
const stock = new Map<string, number>();
const alphaDaily = 0.0004; // ≈ 10% a year
dates.forEach((d) => {
  const row: FactorRow = { RF: 0.0001, MKT: 0.0003 + 0.01 * g(), SMB: 0.005 * g(), HML: 0.005 * g(), MOM: 0.006 * g(), RMW: 0.003 * g(), CMA: 0.003 * g() };
  factors.set(d, row);
  stock.set(d, row.RF + alphaDaily + 1.2 * row.MKT + 0.5 * row.SMB - 0.4 * row.HML + 0.3 * row.MOM + 0.004 * g());
});

test("factor regressions recover betas and alpha", () => {
  const fits = fitFactorModels(stock, factors, US_FACTOR_MODELS, { window: N });
  assert.equal(fits.length, 5);
  const c4 = fits.find((f) => f.model === "Carhart 4")!;
  const b = Object.fromEntries(c4.betas.map((e) => [e.factor, e.beta]));
  // Sampling sd ≈ 0.004 / (σ_factor·√N): 0.010 for MKT, 0.021 for SMB/HML, 0.017 for MOM;
  // annual alpha sd ≈ 0.004·252/√N = 0.026. Allow ~3 sd.
  close(b.MKT, 1.2, 0.035, "MKT");
  close(b.SMB, 0.5, 0.065, "SMB");
  close(b.HML, -0.4, 0.065, "HML");
  close(b.MOM, 0.3, 0.055, "MOM");
  close(c4.alphaAnnual, alphaDaily * 252, 0.08, "annual alpha");
  assert.ok(c4.alphaT > 2, `alpha t ${c4.alphaT}`);
  assert.ok(c4.covType.startsWith("newey-west"));
  close(c4.residualVolAnnual, 0.004 * Math.sqrt(252), 0.005);
  const capm = fits.find((f) => f.model === "CAPM")!;
  assert.ok(c4.r2 > capm.r2, "more factors explain more variance");
  const best = preferredModel(fits)!;
  assert.ok(best.model === "Carhart 4" || best.model === "FF5 + Momentum", `BIC picked ${best.model}`);
  assert.deepEqual(styleTilts(c4).sort(), ["high market beta", "growth tilt", "momentum winner", "small-cap tilt"].sort());

  const rep = capmReport(capm, 0.12, 0.04, 0.05);
  close(rep.requiredReturn, 0.04 + rep.beta * 0.05, 1e-12);
  close(rep.betaBlume, (2 / 3) * rep.beta + 1 / 3, 1e-12);
  assert.equal(neweyWestLags(1500), Math.floor(4 * Math.pow(15, 2 / 9)));
});

test("models skip dates where a factor is missing", () => {
  const sparse = new Map(factors);
  dates.slice(0, 1000).forEach((d) => { const r = { ...sparse.get(d)! }; delete r.RMW; sparse.set(d, r); });
  const fits = fitFactorModels(stock, sparse, US_FACTOR_MODELS, { window: N });
  assert.equal(fits.find((f) => f.model === "Fama-French 5")!.n, 500);
  assert.equal(fits.find((f) => f.model === "CAPM")!.n, 1500);
});

test("APT macro regression ranks the true driver first", () => {
  const W = 400;
  let rate = 4, oil = 80, fx = 100, px = 50;
  const rates: number[] = [], oils: number[] = [], fxs: number[] = [], prices: number[] = [px];
  rates.push(rate); oils.push(oil); fxs.push(fx);
  for (let t = 1; t < W; t++) {
    const dRate = 0.1 * g(), oilRet = 0.04 * g(), fxRet = 0.01 * g();
    rate += dRate; oil *= Math.exp(oilRet); fx *= Math.exp(fxRet);
    rates.push(rate); oils.push(oil); fxs.push(fx);
    px *= 1 + 0.0005 - 0.2 * dRate + 0.02 * g(); // −2% per +10bp week… scaled: rates hurt
    prices.push(px);
  }
  const fit = fitMacroFactors(prices, 0.0008, [
    { name: "Δ10y", levels: rates, transform: "diff" },
    { name: "oil", levels: oils, transform: "logret" },
    { name: "dollar", levels: fxs, transform: "logret" },
  ])!;
  assert.equal(fit.n, W - 1);
  assert.equal(fit.ranked[0].factor, "Δ10y");
  assert.ok(fit.ranked[0].pctPerSd < 0 && fit.ranked[0].significant);
  close(fit.ranked[0].sdNatural, 0.1, 0.01, "weekly sd of Δ10y");
  assert.equal(fitMacroFactors(prices.slice(0, 20), 0, [{ name: "x", levels: rates.slice(0, 20), transform: "diff" }]), null);
});
