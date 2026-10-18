import { test } from "node:test";
import assert from "node:assert/strict";
import {
  walkForwardFolds, binFeatures, growTree, predictTree, scoreOos, clusteredIc, mlReport,
  LINEAR_LEARNERS, TREE_LEARNERS, OLS_LEARNER, LASSO_LEARNER, BOOSTING_LEARNER, CART_OPTS,
  type OosPoint,
} from "./ml";
import { buildFeatures, poolFeatures, type FeatureSet, type FeatureRow } from "./features";
import { mulberry32, normalSampler, spearman } from "./stats";
import type { Bar } from "./types";

const close = (a: number, b: number, tol: number, msg?: string) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg ?? ""} expected ${b} ± ${tol}, got ${a}`);

const day = (i: number) => new Date(Date.UTC(2018, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);

/** i.i.d. synthetic rows (horizon 1, so labels never overlap) for `symbols` names. */
function synthetic(n: number, p: number, f: (x: number[], e: number) => number, seed: number, symbols = 1): FeatureSet {
  const g = normalSampler(mulberry32(seed));
  const rows: FeatureRow[] = [];
  for (let i = 0; i < n; i++) {
    for (let s = 0; s < symbols; s++) {
      const x = Array.from({ length: p }, () => g());
      rows.push({ symbol: `S${s}`, date: day(i), x, y: f(x, g()) });
    }
  }
  rows.push({ symbol: "S0", date: day(n), x: [1, 1, ...Array(p - 2).fill(0)], y: null });
  return { names: Array.from({ length: p }, (_, j) => `x${j}`), horizon: 1, rows };
}

test("walk-forward folds are expanding, contiguous and purged", () => {
  const folds = walkForwardFolds(1000, { folds: 5, testFrac: 0.5, purge: 21 });
  assert.equal(folds.length, 5);
  assert.equal(folds[0].testStart, 500);
  assert.equal(folds[4].testEnd, 1000);
  for (let k = 0; k < 5; k++) {
    assert.equal(folds[k].trainEnd, folds[k].testStart - 21, "purge gap = horizon");
    if (k) assert.equal(folds[k].testStart, folds[k - 1].testEnd, "blocks tile the test span");
  }
  assert.deepEqual(walkForwardFolds(6, { folds: 5, testFrac: 0.5 }), []);
});

test("histogram tree finds a step and agrees with binned routing", () => {
  const g = normalSampler(mulberry32(1));
  const X = Array.from({ length: 2000 }, () => [g(), g()]);
  const y = X.map(([a]) => (a > 0.3 ? 1 : -1) + 0.1 * g());
  const B = binFeatures(X);
  assert.ok(B.edges[0].length <= 31 && B.edges[0].length > 20);
  const gain = new Float64Array(2);
  const tree = growTree(B, Int32Array.from({ length: 2000 }, (_, i) => i), Float64Array.from(y, (v) => -v), new Float64Array(2000).fill(1), { ...CART_OPTS, maxDepth: 1 }, mulberry32(2), gain);
  assert.equal(tree.feat[0], 0, "splits on the informative feature");
  close(tree.thr[0], 0.3, 0.1, "threshold near the step");
  assert.ok(gain[0] > 0 && gain[1] === 0);
  close(predictTree(tree, [2, 0]), 1, 0.1);
  close(predictTree(tree, [-2, 0]), -1, 0.1);
});

test("linear learners recover a linear signal; lasso drops noise features", () => {
  const set = synthetic(3000, 6, (x, e) => 0.5 * x[0] - 0.3 * x[1] + e, 3);
  const rep = mlReport(set, "S0", LINEAR_LEARNERS, { seed: 4 })!;
  assert.equal(rep.models.length, 3);
  for (const m of rep.models) {
    assert.ok(m.oos.passed, `${m.model} IC ${m.oos.ic} t ${m.oos.icT}`);
    assert.ok(m.oos.ic > 0.3 && m.oos.skill > 0.2, `${m.model} skill ${m.oos.skill}`);
    assert.equal(m.importance[0].feature, "x0");
    assert.equal(m.importance[0].sign, 1);
    assert.equal(m.importance[1].sign, -1);
  }
  const ols = rep.models.find((m) => m.model === "OLS")!;
  close(ols.forecast!, 0.5 - 0.3, 0.06, "forecast at x = (1, 1, 0, …)");
  const lasso = rep.models.find((m) => m.model === "Lasso")!;
  assert.ok(lasso.discarded!.length >= 3, `lasso kept ${6 - lasso.discarded!.length} features`);
  assert.ok(!lasso.discarded!.includes("x0") && !lasso.discarded!.includes("x1"));
  assert.ok(rep.best !== null);
});

test("trees capture an interaction a linear model misses", () => {
  // y depends on x1 only when x0 > 0: no linear signal on average.
  const set = synthetic(4000, 4, (x, e) => (x[0] > 0 ? x[1] : -x[1]) * 0.8 + e, 5);
  const trees = mlReport(set, "S0", TREE_LEARNERS, { seed: 6 })!;
  const linear = mlReport(set, "S0", [OLS_LEARNER], { seed: 6 })!;
  const gbm = trees.models.find((m) => m.model === "Gradient boosting")!;
  assert.ok(gbm.oos.passed && gbm.oos.ic > 0.25, `boosting IC ${gbm.oos.ic}`);
  assert.ok(Math.abs(linear.models[0].oos.ic) < 0.06, `OLS IC ${linear.models[0].oos.ic}`);
  for (const m of trees.models) assert.deepEqual(m.importance.slice(0, 2).map((i) => i.feature).sort(), ["x0", "x1"], m.model);
  assert.ok(gbm.score! >= -100 && gbm.score! <= 100);
});

test("pure noise fails validation", () => {
  const set = synthetic(1500, 5, (_, e) => e, 7, 3);
  const rep = mlReport(set, "S0", [OLS_LEARNER, LASSO_LEARNER, BOOSTING_LEARNER], { seed: 8 })!;
  for (const m of rep.models) {
    assert.ok(!(Math.abs(m.oos.ic) >= 0.06), `${m.model} IC on noise ${m.oos.ic}`);
    assert.ok(m.oos.skill < 0.01, `${m.model} skill on noise ${m.oos.skill}`);
    assert.ok(!m.oos.passed && m.notes.some((n) => n.startsWith("failed walk-forward")), m.model);
  }
  assert.equal(rep.symbols, 3);
  assert.equal(mlReport({ ...set, rows: set.rows.slice(0, 100) }, "S0", [OLS_LEARNER]), null);
});

test("IC t-stat: non-overlapping dates, clustered by date", () => {
  const g = normalSampler(mulberry32(10));
  const pts: OosPoint[] = Array.from({ length: 840 }, (_, i) => {
    const pred = g();
    return { symbol: "A", date: day(i), fold: 0, pred, bench: 0, y: 0.6 * pred + g() };
  });
  const s = scoreOos(pts, 21);
  assert.equal(s.icN, 40, "every 21st date");
  const sub = pts.filter((_, i) => i % 21 === 0);
  close(clusteredIc(sub).ic, spearman(sub.map((p) => p.pred), sub.map((p) => p.y)), 1e-12, "IC = Spearman");
  const ic = clusteredIc(sub).ic;
  close(s.icT, (ic * Math.sqrt(38)) / Math.sqrt(1 - ic * ic), 0.35 * Math.abs(s.icT), "one name per date ≈ the classic t");
  assert.ok(s.ic > 0.3 && s.passed, `IC ${s.ic} t ${s.icT}`);

  // Ten perfectly correlated copies per date are one observation, not ten.
  const copies = pts.flatMap((p) => Array.from({ length: 10 }, (_, k) => ({ ...p, symbol: `S${k}` })));
  const c = scoreOos(copies, 21);
  assert.equal(c.icClusters, 40);
  close(c.icT, s.icT, 0.05 * Math.abs(s.icT), "duplicates must not inflate t");

  // A forecast that only changes between folds (e.g. the training mean) carries no ranking signal.
  const flat = pts.map((p, i) => ({ ...p, fold: Math.floor(i / 168), pred: Math.floor(i / 168) }));
  const f = scoreOos(flat, 21);
  assert.ok(Number.isNaN(f.ic) && !f.passed);
});

test("features use only past data and label the forward return", () => {
  const g = normalSampler(mulberry32(9));
  let p = 100;
  const bars: Bar[] = Array.from({ length: 600 }, (_, i) => {
    p *= Math.exp(0.0003 + 0.015 * g());
    return { t: i, date: day(i), open: p, high: p, low: p, close: p, adjClose: p, volume: 1e6 * (1 + 0.3 * Math.abs(g())) };
  });
  const full = buildFeatures("A", bars);
  const cut = buildFeatures("A", bars.slice(0, 450));
  assert.equal(full.names.length, 14);
  assert.equal(full.rows[0].date, day(252), "first row once a full year of history exists");
  const byDate = new Map(full.rows.map((r) => [r.date, r]));
  for (const r of cut.rows) assert.deepEqual(byDate.get(r.date)!.x, r.x, `no look-ahead at ${r.date}`);
  const r0 = full.rows[0];
  close(r0.y!, Math.log(bars[252 + 21].adjClose / bars[252].adjClose), 1e-12, "label = forward 21-day log return");
  assert.equal(full.rows.filter((r) => r.y === null).length, 21, "newest 21 rows are unlabeled");
  const withIdx = buildFeatures("A", bars, { index: bars });
  assert.equal(withIdx.names.at(-1), "idx21");
  close(withIdx.rows[0].x.at(-1)!, withIdx.rows[0].x[2], 1e-12, "index = itself ⇒ idx21 = r21");
  assert.equal(poolFeatures([full, cut])!.rows.length, full.rows.length + cut.rows.length);
});
