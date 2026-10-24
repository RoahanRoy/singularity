import { test } from "node:test";
import assert from "node:assert/strict";
import { planBook, type PlanInput, type View } from "./plan";
import type { Bar } from "../quant/types";

// Deterministic Gaussian returns (mulberry32 + Box-Muller).
function rng(seed: number) {
  let s = seed >>> 0;
  const u = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return () => Math.sqrt(-2 * Math.log(u() || 1e-12)) * Math.cos(2 * Math.PI * u());
}
const W = 120;
const g = rng(11);
const day = (i: number) => new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
const idxRets = Array.from({ length: W }, () => 0.012 * g());
const barsOf = (rs: readonly number[], start = 100, from = 0): Bar[] => {
  let p = start;
  const out: Bar[] = [{ t: 0, date: day(from), open: p, high: p, low: p, close: p, adjClose: p, volume: 0 }];
  rs.forEach((r, i) => {
    p *= 1 + r;
    out.push({ t: 0, date: day(from + i + 1), open: p, high: p, low: p, close: p, adjClose: p, volume: 0 });
  });
  return out;
};
const index = barsOf(idxRets);
const name = (beta: number, idio: number) => barsOf(idxRets.map((r) => beta * r + idio * g()));
const coreBars = name(1, 0.0003);
const view = (direction: View["direction"], upsidePct: number | null, confidence = 0.6): View => ({
  direction, composite: direction === "long" ? 40 : direction === "short" ? -40 : 0, confidence, upsidePct,
});
const base = (over: Partial<PlanInput>): PlanInput => ({
  book: "fund", nav: 100_000, holdings: [], ideas: [], views: new Map(),
  core: { ticker: "SPY", price: 500, bars: coreBars }, index, window: W, targetTe: 0.06,
  wholeShares: true, sellsNames: false, ...over,
});

test("an all-cash book buys the core, and its ideas within their caps", () => {
  const r = planBook(base({
    ideas: [{ ticker: "aaa", qty: 0, value: 0, price: 50, bars: name(1.1, 0.02) }],
    views: new Map([["AAA", view("long", 25)]]),
  }));
  assert.ok("plan" in r);
  const { plan } = r;
  const core = plan.lines.find((l) => l.role === "core")!;
  const aaa = plan.lines.find((l) => l.ticker === "AAA")!;
  assert.ok(core.to > 0.5, `core ${core.to}`);
  assert.ok(aaa.to > 0 && aaa.to <= aaa.cap! + 1e-9);
  for (const l of plan.lines) assert.equal(l.shares, Math.floor(l.shares), "whole shares");
  const spent = plan.lines.reduce((s, l) => s + l.value, 0);
  assert.ok(spent <= plan.nav, "never spends more than NAV");
  assert.ok(plan.lines.every((l) => l.toRounded <= l.to + 1e-12), "rounding never overshoots");
});

test("a book that doesn't sell names keeps a held name the quant turned on", () => {
  const r = planBook(base({
    holdings: [{ ticker: "BBB", qty: 200, value: 10_000, price: 50, bars: name(0.9, 0.02) }],
    views: new Map([["BBB", view("short", -20)]]),
  }));
  assert.ok("plan" in r);
  assert.equal(r.plan.lines.some((l) => l.ticker === "BBB"), false);
  assert.match(r.plan.fixed.find((f) => f.ticker === "BBB")!.reason, /doesn't sell names/);
  assert.ok(r.plan.after.some((a) => a.ticker === "BBB" && a.qty === 200));
});

test("a book that sells names trims one with a negative view", () => {
  const r = planBook(base({
    book: "advisory", sellsNames: true, wholeShares: false,
    holdings: [{ ticker: "BBB", qty: 200, value: 10_000, price: 50, bars: name(0.9, 0.02) }],
    views: new Map([["BBB", view("short", -20)]]),
  }));
  assert.ok("plan" in r);
  const bbb = r.plan.lines.find((l) => l.ticker === "BBB")!;
  assert.ok(bbb.to < 1e-6 && bbb.shares === -200, `to ${bbb.to}, shares ${bbb.shares}`);
});

test("held names without history or a view stay as they are, and say why", () => {
  const r = planBook(base({
    holdings: [
      { ticker: "NEW", qty: 10, value: 1_000, price: 100, bars: barsOf(idxRets.slice(-20), 100, W - 20) },
      { ticker: "OLD", qty: 10, value: 1_000, price: 100, bars: name(1, 0.02) },
    ],
  }));
  assert.ok("plan" in r);
  assert.match(r.plan.fixed.find((f) => f.ticker === "NEW")!.reason, /unmeasured/);
  assert.match(r.plan.fixed.find((f) => f.ticker === "OLD")!.reason, /no fresh quant view/);
  assert.equal(r.plan.lines.filter((l) => l.role === "name").length, 0);
});

test("ideas without a quote or a buy case, and a core without history, are skipped", () => {
  const r = planBook(base({
    core: { ticker: "SPY", price: 500, bars: coreBars.slice(-10) },
    ideas: [
      { ticker: "NOQ", qty: 0, value: 0, price: null, bars: name(1, 0.02) },
      { ticker: "RICH", qty: 0, value: 0, price: 10, bars: name(1, 0.02) },
    ],
    views: new Map([["NOQ", view("long", 10)], ["RICH", view("long", -5)]]),
  }));
  assert.ok("plan" in r);
  const why = Object.fromEntries(r.plan.skipped.map((s) => [s.ticker, s.reason]));
  assert.equal(why.NOQ, "no live quote");
  assert.match(why.RICH, /valuation upside/);
  assert.match(why.SPY, /history/);
});

test("no NAV or a short index history is a skip, not a plan", () => {
  assert.ok("skip" in planBook(base({ nav: 0 })));
  assert.ok("skip" in planBook(base({ index: index.slice(-10) })));
});
