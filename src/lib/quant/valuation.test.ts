import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fcff, capm, wacc, dcf, gordonDdm, residualIncome, terminalValue, fadePath, snapshot, defaultAssumptions,
  costOfCapital, dcfModel, ddmModel, residualIncomeModel, computeMultiples, relativeModel, impliedPrice,
  blendValuation, verdictFor, historicalMultiples,
} from "./valuation";
import type { Fundamentals } from "./types";

const close = (a: number, b: number, tol: number, msg?: string) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg ?? ""} expected ${b}, got ${a}`);

test("textbook formulas", () => {
  close(fcff({ ebit: 100, taxRate: 0.25, da: 20, capex: 30, deltaNwc: 5 }), 60, 1e-12);
  close(capm(0.04, 1.2, 0.05), 0.1, 1e-12);
  close(wacc({ equity: 600, debt: 400, costOfEquity: 0.1, costOfDebt: 0.05, taxRate: 0.25 }).wacc, 0.075, 1e-12);
  close(terminalValue(105, 0.1, 0.05), 2100, 1e-9);
  assert.ok(Number.isNaN(terminalValue(100, 0.05, 0.05)), "r ≤ g breaks Gordon");
});

test("DCF of a flat perpetuity equals FCF / WACC", () => {
  const r = dcf({ fcf: [100, 100, 100, 100, 100], wacc: 0.1, g: 0, netDebt: 200, shares: 10 })!;
  close(r.ev, 1000, 1e-9);
  close(r.perShare, 80, 1e-9);
  assert.ok(r.tvShareOfEv > 0.6 && r.tvShareOfEv < 0.63);
  assert.equal(dcf({ fcf: [1], wacc: 0.03, g: 0.03, netDebt: 0, shares: 1 }), null);
});

test("Gordon DDM and residual income", () => {
  close(gordonDdm({ d0: 2, g: 0.03, r: 0.08 })!.value, 41.2, 1e-9);
  assert.equal(gordonDdm({ d0: 2, g: 0.08, r: 0.08 }), null);
  close(residualIncome({ book0: 50, roe: 0.09, r: 0.09, payout: 0.4 })!.value, 50, 1e-9, "ROE = r ⇒ value = book");
  const rich = residualIncome({ book0: 50, roe: 0.18, r: 0.09, payout: 0.4 })!;
  assert.ok(rich.value > 50, "ROE > r creates value");
  // First-year residual income: (0.18 − 0.09) × 50 / 1.09
  close(rich.rows[0].pv, (0.09 * 50) / 1.09, 1e-9);
});

test("fade path holds then reaches the terminal rate", () => {
  const p = fadePath(0.2, 0.025, 10, 2);
  assert.equal(p.length, 10);
  assert.equal(p[0], 0.2);
  assert.equal(p[1], 0.2);
  close(p[9], 0.025, 1e-12);
  for (let i = 2; i < 10; i++) assert.ok(p[i] < p[i - 1]);
});

const toyCo: Fundamentals = {
  currency: "USD",
  annual: [
    { asOf: "2022-12-31", revenue: 1000, ebit: 200, ebitda: 250, da: 50, capex: 60, netIncome: 150, pretaxIncome: 190, taxProvision: 40, equity: 800, totalDebt: 300, cashAndSti: 100, currentAssets: 400, currentLiabilities: 300, longTermDebt: 250, dividendsPaid: 60, sharesOutstanding: 100 },
    { asOf: "2023-12-31", revenue: 1100, ebit: 220, ebitda: 275, da: 55, capex: 66, netIncome: 165, pretaxIncome: 209, taxProvision: 44, equity: 880, totalDebt: 300, cashAndSti: 120, currentAssets: 440, currentLiabilities: 320, longTermDebt: 250, dividendsPaid: 66, sharesOutstanding: 100 },
    { asOf: "2024-12-31", revenue: 1210, ebit: 242, ebitda: 302, da: 60, capex: 72, netIncome: 181, pretaxIncome: 230, taxProvision: 48, equity: 960, totalDebt: 300, cashAndSti: 150, currentAssets: 480, currentLiabilities: 340, longTermDebt: 250, dividendsPaid: 72, sharesOutstanding: 100 },
  ],
  quarterly: [],
  ttm: null,
};

test("snapshot, cost of capital and the DCF model on a toy company", () => {
  const a = defaultAssumptions("US", 0.04, "test");
  const s = snapshot(toyCo, 30, a)!;
  close(s.marketCap, 3000, 1e-9);
  close(s.netDebt, 150, 1e-9);
  close(s.eps!, 1.81, 1e-9);
  close(s.roe!, 181 / 920, 1e-9, "TTM NI over average equity");
  close(s.taxRate, 40 / 190, 1e-9, "median of 21.05%, 21.05%, 20.87%");
  const coc = costOfCapital(s, a, 1.0);
  close(coc.beta, 1.0, 1e-12, "Blume(1) = 1");
  close(coc.costOfEquity, 0.09, 1e-12);
  const m = dcfModel(toyCo, s, coc, a, { value: 0.1, source: "test" });
  assert.ok(m.applicable, m.reason);
  assert.ok(m.low! <= m.perShare! && m.perShare! <= m.high!, "base inside its sensitivity band");
  assert.ok(m.perShare! > 0);
  const d = m.detail as { ronic: number; reinvestmentTerminal: number; terminalGrowth: number; projection: { reinvestmentRate: number }[] };
  close(d.reinvestmentTerminal, d.terminalGrowth / d.ronic, 1e-12, "steady state reinvests g / RONIC");
  close(d.projection.at(-1)!.reinvestmentRate, d.reinvestmentTerminal, 1e-12, "the final explicit year is already at steady state");
  assert.ok(d.ronic >= coc.wacc && d.ronic <= 2 * coc.wacc);
  const fin = dcfModel(toyCo, s, coc, a, null, { financial: true });
  assert.equal(fin.applicable, false);

  const ddm = ddmModel(toyCo, s, coc, a);
  assert.ok(ddm.applicable, ddm.reason);
  const ri = residualIncomeModel(s, coc);
  assert.ok(ri.applicable && ri.perShare! > s.bookPerShare!, "ROE ≈ 19.7% > 9% ⇒ above book");
});

test("multiples, implied prices and the blend", () => {
  const a = defaultAssumptions("US", 0.04, "test");
  const s = snapshot(toyCo, 30, a)!;
  const own = computeMultiples(s, 0.1);
  close(own.pe!, 3000 / 181, 1e-9);
  close(own.peg!, own.pe! / 10, 1e-9);
  close(impliedPrice("pe", 20, s, 0.1)!, 20 * 1.81, 1e-9);
  close(impliedPrice("evEbitda", 10, s, 0.1)!, (10 * 302 - 150) / 100, 1e-9);
  const peers = [{ pe: 18, pb: 3, ps: 2.5, evEbitda: 11 }, { pe: 20, pb: 3.5, ps: 2.4, evEbitda: 10 }, { pe: 22, pb: 2.8, ps: 2.6, evEbitda: 12 }];
  const hist = historicalMultiples(toyCo, s, () => 25);
  assert.equal(hist.pe!.length, 3);
  const rel = relativeModel(s, own, peers, hist, 0.1);
  assert.ok(rel.applicable);
  assert.ok(rel.low! <= rel.perShare! && rel.perShare! <= rel.high!);
  const b = blendValuation([{ method: "dcf", applicable: true, perShare: 40, low: 35, high: 45 }, { method: "multiples", applicable: true, perShare: 30, low: 28, high: 33 }], 30, false)!;
  close(b.fairValueMid, (0.5 * 40 + 0.35 * 30) / 0.85, 1e-9);
  assert.equal(b.verdict, "cheap");
  assert.equal(verdictFor(-1), "rich");
  assert.equal(verdictFor(5), "fair");
  assert.equal(blendValuation([], 30, false), null);
});
