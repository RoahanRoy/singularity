import { test } from "node:test";
import assert from "node:assert/strict";
import { cagr, ratiosFor, piotroski, altmanZ, beneishM, screen, forensic, growth } from "./fundamentals";
import type { FinRow, Fundamentals } from "./types";

const close = (a: number, b: number, tol: number, msg?: string) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg ?? ""} expected ${b}, got ${a}`);

const y1: FinRow = {
  asOf: "2023-12-31", revenue: 1000, costOfRevenue: 600, grossProfit: 400, sga: 150, ebit: 200, ebitda: 250, da: 50,
  netIncome: 120, pretaxIncome: 160, taxProvision: 40, interestExpense: 20, cfo: 170, capex: 60,
  totalAssets: 1500, currentAssets: 600, currentLiabilities: 400, inventory: 100, receivables: 150, payables: 90,
  cash: 100, totalDebt: 400, longTermDebt: 350, totalLiabilities: 900, equity: 600, retainedEarnings: 300, netPpe: 500,
  sharesOutstanding: 100,
};
const y2: FinRow = {
  asOf: "2024-12-31", revenue: 1150, costOfRevenue: 670, grossProfit: 480, sga: 160, ebit: 250, ebitda: 305, da: 55,
  netIncome: 160, pretaxIncome: 210, taxProvision: 50, interestExpense: 18, cfo: 220, capex: 65,
  totalAssets: 1550, currentAssets: 680, currentLiabilities: 400, inventory: 105, receivables: 160, payables: 95,
  cash: 150, totalDebt: 350, longTermDebt: 300, totalLiabilities: 850, equity: 700, retainedEarnings: 400, netPpe: 510,
  sharesOutstanding: 99,
};
const co: Fundamentals = { currency: "USD", annual: [y1, y2], quarterly: [], ttm: null };

test("CAGR", () => {
  close(cagr(100, 121, 2)!, 0.1, 1e-12);
  assert.equal(cagr(-5, 10, 2), null);
});

test("DuPont identity: ROE = NM × AT × EM", () => {
  const r = ratiosFor(y2, y1);
  assert.ok(r.dupont);
  close(r.dupont!.roe, r.roe!, 1e-12);
  close(r.roe!, 160 / 650, 1e-12, "average equity");
  close(r.currentRatio!, 1.7, 1e-12);
  close(r.quickRatio!, (680 - 105) / 400, 1e-12);
  close(r.interestCoverage!, 250 / 18, 1e-12);
  close(r.dso!, (155 / 1150) * 365, 1e-9);
  close(r.ccc!, r.dio! + r.dso! - r.dpo!, 1e-12);
  close(r.accrualsRatio!, (160 - 220) / 1525, 1e-12);
  close(r.fcfToNetIncome!, (220 - 65) / 160, 1e-12);
});

test("Piotroski: an improving company scores 9/9", () => {
  const p = piotroski(co)!;
  assert.equal(p.available, 9);
  assert.equal(p.score, 9, JSON.stringify(p.signals));
});

test("Altman Z matches the formula and zones", () => {
  const z = altmanZ(y2, 2000)!;
  const want = 1.2 * (280 / 1550) + 1.4 * (400 / 1550) + 3.3 * (250 / 1550) + 0.6 * (2000 / 850) + 1.0 * (1150 / 1550);
  close(z.z, want, 1e-12);
  assert.equal(z.zone, "safe");
  const distressed = altmanZ({ ...y2, retainedEarnings: -800, ebit: -50, workingCapital: -200 }, 100)!;
  assert.equal(distressed.zone, "distress");
});

test("Beneish M: an unchanged company is −2.48 and not flagged", () => {
  const b = beneishM({ ...y1, asOf: "2024-12-31", netIncome: y1.cfo }, y1)!;
  close(b.m, -2.48, 1e-9);
  assert.equal(b.flagged, false);
  const aggressive = beneishM({ ...y2, receivables: 400, netIncome: 300, cfo: 50 }, y1)!;
  assert.ok(aggressive.flagged, `M=${aggressive.m}`);
});

test("screen and forensic verdicts", () => {
  const s = screen(co, 2000, [], { financial: false });
  assert.equal(s.verdict, "pass", JSON.stringify(s.redFlags));
  assert.ok(s.coverage >= 0.5);
  assert.equal(growth(co).years, 1);
  const bad: Fundamentals = { ...co, annual: [y1, { ...y2, netIncome: -50, cfo: -20, ebit: -30, ebitda: 10, retainedEarnings: -500, totalDebt: 900, cash: 10, interestExpense: 60 }] };
  const sb = screen(bad, 100, [], { financial: false });
  assert.equal(sb.verdict, "fail", JSON.stringify(sb.redFlags));
  const thin: Fundamentals = { currency: null, annual: [{ asOf: "2024-12-31", revenue: 10 }], quarterly: [], ttm: null };
  assert.equal(screen(thin, 100, [], { financial: false }).verdict, "insufficient");
  const fx = forensic(co);
  assert.equal(fx.flags.length, 0, JSON.stringify(fx.flags));
});
