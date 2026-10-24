import { test } from "node:test";
import assert from "node:assert/strict";
import { ledoitWolf, portfolioRisk, type RiskHolding } from "./portfolio-risk";
import { mulberry32, normalSampler } from "./stats";
import type { Bar } from "./types";

const close = (a: number, b: number, tol: number, msg?: string) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg ?? ""} expected ${b}, got ${a}`);

/** Weekday dates from `start`, n of them. */
function weekdays(start: string, n: number): string[] {
  const out: string[] = [];
  const d = new Date(`${start}T00:00:00Z`);
  while (out.length < n) {
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

const toBars = (dates: readonly string[], rets: readonly number[], volume = 1000): Bar[] => {
  let px = 100;
  return dates.map((date, i) => {
    if (i > 0) px *= 1 + rets[i - 1];
    return { t: i, date, open: px, high: px, low: px, close: px, adjClose: px, volume };
  });
};

const gauss = normalSampler(mulberry32(7));
const N_DAYS = 1500;
const dates = weekdays("2019-01-01", N_DAYS);
const mkt = Array.from({ length: N_DAYS - 1 }, () => 0.01 * gauss());
const idio = () => Array.from({ length: N_DAYS - 1 }, () => 0.01 * gauss());
const index = toBars(dates, mkt);
const last = (bars: Bar[]) => bars[bars.length - 1].adjClose;

test("Ledoit-Wolf: little shrinkage with plenty of data, more with little", () => {
  const big = Array.from({ length: 5000 }, () => [gauss(), 0.5 * gauss()]);
  const lw = ledoitWolf(big);
  assert.ok(lw.shrinkage < 0.02, `shrinkage ${lw.shrinkage}`);
  close(lw.cov[0][0], 1, 0.06);
  close(lw.cov[1][1], 0.25, 0.02);
  const thin = Array.from({ length: 20 }, () => Array.from({ length: 15 }, () => gauss()));
  assert.ok(ledoitWolf(thin).shrinkage > 0.2, "15 names on 20 days shrinks hard");
  assert.deepEqual(ledoitWolf([]), { cov: [], shrinkage: 0 });
});

test("a book holding the index is the index: beta 1, no tracking error", () => {
  const h: RiskHolding = { ticker: "IDX", qty: 1, price: last(index), bars: index };
  const r = portfolioRisk({ nav: last(index), holdings: [h], index, window: 252, advWindow: 20, stressYears: [] })!;
  close(r.beta, 1, 1e-9);
  close(r.tracking_error, 0, 1e-9);
  close(r.cash_weight, 0, 1e-12);
  close(r.names[0].risk_share, 1, 1e-9);
  close(r.var95.parametric, 1.6449 * r.index_vol / Math.sqrt(252), 2e-4);
});

test("half cash halves beta, VaR and vol; risk shares and TE shares close to 1", () => {
  const a = toBars(dates, mkt.map((m, i) => 1.2 * m + idio()[i]));
  const b = toBars(dates, mkt.map((m, i) => 0.6 * m + idio()[i]));
  const nav = 2 * (last(a) + last(b));
  const holdings = [
    { ticker: "A", qty: 1, price: last(a), bars: a },
    { ticker: "B", qty: 1, price: last(b), bars: b },
  ];
  const r = portfolioRisk({ nav, holdings, index, window: 252, advWindow: 20, stressYears: [] })!;
  close(r.cash_weight, 0.5, 1e-12);
  const wA = last(a) / nav, wB = last(b) / nav;
  close(r.beta, wA * r.names.find((n) => n.ticker === "A")!.beta + wB * r.names.find((n) => n.ticker === "B")!.beta, 1e-9);
  close(r.names.reduce((s, n) => s + n.risk_share, 0), 1, 1e-9);
  close(r.names.reduce((s, n) => s + n.te_share, 0) + r.index_te_share, 1, 1e-9);
  assert.ok(r.es95.parametric > r.var95.parametric && r.var99.parametric > r.var95.parametric);
  assert.ok(r.es95.historical >= r.var95.historical);
  assert.ok(r.tracking_error > 0);
});

test("an all-cash book has no risk but the whole index's tracking error", () => {
  const r = portfolioRisk({ nav: 10_000, holdings: [], index, window: 252, advWindow: 20, stressYears: [2020] })!;
  assert.equal(r.var95.parametric, 0);
  assert.equal(r.var95.historical, 0);
  assert.equal(r.beta, 0);
  close(r.tracking_error, r.index_vol, 1e-9);
  assert.equal(r.stress[0].book_return, 0);
  assert.equal(r.stress[0].covered_weight, 0);
});

test("a name listed inside the window is unmeasured, not proxied", () => {
  const late = toBars(dates.slice(-100), idio());
  const r = portfolioRisk({
    nav: 1000,
    holdings: [{ ticker: "NEW", qty: 2, price: last(late), bars: late }],
    index, window: 252, advWindow: 20, stressYears: [],
  })!;
  assert.equal(r.names.length, 0);
  assert.equal(r.unmeasured[0].ticker, "NEW");
  close(r.unmeasured_weight, (2 * last(late)) / 1000, 1e-12);
  assert.equal(r.var95.parametric, 0);
});

test("liquidity is shares over average volume; gaps carry forward and are counted", () => {
  const bars = toBars(dates, idio(), 500).filter((_, i) => i !== N_DAYS - 3);
  const r = portfolioRisk({
    nav: 1e6,
    holdings: [{ ticker: "X", qty: 1500, price: last(bars), bars }],
    index, window: 252, advWindow: 20, stressYears: [],
  })!;
  close(r.names[0].adv_days!, 3, 1e-12);
  assert.equal(r.names[0].missing_days, 1);
});

test("stress replay runs today's book over the index's in-year peak-to-trough", () => {
  // Index: drifts up, then −30% over ten sessions in 2020, then recovers.
  const crashAt = dates.findIndex((d) => d >= "2020-02-20");
  const path = mkt.map((_, i) => (i < crashAt ? 0.0001 : i < crashAt + 10 ? -0.0351 : i === crashAt + 10 ? 0.05 : 0));
  const ix = toBars(dates, path);
  const stock = toBars(dates, path.map((r) => 2 * r));
  const r = portfolioRisk({
    nav: 2 * last(stock),
    holdings: [{ ticker: "S", qty: 1, price: last(stock), bars: stock }],
    index: ix, window: 252, advWindow: 20, stressYears: [2020, 2022],
  })!;
  assert.equal(r.stress.length, 1, "no 2022 decline in this index");
  const s = r.stress[0];
  assert.equal(s.peak, dates[crashAt]);
  assert.equal(s.trough, dates[crashAt + 10]);
  close(s.index_return, Math.pow(1 - 0.0351, 10) - 1, 1e-9);
  close(s.book_return, 0.5 * (Math.pow(1 - 0.0702, 10) - 1), 1e-9);
  close(s.covered_weight, 0.5, 1e-12);
  close(r.names[0].stress["2020"]!, Math.pow(1 - 0.0702, 10) - 1, 1e-9);
});
