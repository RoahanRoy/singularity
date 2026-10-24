import { test } from "node:test";
import assert from "node:assert/strict";
import { affordableQty, coreSellFor, coreTargetWeight, coreTrade } from "./core";
import type { PlanLine } from "./plan";

const line = (over: Partial<PlanLine>): PlanLine => ({
  ticker: "X", role: "name", from: 0, to: 0, toRounded: 0, alpha: 0, marginalTe: 0, cap: null, activeVol: null,
  shares: 0, price: 100, value: 0, why: "", ...over,
});

test("a name buy spends cash, then the fewest core shares that cover the rest", () => {
  const core = { qty: 100, price: 500 };
  assert.equal(coreSellFor(3_000, 5_000, core), 0, "cash covers it");
  assert.equal(coreSellFor(6_200, 5_000, core), 3, "1,200 short → 3 shares of 500");
  assert.equal(coreSellFor(6_000, 5_000, core), 2, "exactly 2 shares");
  assert.equal(coreSellFor(1e9, 0, core), 100, "never more than the core held");
  assert.equal(coreSellFor(6_000, 5_000, null), 0);
});

test("what a buy can afford counts the whole core", () => {
  assert.equal(affordableQty(100, 250, null), 2);
  assert.equal(affordableQty(100, 250, { qty: 10, price: 500 }), 52);
  assert.equal(affordableQty(0, 1_000, null), 0);
});

test("the core's target carries the plan's pending name buys", () => {
  const plan = {
    nav: 100_000,
    lines: [
      line({ ticker: "SPY", role: "core", to: 0.6 }),
      line({ ticker: "AAA", to: 0.2, value: 20_000, shares: 200 }),
      line({ ticker: "BBB", to: 0.05, value: -1_000, shares: -10 }),
    ],
  };
  assert.ok(Math.abs(coreTargetWeight(plan)! - 0.8) < 1e-12);
  assert.equal(coreTargetWeight({ nav: 100_000, lines: plan.lines.slice(1) }), null);
});

test("the core trade buys within cash and sells within what it holds", () => {
  assert.equal(coreTrade(0.8, 100_000, 500, 100, 50_000), 60, "160 wanted, 100 held");
  assert.equal(coreTrade(0.8, 100_000, 500, 100, 10_000), 20, "cash buys 20");
  assert.equal(coreTrade(0.5, 100_000, 500, 160, 0), -60);
  assert.equal(coreTrade(0, 100_000, 500, 40, 0), -40);
  assert.equal(coreTrade(0.8, 100_000, 500, 160, 0), 0);
});
