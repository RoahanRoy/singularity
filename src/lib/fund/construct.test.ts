import { test } from "node:test";
import assert from "node:assert/strict";
import { construct, type ConstructAsset } from "./construct";

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
const T = 252;
const g = rng(7);
const index = Array.from({ length: T }, () => 0.012 * g());
const asset = (ticker: string, beta: number, idioVol: number, alpha: number, lo = 0, hi = 1): ConstructAsset => ({
  ticker, alpha, lo, hi, returns: index.map((r) => beta * r + idioVol * g()),
});
const core = (lo = 0) => asset("CORE", 1, 0.0003, 0, lo);
const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

test("with no view the book holds the core: index exposure at the least TE", () => {
  const r = construct({ assets: [core(), asset("AAA", 1.2, 0.02, 0)], index, targetTe: 0.06 })!;
  assert.equal(r.binding, "bounds");
  assert.ok(r.weights[0] > 0.97, `core ${r.weights[0]}`);
  assert.ok(r.te < 0.01, `te ${r.te}`);
});

test("views spend the TE budget, and no more: TE meets the target", () => {
  const r = construct({
    assets: [core(), asset("AAA", 1.1, 0.02, 0.1), asset("BBB", 0.9, 0.02, 0.05), asset("CCC", 1, 0.02, -0.05)],
    index, targetTe: 0.06,
  })!;
  assert.equal(r.binding, "target");
  assert.ok(Math.abs(r.te - 0.06) < 1e-4, `te ${r.te}`);
  assert.ok(sum(r.weights) <= 1 + 1e-9);
  assert.ok(r.weights[1] > r.weights[2], "more α at the same risk sizes larger");
  assert.ok(r.weights[3] < 1e-6, "a negative view isn't held long");
  assert.ok(r.weights[0] > 0.5, "the core carries the index exposure");
});

test("the horizon α is quoted over cancels: weights don't change with its scale", () => {
  const assets = [core(), asset("AAA", 1.1, 0.02, 0.1), asset("BBB", 0.9, 0.025, 0.04)];
  const a = construct({ assets, index, targetTe: 0.05 })!;
  const b = construct({ assets: assets.map((x) => ({ ...x, alpha: x.alpha * 12 })), index, targetTe: 0.05 })!;
  a.weights.forEach((w, i) => assert.ok(Math.abs(w - b.weights[i]) < 1e-4, `${w} vs ${b.weights[i]}`));
});

test("caps and floors hold; capped views leave TE under target", () => {
  const r = construct({
    assets: [core(0.2), asset("AAA", 1, 0.02, 0.2, 0, 0.03), asset("BBB", 1, 0.02, 0.2, 0.05, 0.06)],
    index, targetTe: 0.06,
  })!;
  assert.equal(r.binding, "bounds");
  assert.ok(r.weights[0] >= 0.2 - 1e-12);
  assert.ok(Math.abs(r.weights[1] - 0.03) < 1e-6);
  assert.ok(r.weights[2] >= 0.05 - 1e-12 && r.weights[2] <= 0.06 + 1e-12);
  assert.ok(r.te < 0.06);
});

test("without a core, a book that can't reach the target holds its least-TE mix", () => {
  const r = construct({ assets: [asset("AAA", 0.5, 0.01, 0.1, 0, 0.1)], index, targetTe: 0.06 })!;
  assert.equal(r.binding, "floor");
  assert.ok(r.te > 0.06);
  assert.ok(Math.abs(r.weights[0] - 0.1) < 1e-6, "the most index exposure it may hold");
});

test("marginal TE is the gradient of TE", () => {
  const assets = [core(), asset("AAA", 1.1, 0.02, 0.1), asset("BBB", 0.9, 0.02, 0.05)];
  const r = construct({ assets, index, targetTe: 0.06 })!;
  const h = 1e-6;
  const te = (x: number[]) => {
    const a = index.map((ri, t) => x.reduce((s, xi, i) => s + xi * assets[i].returns[t], 0) - ri);
    const m = a.reduce((s, v) => s + v, 0) / T;
    return Math.sqrt((a.reduce((s, v) => s + (v - m) ** 2, 0) / (T - 1)) * 252);
  };
  r.weights.forEach((_, i) => {
    const up = r.weights.slice(); up[i] += h;
    assert.ok(Math.abs((te(up) - te(r.weights)) / h - r.marginalTe[i]) < 1e-3);
  });
});

test("infeasible floors or mismatched history return null", () => {
  assert.equal(construct({ assets: [asset("AAA", 1, 0.02, 0.1, 0.6), asset("BBB", 1, 0.02, 0.1, 0.6)], index, targetTe: 0.06 }), null);
  assert.equal(construct({ assets: [{ ...asset("AAA", 1, 0.02, 0.1), returns: [0.01] }], index, targetTe: 0.06 }), null);
});
