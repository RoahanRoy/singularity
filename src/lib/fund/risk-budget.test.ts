import { test } from "node:test";
import assert from "node:assert/strict";
import { dayLossLimit, gateTrade, lagLimit, largestAdd, Z99 } from "./risk-budget";

const close = (a: number, b: number, tol: number, msg?: string) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg ?? ""} expected ${b}, got ${a}`);

test("day-loss and lag limits scale with the target", () => {
  close(Z99, 2.3263, 1e-3);
  close(dayLossLimit(0.06, 0.127), (Z99 * 0.187) / Math.sqrt(252), 1e-12);
  assert.equal(lagLimit(0.06, 0), 0);
  close(lagLimit(0.06, 252), Z99 * 0.06, 1e-12, "one year is the target's 99% band");
  close(lagLimit(0.06, 63), Z99 * 0.06 * 0.5, 1e-12, "a quarter is half the band");
});

test("gate: over target only blocks when the trade raises TE", () => {
  const base = { target: 0.06, nameWeightAfter: 0.05, nameActiveVol: 0.3 };
  assert.deepEqual(gateTrade({ ...base, teBefore: 0.127, teAfter: 0.11 }), [], "all cash, a buy lowers TE");
  assert.deepEqual(gateTrade({ ...base, teBefore: 0.04, teAfter: 0.059 }), [], "under target");
  assert.equal(gateTrade({ ...base, teBefore: 0.05, teAfter: 0.07 }).length, 1, "crosses the target");
  assert.equal(gateTrade({ ...base, teBefore: 0.08, teAfter: 0.09 }).length, 1, "over and rising");
  assert.deepEqual(gateTrade({ ...base, teBefore: 0.08, teAfter: 0.08 }), [], "unchanged");
});

test("gate: one name may not use more than the whole target", () => {
  const b = gateTrade({ target: 0.06, teBefore: 0.127, teAfter: 0.1, nameWeightAfter: 0.25, nameActiveVol: 0.3 });
  assert.equal(b.length, 1);
  assert.match(b[0], /own active risk 7\.50%/);
});

test("largestAdd: the own-risk cap binds while deploying from cash", () => {
  // TE falls as cash is deployed: never the binding constraint here.
  const add = largestAdd((w) => 0.127 - 0.1 * w, { target: 0.06, teBefore: 0.127, nameWeightBefore: 0, nameActiveVol: 0.3, wMax: 1 });
  close(add, 0.2, 1e-9);
  const held = largestAdd((w) => 0.127 - 0.1 * w, { target: 0.06, teBefore: 0.127, nameWeightBefore: 0.15, nameActiveVol: 0.3, wMax: 1 });
  close(held, 0.05, 1e-9, "a held name only tops up to the cap");
  assert.equal(largestAdd(() => 0.05, { target: 0.06, teBefore: 0.05, nameWeightBefore: 0.25, nameActiveVol: 0.3, wMax: 1 }), 0);
});

test("largestAdd: the TE budget binds under target, and cash caps it", () => {
  // Convex TE: sqrt(0.04² + (0.3w)²) reaches 6% at w = sqrt(0.06²−0.04²)/0.3.
  const teAt = (w: number) => Math.hypot(0.04, 0.3 * w);
  const add = largestAdd(teAt, { target: 0.06, teBefore: 0.04, nameWeightBefore: 0, nameActiveVol: 0.3, wMax: 1 });
  close(add, Math.sqrt(0.06 ** 2 - 0.04 ** 2) / 0.3, 1e-5);
  assert.ok(teAt(add) <= 0.06 + 1e-12);
  close(largestAdd(teAt, { target: 0.06, teBefore: 0.04, nameWeightBefore: 0, nameActiveVol: 0.3, wMax: 0.05 }), 0.05, 1e-12, "cash");
});

test("a size computed at the one-name cap clears the gate", () => {
  const target = 0.06, vol = 0.1504; // (0.06 / 0.1504) * 0.1504 > 0.06 in floating point
  const add = largestAdd(() => 0.1, { target, teBefore: 0.1367, nameWeightBefore: 0, nameActiveVol: vol, wMax: 1 });
  assert.deepEqual(gateTrade({ target, teBefore: 0.1367, teAfter: 0.1, nameWeightAfter: add, nameActiveVol: vol }), []);
});
