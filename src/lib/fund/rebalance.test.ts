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
const plan = (over: Partial<RebalanceInput>) =>
  planRebalance({
    holdings: [], verdicts: [], cash: 0, maxNames: 20, maxNameWeightPct: 9,
    currency: "USD", wholeShares: false, now: NOW, ...over,
  });
const trade = (p: ReturnType<typeof planRebalance>, ticker: string) => p.trades.find((t) => t.ticker === ticker);

test("a short verdict trims the position by half", () => {
  const p = plan({
    holdings: [hold("AAA", 800, 8), hold("BBB", 9_200, 92)],
    verdicts: [verdict("AAA", "short"), verdict("BBB", "neutral")],
    maxNameWeightPct: 100,
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
    maxNameWeightPct: 10,
  });
  close(trade(p, "BIG")!.value, 2_000, 1e-9);
  close(trade(p, "NOVIEW")!.value, 1_000, 1e-9);
  assert.equal(trade(p, "MF:1"), undefined);
  assert.deepEqual(p.unrated.map((u) => u.ticker), ["NOVIEW", "MF:1"]);
});

test("mandate cash funds new buys of the strongest unheld longs, up to the name limit", () => {
  const p = plan({
    holdings: [hold("HELD", 1_000, 10)],
    verdicts: [
      verdict("HELD", "neutral"),
      verdict("WEAK", "long", { composite: 25, confidence: 0.4 }),
      verdict("STRONG", "long", { composite: 70, confidence: 0.8 }),
      verdict("MID", "long", { composite: 45, confidence: 0.6 }),
    ],
    cash: 9_000,
    maxNames: 3,
    maxNameWeightPct: 10,
  });
  assert.equal(p.openSlots, 2);
  assert.deepEqual(p.trades.map((t) => [t.ticker, t.action]), [["STRONG", "buy"], ["MID", "buy"]]);
  close(trade(p, "STRONG")!.value, 800, 1e-9, "cap 10% of 10k × confidence 0.8");
  close(trade(p, "MID")!.value, 600, 1e-9);
  assert.equal(p.longsBlocked, 1);
  assert.ok(p.notes.some((n) => n.includes("3-name limit")));
  close(p.cashAfter, 7_600, 1e-9);
});

test("a full book gets no new names, only adds to the longs it holds", () => {
  const p = plan({
    holdings: [hold("A", 400, 4), hold("B", 400, 4)],
    verdicts: [verdict("A", "long", { confidence: 0.9 }), verdict("NEW", "long")],
    cash: 1_200,
    maxNames: 2,
    maxNameWeightPct: 50,
  });
  assert.equal(p.openSlots, 0);
  assert.equal(trade(p, "NEW"), undefined);
  const a = trade(p, "A")!;
  assert.equal(a.action, "add");
  close(a.value, 0.5 * 2_000 * 0.9 - 400, 1e-9);
});

test("buys are scaled down so they never spend more than cash plus proceeds", () => {
  const p = plan({
    holdings: [hold("SHORT", 1_000, 10)],
    verdicts: [verdict("SHORT", "short"), ...["X", "Y", "Z"].map((t) => verdict(t, "long", { confidence: 1 }))],
    cash: 100,
    maxNameWeightPct: 50,
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
  assert.match(r.reason, /then down to the 9% name cap/);
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
    maxNameWeightPct: 100,
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
