import { test } from "node:test";
import assert from "node:assert/strict";
import { planRebalance, verdictOf, type RebalanceHolding, type RebalanceInput, type Verdict } from "./rebalance";
import type { QuantReport } from "@/lib/appwrite/schema";

const NOW = Date.parse("2026-10-23T12:00:00Z");
const recent = "2026-10-22T16:00:00Z";

const close = (a: number, b: number, tol: number, msg?: string) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg ?? ""} expected ${b}, got ${a}`);

const hold = (ticker: string, marketValue: number, qty: number, isFund = false): RebalanceHolding => ({ ticker, marketValue, qty, isFund });
const verdict = (ticker: string, direction: Verdict["direction"], extra: Partial<Verdict> = {}): Verdict => ({
  ticker, direction, composite: direction === "long" ? 40 : direction === "short" ? -40 : 0,
  confidence: 0.5, price: 100, currency: "USD", runAt: recent, ...extra,
});
// `capPct` gives every ticker in the case the active vol at which a 6% target
// caps it there (target ÷ active vol); `activeVol` overrides it.
const TARGET = 0.06;
const plan = ({ capPct = 9, ...over }: Partial<RebalanceInput> & { capPct?: number }) => {
  const tickers = [...(over.holdings ?? []).map((h) => h.ticker), ...(over.verdicts ?? []).map((v) => v.ticker)];
  const activeVol = Object.fromEntries(tickers.map((t) => [t, TARGET / (capPct / 100)]));
  return planRebalance({
    holdings: [], verdicts: [], cash: 0, targetTe: TARGET,
    currency: "USD", wholeShares: false, now: NOW, ...over,
    activeVol: { ...activeVol, ...over.activeVol },
  });
};
const trade = (p: ReturnType<typeof planRebalance>, ticker: string) => p.trades.find((t) => t.ticker === ticker);

test("a short verdict trims the position by half", () => {
  const p = plan({
    holdings: [hold("AAA", 800, 8), hold("BBB", 9_200, 92)],
    verdicts: [verdict("AAA", "short"), verdict("BBB", "neutral")],
    capPct: 100,
  });
  const t = trade(p, "AAA")!;
  assert.equal(t.action, "trim");
  assert.equal(t.shares, 4);
  close(t.value, 400, 1e-9);
  assert.match(t.reason, /trim by half/);
  assert.equal(trade(p, "BBB"), undefined, "neutral holds");
});

test("every listed name is cut to the cap, verdict or not; funds are left alone", () => {
  const p = plan({
    holdings: [hold("BIG", 3_000, 30), hold("NOVIEW", 2_000, 20), hold("MF:1", 5_000, 50, true)],
    verdicts: [verdict("BIG", "neutral")],
    capPct: 10,
  });
  close(trade(p, "BIG")!.value, 2_000, 1e-9);
  close(trade(p, "NOVIEW")!.value, 1_000, 1e-9);
  assert.equal(trade(p, "MF:1"), undefined);
  assert.deepEqual(p.unrated.map((u) => u.ticker), ["NOVIEW", "MF:1"]);
});

test("mandate cash funds new buys of the strongest unheld longs, each at its cap × confidence", () => {
  const p = plan({
    holdings: [hold("HELD", 1_000, 10)],
    verdicts: [
      verdict("HELD", "neutral"),
      verdict("WEAK", "long", { composite: 25, confidence: 0.4 }),
      verdict("STRONG", "long", { composite: 70, confidence: 0.8 }),
      verdict("MID", "long", { composite: 45, confidence: 0.6 }),
    ],
    cash: 9_000,
    capPct: 10,
  });
  assert.deepEqual(p.trades.map((t) => [t.ticker, t.action]), [["STRONG", "buy"], ["MID", "buy"], ["WEAK", "buy"]]);
  close(trade(p, "STRONG")!.value, 800, 1e-9, "cap 10% of 10k × confidence 0.8");
  close(trade(p, "MID")!.value, 600, 1e-9);
  close(trade(p, "WEAK")!.value, 400, 1e-9);
  close(p.cashAfter, 7_200, 1e-9);
});

test("the cap is target ÷ active vol: a more volatile name gets less", () => {
  const p = plan({
    verdicts: [verdict("CALM", "long", { confidence: 1 }), verdict("WILD", "long", { confidence: 1 })],
    cash: 10_000,
    activeVol: { CALM: 0.3, WILD: 0.6 },
  });
  close(trade(p, "CALM")!.value, 2_000, 1e-9, "6% ÷ 30% = 20%");
  close(trade(p, "WILD")!.value, 1_000, 1e-9, "6% ÷ 60% = 10%");
  assert.match(trade(p, "WILD")!.reason, /the 10\.0% name cap \(6\.0% target ÷ 60\.0% active vol\)/);
});

test("a name with no measured active vol is not sized: held, it holds; unheld, it isn't bought", () => {
  const p = plan({
    holdings: [hold("BIGLONG", 5_000, 50), hold("BIGSHORT", 2_000, 20)],
    verdicts: [verdict("BIGLONG", "long"), verdict("BIGSHORT", "short"), verdict("NEW", "long")],
    cash: 3_000,
    activeVol: { BIGLONG: NaN, BIGSHORT: 0, NEW: NaN },
  });
  assert.equal(trade(p, "BIGLONG"), undefined, "50% of capital, but no cap to trim to");
  assert.equal(trade(p, "NEW"), undefined);
  close(trade(p, "BIGSHORT")!.value, 1_000, 1e-9, "a short still trims by half");
  assert.ok(p.unrated.some((u) => u.ticker === "BIGLONG" && /no measured active vol/.test(u.reason)));
  assert.ok(p.notes.some((n) => n.startsWith("2 held names have no measured active vol")));
  assert.ok(p.notes.some((n) => n.startsWith("1 unheld long skipped: no measured active vol")));
});

test("adds to a held long stop at its cap", () => {
  const p = plan({
    holdings: [hold("A", 400, 4), hold("B", 400, 4)],
    verdicts: [verdict("A", "long", { confidence: 0.9 })],
    cash: 1_200,
    capPct: 50,
  });
  const a = trade(p, "A")!;
  assert.equal(a.action, "add");
  close(a.value, 0.5 * 2_000 * 0.9 - 400, 1e-9);
});

test("buys are scaled down so they never spend more than cash plus proceeds", () => {
  const p = plan({
    holdings: [hold("SHORT", 1_000, 10)],
    verdicts: [verdict("SHORT", "short"), ...["X", "Y", "Z"].map((t) => verdict(t, "long", { confidence: 1 }))],
    cash: 100,
    capPct: 50,
  });
  close(p.sellProceeds, 500, 1e-9);
  assert.ok(p.buyCost <= 600 + 1e-9);
  assert.ok(p.cashAfter >= -1e-9);
  assert.ok(p.notes.some((n) => n.startsWith("Buys scaled")));
});

test("whole shares on India, stale verdicts and foreign-priced longs are ignored", () => {
  const p = plan({
    holdings: [hold("RELIANCE", 30_000, 10)],
    verdicts: [
      verdict("RELIANCE", "short", { currency: "INR", price: 3_000 }),
      verdict("OLD", "long", { currency: "INR", runAt: "2026-10-01T00:00:00Z" }),
      verdict("ADR", "long", { currency: "USD" }),
      verdict("TCS", "long", { currency: "INR", price: 3_333, confidence: 1 }),
    ],
    cash: 70_000,
    currency: "INR",
    wholeShares: true,
  });
  const r = trade(p, "RELIANCE")!;
  assert.equal(r.shares, 7, "half is 15,000, over the 9% cap of 1L, so trim to 9,000: 21,000 at 3,000 a share");
  assert.match(r.reason, /then down to the 9\.0% name cap/);
  const tcs = trade(p, "TCS")!;
  assert.ok(Number.isInteger(tcs.shares));
  assert.equal(trade(p, "OLD"), undefined);
  assert.equal(trade(p, "ADR"), undefined);
  assert.ok(p.notes.some((n) => n.includes("no INR price")));
});

test("trades below the minimum size are dropped", () => {
  const p = plan({
    holdings: [hold("TINY", 40, 4), hold("REST", 9_960, 10)],
    verdicts: [verdict("TINY", "short")],
    capPct: 100,
  });
  assert.equal(trade(p, "TINY"), undefined, "a $20 trim is 0.2% of $10k");
});

test("verdictOf reads the ensemble payload and falls back to the row score", () => {
  const base = { ticker: "AAPL", market: "US", agent: "ensemble-combiner", stage: null, kind: "compute", summary: "", run_at: recent, cycle_id: "c" };
  const v = verdictOf({
    ...base, score: 31,
    payload_json: JSON.stringify({ data: { composite: 31, direction: "long", confidence: 0.62, price: 230.5, currency: "USD" } }),
  } as QuantReport)!;
  assert.deepEqual(v, { ticker: "AAPL", direction: "long", composite: 31, confidence: 0.62, price: 230.5, currency: "USD", runAt: recent });
  const bare = verdictOf({ ...base, score: -5, payload_json: "not json" } as QuantReport)!;
  assert.equal(bare.direction, "neutral");
  assert.equal(bare.composite, -5);
  assert.equal(verdictOf({ ...base, score: null, payload_json: null } as QuantReport), null);
});
