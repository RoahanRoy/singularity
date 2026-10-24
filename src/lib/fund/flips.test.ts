import { test } from "node:test";
import assert from "node:assert/strict";
import { flipOf } from "./flips";
import type { Verdict } from "./rebalance";

const v = (direction: Verdict["direction"], runAt: string, composite = direction === "long" ? 30 : direction === "short" ? -30 : 0): Verdict => ({
  ticker: "aaa", direction, composite, confidence: 0.5, price: 100, currency: "USD", runAt,
});
const MEMO = "2026-10-20T16:00:00Z";
const BEFORE = "2026-10-20T15:00:00Z";
const AFTER = "2026-10-23T22:00:00Z";

test("long ↔ short after the memo is a flip", () => {
  const f = flipOf(v("long", BEFORE), v("short", AFTER), MEMO);
  assert.equal(f?.ticker, "AAA");
  assert.equal(f?.basis.direction, "long");
  assert.ok(flipOf(v("short", BEFORE), v("long", AFTER), MEMO));
});

test("moves into or out of neutral are not flips", () => {
  assert.equal(flipOf(v("long", BEFORE), v("neutral", AFTER), MEMO), null);
  assert.equal(flipOf(v("neutral", BEFORE), v("short", AFTER), MEMO), null);
  assert.equal(flipOf(v("long", BEFORE), v("long", AFTER), MEMO), null);
});

test("no basis, no current, or a verdict the memo already saw is not a flip", () => {
  assert.equal(flipOf(null, v("short", AFTER), MEMO), null);
  assert.equal(flipOf(v("long", BEFORE), null, MEMO), null);
  assert.equal(flipOf(v("long", BEFORE), v("short", BEFORE), MEMO), null);
});
