import { test } from "node:test";
import assert from "node:assert/strict";
import { rankIdeas, upsideOf } from "./ideas";
import type { Verdict } from "./rebalance";

const NOW = Date.parse("2026-10-24T12:00:00Z");
const H = 3_600_000;
type V = Verdict & { upsidePct?: number | null };
const v = (ticker: string, direction: Verdict["direction"], composite: number, confidence: number, hoursAgo = 2, upsidePct: number | null = 10): V => ({
  ticker, direction, composite, confidence, price: 100, currency: "USD", runAt: new Date(NOW - hoursAgo * H).toISOString(), upsidePct,
});
const rank = (verdicts: V[], held: string[] = [], universe = ["AAA", "BBB", "CCC", "DDD"]) =>
  rankIdeas({ verdicts, universe, held, now: NOW, maxAgeMs: 36 * H }).ideas;

test("ideas are unheld universe longs ranked by composite × confidence", () => {
  const out = rank([v("AAA", "long", 30, 0.9), v("BBB", "long", 60, 0.3), v("CCC", "long", 25, 0.5)]);
  assert.deepEqual(out.map((i) => i.ticker), ["AAA", "BBB", "CCC"]);
  assert.equal(out[0].edge, 27);
});

test("neutral, short, held and off-universe names are not ideas", () => {
  const out = rank(
    [v("AAA", "neutral", 10, 0.9), v("BBB", "short", -40, 0.9), v("CCC", "long", 40, 0.5), v("ZZZ", "long", 90, 0.9)],
    ["ccc"],
  );
  assert.deepEqual(out, []);
});

test("only the newest fresh verdict per name counts", () => {
  const out = rank([v("AAA", "long", 50, 0.8, 30), v("AAA", "neutral", 5, 0.8, 1), v("BBB", "long", 50, 0.8, 40)]);
  assert.deepEqual(out, []);
});

test("a long the valuation calls overpriced, or can't value, is not an idea", () => {
  const r = rankIdeas({
    verdicts: [v("AAA", "long", 30, 0.5, 2, 22.5), v("BBB", "long", 60, 0.9, 2, -14.7), v("CCC", "long", 40, 0.5, 2, null), v("DDD", "long", 20, 0.5, 2, 0)],
    universe: ["AAA", "BBB", "CCC", "DDD"], held: [], now: NOW, maxAgeMs: 36 * H,
  });
  assert.deepEqual(r.ideas.map((i) => [i.ticker, i.upsidePct]), [["AAA", 22.5], ["DDD", 0]]);
  assert.deepEqual(r.excluded, [
    { ticker: "BBB", reason: "valuation upside -14.7%" },
    { ticker: "CCC", reason: "no valuation blend" },
  ]);
});

test("upsideOf reads the blend from an ensemble payload", () => {
  assert.equal(upsideOf({ blend: { impliedUpsidePct: -4 } }), -4);
  assert.equal(upsideOf({ blend: null }), null);
  assert.equal(upsideOf(null), null);
});
