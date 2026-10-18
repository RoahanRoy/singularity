/**
 * Machine-learning forecasters for the forward 1-month return, scored the
 * honest way: expanding walk-forward folds over the last half of the
 * history, with a purge gap equal to the label horizon so no training label
 * overlaps a test date. A model whose out-of-sample information coefficient
 * (rank correlation of forecast and outcome) isn't positive and significant
 * fails validation and gets no weight downstream. On daily stock data that
 * is the usual result, and the report says so.
 *
 *   Linear: OLS, ridge, lasso (penalty chosen on an inner purged split by
 *           the one-standard-error rule, which prefers the simpler model)
 *   Trees:  CART, random forest, gradient boosting (XGBoost-style
 *           second-order splits with an L2 leaf penalty), all grown on
 *           32-bin feature histograms
 */

import { ridge, lasso, columnStats, mean, std, rank, percentileOf, mulberry32, quantileSorted, type Rng, type LinearModel } from "./stats";
import type { FeatureSet, FeatureRow } from "./features";

// ── Walk-forward folds ──────────────────────────────────────────────────────

export type Fold = { trainEnd: number; testStart: number; testEnd: number };

/**
 * Expanding-window folds over sorted date indices 0..nDates−1. The last
 * `testFrac` of dates is cut into `folds` consecutive test blocks; each block
 * trains on dates [0, testStart − purge).
 */
export function walkForwardFolds(nDates: number, opts: { folds?: number; testFrac?: number; purge?: number } = {}): Fold[] {
  const k = opts.folds ?? 5, frac = opts.testFrac ?? 0.5, purge = opts.purge ?? 0;
  const first = Math.floor(nDates * (1 - frac));
  const span = nDates - first;
  if (k < 1 || span < k) return [];
  const out: Fold[] = [];
  for (let f = 0; f < k; f++) {
    const testStart = first + Math.floor((span * f) / k);
    const testEnd = first + Math.floor((span * (f + 1)) / k);
    const trainEnd = testStart - purge;
    if (trainEnd > 0 && testEnd > testStart) out.push({ trainEnd, testStart, testEnd });
  }
  return out;
}

// ── Learners ────────────────────────────────────────────────────────────────

export type Fitted = {
  predict: (x: readonly number[]) => number;
  /** One weight per feature: |standardized coefficient| for linear models, share of split gain for trees. */
  importance: number[];
  /** Signed standardized coefficients (linear models only). */
  signed?: number[];
  params: Record<string, number | string>;
};

/** Training rows plus their dates, which the inner split for penalty selection needs. */
export type TrainSet = { X: number[][]; y: number[]; dates: string[] };

export type Learner = {
  name: string;
  family: "linear" | "tree";
  fit: (t: TrainSet, rng: Rng, horizon: number) => Fitted | null;
};

function linearFitted(m: LinearModel, X: readonly (readonly number[])[], params: Record<string, number | string>): Fitted {
  const { sd } = columnStats(X);
  const signed = m.coef.map((c, j) => c * sd[j]);
  return { predict: m.predict, importance: signed.map(Math.abs), signed, params };
}

/** Hold out the last `frac` of training dates for validation, purging `horizon` dates before it. */
function innerSplit(t: TrainSet, horizon: number, frac = 0.2): { fit: number[]; val: number[] } | null {
  const ud = [...new Set(t.dates)].sort();
  const cut = Math.floor(ud.length * (1 - frac));
  if (cut - horizon < 50 || ud.length - cut < 20) return null;
  const valStart = ud[cut], fitBefore = ud[cut - horizon];
  const fit: number[] = [], val: number[] = [];
  t.dates.forEach((d, i) => {
    if (d < fitBefore) fit.push(i);
    else if (d >= valStart) val.push(i);
  });
  return { fit, val };
}

/**
 * Pick a penalty on the inner split with the one-standard-error rule: the
 * most regularized grid value whose validation MSE is within one SE of the
 * best. `grid` runs from most to least regularized.
 */
function pickPenalty(
  t: TrainSet,
  horizon: number,
  grid: readonly number[],
  fitAt: (y: number[], X: number[][], g: number) => LinearModel | null,
): { value: number; validated: boolean } {
  const s = innerSplit(t, horizon);
  if (!s) return { value: grid[Math.floor(grid.length / 2)], validated: false };
  const X = s.fit.map((i) => t.X[i]), y = s.fit.map((i) => t.y[i]);
  const stats = grid.map((g) => {
    const m = fitAt(y, X, g);
    if (!m) return { mse: Infinity, se: Infinity };
    const sq = s.val.map((i) => (m.predict(t.X[i]) - t.y[i]) ** 2);
    const mse = mean(sq);
    return { mse, se: Math.sqrt(sq.reduce((a, v) => a + (v - mse) ** 2, 0) / Math.max(1, sq.length - 1) / sq.length) };
  });
  const best = stats.reduce((b, x, k) => (x.mse < stats[b].mse ? k : b), 0);
  if (!Number.isFinite(stats[best].mse)) return { value: grid[Math.floor(grid.length / 2)], validated: false };
  const limit = stats[best].mse + stats[best].se;
  return { value: grid[stats.findIndex((x) => x.mse <= limit)], validated: true };
}

/** Smallest lasso penalty that zeroes every coefficient: max_j |z_j·(y − ȳ)| / n. */
function lassoLambdaMax(y: readonly number[], X: readonly (readonly number[])[]): number {
  const { mean: mu, sd } = columnStats(X);
  const yBar = mean(y);
  let best = 0;
  for (let j = 0; j < mu.length; j++) {
    if (!(sd[j] > 0)) continue;
    let s = 0;
    for (let i = 0; i < y.length; i++) s += ((X[i][j] - mu[j]) / sd[j]) * (y[i] - yBar);
    best = Math.max(best, Math.abs(s) / y.length);
  }
  return best;
}

/** Ridge penalties, most to least regularized (features are standardized; λ scales n·I). */
const RIDGE_GRID = [100, 10, 1, 0.1, 0.01, 0.001];
/** Lasso penalties as fractions of λ_max (1 = every coefficient zero, i.e. the training mean). */
const LASSO_GRID = [1, 0.5, 0.2, 0.1, 0.05, 0.02, 0.01];
const lassoAt = (y: number[], X: number[][], frac: number) => lasso(y, X, frac * lassoLambdaMax(y, X), { maxIter: 300, tol: 1e-9 });

export const OLS_LEARNER: Learner = {
  name: "OLS",
  family: "linear",
  fit: (t) => {
    const m = ridge(t.y, t.X, 1e-8);
    return m ? linearFitted(m, t.X, {}) : null;
  },
};

export const RIDGE_LEARNER: Learner = {
  name: "Ridge",
  family: "linear",
  fit: (t, _rng, horizon) => {
    const pick = pickPenalty(t, horizon, RIDGE_GRID, (y, X, l) => ridge(y, X, l));
    const m = ridge(t.y, t.X, pick.value);
    return m ? linearFitted(m, t.X, { lambda: pick.value, lambdaChosenBy: pick.validated ? "inner purged split" : "default" }) : null;
  },
};

export const LASSO_LEARNER: Learner = {
  name: "Lasso",
  family: "linear",
  fit: (t, _rng, horizon) => {
    const pick = pickPenalty(t, horizon, LASSO_GRID, lassoAt);
    const m = lassoAt(t.y, t.X, pick.value);
    return m ? linearFitted(m, t.X, { lambdaFracOfMax: pick.value, lambdaChosenBy: pick.validated ? "inner purged split" : "default" }) : null;
  },
};

// ── Histogram trees ─────────────────────────────────────────────────────────

export type Binned = { n: number; p: number; bins: Uint8Array; edges: number[][] };

/** First index k with edges[k] ≥ x (edges.length if none): bin b holds (edges[b−1], edges[b]]. */
function lowerBound(edges: readonly number[], x: number): number {
  let lo = 0, hi = edges.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (edges[mid] < x) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/** Quantile-bin each feature into at most `maxBins` bins (≤ 255). */
export function binFeatures(X: readonly (readonly number[])[], maxBins = 32): Binned {
  const n = X.length, p = X[0]?.length ?? 0;
  const bins = new Uint8Array(n * p);
  const edges: number[][] = [];
  for (let j = 0; j < p; j++) {
    const col = X.map((r) => r[j]).sort((a, b) => a - b);
    const e: number[] = [];
    for (let b = 1; b < maxBins; b++) {
      const q = quantileSorted(col, b / maxBins);
      if (!e.length || q > e[e.length - 1]) e.push(q);
    }
    while (e.length && e[e.length - 1] >= col[n - 1]) e.pop();
    edges.push(e);
    for (let i = 0; i < n; i++) bins[i * p + j] = lowerBound(e, X[i][j]);
  }
  return { n, p, bins, edges };
}

/** Flat binary tree: feat < 0 marks a leaf. Go left when x ≤ thr (equivalently bin ≤ bin). */
export type Tree = { feat: number[]; bin: number[]; thr: number[]; left: number[]; right: number[]; value: number[] };

export type TreeOpts = { maxDepth: number; minLeaf: number; lambda: number; gamma: number; mtry: number };

/**
 * Grow one tree on gradients g and hessians h (second-order boosting form).
 * Leaf weight −G/(H+λ); split gain ½[G_L²/(H_L+λ) + G_R²/(H_R+λ) − G²/(H+λ)] − γ.
 * With g = −y, h = 1, λ = 0 this is an ordinary least-squares regression tree
 * (leaves are means, gain is half the drop in squared error). Split gains are
 * added to `gain` per feature.
 */
export function growTree(B: Binned, rows: Int32Array, g: Float64Array, h: Float64Array, o: TreeOpts, rng: Rng, gain: Float64Array): Tree {
  const t: Tree = { feat: [], bin: [], thr: [], left: [], right: [], value: [] };
  const HG = new Float64Array(256), HH = new Float64Array(256), HC = new Int32Array(256);
  const all = Array.from({ length: B.p }, (_, j) => j);
  const newNode = () => {
    t.feat.push(-1); t.bin.push(-1); t.thr.push(NaN); t.left.push(-1); t.right.push(-1); t.value.push(0);
    return t.feat.length - 1;
  };
  const stack: { node: number; rows: Int32Array; depth: number }[] = [{ node: newNode(), rows, depth: 0 }];
  while (stack.length) {
    const { node, rows: r, depth } = stack.pop()!;
    let G = 0, H = 0;
    for (let k = 0; k < r.length; k++) { G += g[r[k]]; H += h[r[k]]; }
    t.value[node] = -G / (H + o.lambda);
    if (depth >= o.maxDepth || r.length < 2 * o.minLeaf) continue;
    let cand = all;
    if (o.mtry < B.p) {
      cand = all.slice();
      for (let i = 0; i < o.mtry; i++) {
        const j = i + Math.floor(rng() * (cand.length - i));
        [cand[i], cand[j]] = [cand[j], cand[i]];
      }
      cand = cand.slice(0, o.mtry);
    }
    const parent = (G * G) / (H + o.lambda);
    let bestGain = 0, bestF = -1, bestS = -1;
    for (const f of cand) {
      const E = B.edges[f].length;
      if (!E) continue;
      HG.fill(0, 0, E + 1); HH.fill(0, 0, E + 1); HC.fill(0, 0, E + 1);
      for (let k = 0; k < r.length; k++) {
        const i = r[k], b = B.bins[i * B.p + f];
        HG[b] += g[i]; HH[b] += h[i]; HC[b]++;
      }
      let GL = 0, HL = 0, CL = 0;
      for (let s = 0; s < E; s++) {
        GL += HG[s]; HL += HH[s]; CL += HC[s];
        if (CL < o.minLeaf) continue;
        if (r.length - CL < o.minLeaf) break;
        const GR = G - GL, HR = H - HL;
        const gn = 0.5 * ((GL * GL) / (HL + o.lambda) + (GR * GR) / (HR + o.lambda) - parent) - o.gamma;
        if (gn > bestGain) { bestGain = gn; bestF = f; bestS = s; }
      }
    }
    if (bestF < 0) continue;
    let nl = 0;
    for (let k = 0; k < r.length; k++) if (B.bins[r[k] * B.p + bestF] <= bestS) nl++;
    const L = new Int32Array(nl), R = new Int32Array(r.length - nl);
    let a = 0, c = 0;
    for (let k = 0; k < r.length; k++) {
      const i = r[k];
      if (B.bins[i * B.p + bestF] <= bestS) L[a++] = i; else R[c++] = i;
    }
    gain[bestF] += bestGain;
    t.feat[node] = bestF; t.bin[node] = bestS; t.thr[node] = B.edges[bestF][bestS];
    const ln = newNode(), rn = newNode();
    t.left[node] = ln; t.right[node] = rn;
    stack.push({ node: ln, rows: L, depth: depth + 1 }, { node: rn, rows: R, depth: depth + 1 });
  }
  return t;
}

export function predictTree(t: Tree, x: readonly number[]): number {
  let i = 0;
  while (t.feat[i] >= 0) i = x[t.feat[i]] <= t.thr[i] ? t.left[i] : t.right[i];
  return t.value[i];
}

function predictTreeBinned(t: Tree, B: Binned, row: number): number {
  let i = 0;
  while (t.feat[i] >= 0) i = B.bins[row * B.p + t.feat[i]] <= t.bin[i] ? t.left[i] : t.right[i];
  return t.value[i];
}

const leaves = (t: Tree) => t.feat.filter((f) => f < 0).length;

function shares(gain: Float64Array): number[] {
  let s = 0;
  for (const v of gain) s += v;
  return Array.from(gain, (v) => (s > 0 ? v / s : 0));
}

const allRows = (n: number) => Int32Array.from({ length: n }, (_, i) => i);

export const CART_OPTS: TreeOpts = { maxDepth: 4, minLeaf: 50, lambda: 0, gamma: 0, mtry: Infinity };
export const FOREST = { trees: 50, maxDepth: 6, minLeaf: 50 };
export const BOOSTING = { rounds: 100, learningRate: 0.05, maxDepth: 3, minLeaf: 50, lambda: 1, gamma: 0, subsample: 0.8 };

export const CART_LEARNER: Learner = {
  name: "Decision tree",
  family: "tree",
  fit: (t, rng) => {
    const B = binFeatures(t.X);
    const n = t.y.length;
    const gain = new Float64Array(B.p);
    const tree = growTree(B, allRows(n), Float64Array.from(t.y, (v) => -v), new Float64Array(n).fill(1), CART_OPTS, rng, gain);
    return { predict: (x) => predictTree(tree, x), importance: shares(gain), params: { maxDepth: CART_OPTS.maxDepth, minLeaf: CART_OPTS.minLeaf, leaves: leaves(tree) } };
  },
};

export const FOREST_LEARNER: Learner = {
  name: "Random forest",
  family: "tree",
  fit: (t, rng) => {
    const B = binFeatures(t.X);
    const n = t.y.length;
    const g = Float64Array.from(t.y, (v) => -v), h = new Float64Array(n).fill(1);
    const gain = new Float64Array(B.p);
    const mtry = Math.max(1, Math.round(Math.sqrt(B.p)));
    const opts: TreeOpts = { maxDepth: FOREST.maxDepth, minLeaf: FOREST.minLeaf, lambda: 0, gamma: 0, mtry };
    const trees: Tree[] = [];
    for (let k = 0; k < FOREST.trees; k++) {
      const boot = Int32Array.from({ length: n }, () => Math.floor(rng() * n));
      trees.push(growTree(B, boot, g, h, opts, rng, gain));
    }
    return {
      predict: (x) => { let s = 0; for (const tr of trees) s += predictTree(tr, x); return s / trees.length; },
      importance: shares(gain),
      params: { trees: FOREST.trees, maxDepth: FOREST.maxDepth, minLeaf: FOREST.minLeaf, featuresPerSplit: mtry },
    };
  },
};

export const BOOSTING_LEARNER: Learner = {
  name: "Gradient boosting",
  family: "tree",
  fit: (t, rng) => {
    const B = binFeatures(t.X);
    const n = t.y.length;
    const base = mean(t.y);
    const F = new Float64Array(n).fill(base);
    const g = new Float64Array(n), h = new Float64Array(n).fill(1);
    const gain = new Float64Array(B.p);
    const opts: TreeOpts = { maxDepth: BOOSTING.maxDepth, minLeaf: BOOSTING.minLeaf, lambda: BOOSTING.lambda, gamma: BOOSTING.gamma, mtry: Infinity };
    const m = Math.max(1, Math.floor(BOOSTING.subsample * n));
    const perm = allRows(n);
    const trees: Tree[] = [];
    for (let round = 0; round < BOOSTING.rounds; round++) {
      for (let i = 0; i < n; i++) g[i] = F[i] - t.y[i]; // ∂/∂F of ½(F − y)²; hessian 1
      for (let i = 0; i < m; i++) {
        const j = i + Math.floor(rng() * (n - i));
        const tmp = perm[i]; perm[i] = perm[j]; perm[j] = tmp;
      }
      const tree = growTree(B, perm.slice(0, m), g, h, opts, rng, gain);
      for (let i = 0; i < n; i++) F[i] += BOOSTING.learningRate * predictTreeBinned(tree, B, i);
      trees.push(tree);
    }
    return {
      predict: (x) => { let s = base; for (const tr of trees) s += BOOSTING.learningRate * predictTree(tr, x); return s; },
      importance: shares(gain),
      params: { ...BOOSTING },
    };
  },
};

export const LINEAR_LEARNERS: readonly Learner[] = [OLS_LEARNER, RIDGE_LEARNER, LASSO_LEARNER];
export const TREE_LEARNERS: readonly Learner[] = [CART_LEARNER, FOREST_LEARNER, BOOSTING_LEARNER];

// ── Out-of-sample scoring ───────────────────────────────────────────────────

export type OosPoint = { symbol: string; date: string; fold: number; pred: number; bench: number; y: number };

export type WalkForwardScore = {
  folds: number;
  n: number;
  /** Pooled Spearman IC of forecast vs realized forward return; NaN when the forecast never varies within a fold. */
  ic: number;
  /**
   * IC t-stat on non-overlapping dates (every `horizon`-th test date) with
   * date-clustered errors: peers on the same date share the market's move,
   * so they count as one draw, not ten.
   */
  icT: number;
  icN: number;
  icClusters: number;
  icByFold: number[];
  /** Share of forecasts with the right sign, and the share of positive outcomes (what "always long" scores). */
  hitRate: number;
  baseRate: number;
  /** 1 − MSE(model)/MSE(training mean): above 0 means it beat the naive forecast. */
  skill: number;
  /** IC > 0 and t ≥ 2. Failing models get no weight. */
  passed: boolean;
};

/** Spearman IC (mean product of standardized ranks) with a date-clustered standard error. */
export function clusteredIc(points: readonly Pick<OosPoint, "date" | "pred" | "y">[]): { ic: number; t: number; n: number; clusters: number } {
  const n = points.length;
  if (n < 3) return { ic: NaN, t: NaN, n, clusters: 0 };
  const z = (xs: number[]) => {
    const r = rank(xs), m = mean(r), sd = std(r, 0);
    return r.map((v) => (sd > 0 ? (v - m) / sd : 0));
  };
  const u = z(points.map((p) => p.pred)), v = z(points.map((p) => p.y));
  let ic = 0;
  for (let i = 0; i < n; i++) ic += u[i] * v[i];
  ic /= n;
  const byDate = new Map<string, number>();
  points.forEach((p, i) => byDate.set(p.date, (byDate.get(p.date) ?? 0) + u[i] * v[i] - ic));
  let s2 = 0;
  for (const c of byDate.values()) s2 += c * c;
  const se = Math.sqrt(s2) / n;
  return { ic, t: se > 0 ? ic / se : NaN, n, clusters: byDate.size };
}

const varies = (xs: readonly number[]) => xs.length > 1 && Math.max(...xs) - Math.min(...xs) > 1e-12;

export function scoreOos(points: readonly OosPoint[], horizon: number): WalkForwardScore {
  const folds = [...new Set(points.map((p) => p.fold))].sort((a, b) => a - b);
  const byFold = folds.map((f) => points.filter((p) => p.fold === f));
  const informative = byFold.some((fp) => varies(fp.map((p) => p.pred)));
  const testDates = [...new Set(points.map((p) => p.date))].sort();
  const keep = new Set(testDates.filter((_, i) => i % Math.max(1, horizon) === 0));
  const sub = clusteredIc(points.filter((p) => keep.has(p.date)));
  const ic = informative ? clusteredIc(points).ic : NaN;
  let mseM = 0, mseB = 0, hits = 0, ups = 0;
  for (const p of points) {
    mseM += (p.pred - p.y) ** 2;
    mseB += (p.bench - p.y) ** 2;
    if (Math.sign(p.pred) === Math.sign(p.y)) hits++;
    if (p.y > 0) ups++;
  }
  const n = points.length || 1;
  const icT = informative ? sub.t : NaN;
  return {
    folds: folds.length,
    n: points.length,
    ic,
    icT,
    icN: sub.n,
    icClusters: sub.clusters,
    icByFold: byFold.map((fp) => (varies(fp.map((p) => p.pred)) ? clusteredIc(fp).ic : NaN)),
    hitRate: hits / n,
    baseRate: ups / n,
    skill: mseB > 0 ? 1 - mseM / mseB : NaN,
    passed: ic > 0 && icT >= 2,
  };
}

export type ModelReport = {
  model: string;
  family: "linear" | "tree" | "sequence";
  oos: WalkForwardScore;
  /** Forecast forward log return for the target symbol from its newest row (model refit on all labeled rows). */
  forecast: number | null;
  /**
   * −100..100: where today's forecast sits among the same model's forecasts
   * for this symbol over the last two years (0 when the forecast is flat).
   */
  score: number | null;
  /** Features by weight, largest first; `sign` is the direction of a linear coefficient. */
  importance: { feature: string; weight: number; sign?: number }[];
  /** Features the lasso shrank to exactly zero. */
  discarded?: string[];
  params: Record<string, number | string>;
  notes: string[];
};

export type MlReport = {
  target: string;
  /** Date of the target's newest row — the forecast is from that close. */
  asOf: string | null;
  horizon: number;
  rows: number;
  labeled: number;
  symbols: number;
  features: string[];
  models: ModelReport[];
  /** The validated model with the highest out-of-sample IC, or null when none passed. */
  best: string | null;
};

type Split = { train: FeatureRow[]; test: FeatureRow[]; fold: number };

function splits(labeled: readonly FeatureRow[], horizon: number, folds: number, testFrac: number): Split[] {
  const dates = [...new Set(labeled.map((r) => r.date))].sort();
  const pos = new Map(dates.map((d, i) => [d, i] as const));
  return walkForwardFolds(dates.length, { folds, testFrac, purge: horizon }).map((f, k) => ({
    fold: k,
    train: labeled.filter((r) => pos.get(r.date)! < f.trainEnd),
    test: labeled.filter((r) => { const i = pos.get(r.date)!; return i >= f.testStart && i < f.testEnd; }),
  }));
}

const toTrain = (rows: readonly FeatureRow[]): TrainSet => ({ X: rows.map((r) => r.x), y: rows.map((r) => r.y as number), dates: rows.map((r) => r.date) });

function evaluate(set: FeatureSet, learner: Learner, mine: readonly FeatureRow[], sp: Split[], labeled: FeatureRow[], seed: number): ModelReport {
  const rng = mulberry32(seed);
  const points: OosPoint[] = [];
  for (const s of sp) {
    if (s.train.length < 200 || !s.test.length) continue;
    const m = learner.fit(toTrain(s.train), rng, set.horizon);
    if (!m) continue;
    const bench = mean(s.train.map((r) => r.y as number));
    for (const r of s.test) points.push({ symbol: r.symbol, date: r.date, fold: s.fold, pred: m.predict(r.x), bench, y: r.y as number });
  }
  const oos = scoreOos(points, set.horizon);
  const final = labeled.length >= 200 ? learner.fit(toTrain(labeled), rng, set.horizon) : null;
  const latest = mine.at(-1);
  const forecast = final && latest ? final.predict(latest.x) : null;
  const history = final ? mine.slice(-504).map((r) => final.predict(r.x)) : [];
  const flat = !varies(history);
  const score = forecast == null || !history.length ? null : flat ? 0 : Math.round(100 * (2 * percentileOf(history, forecast) - 1));
  const importance = final
    ? set.names
        .map((feature, j) => ({ feature, weight: final.importance[j], ...(final.signed ? { sign: Math.sign(final.signed[j]) } : {}) }))
        .sort((a, b) => b.weight - a.weight)
    : [];
  const discarded = learner.name === "Lasso" && final?.signed ? set.names.filter((_, j) => final.signed![j] === 0) : undefined;
  const notes: string[] = [];
  if (final && flat) notes.push("forecast is flat (the training mean): no usable signal");
  if (!oos.n) notes.push("no walk-forward fold had enough training rows");
  else if (!oos.passed) notes.push(`failed walk-forward validation: IC ${Number.isFinite(oos.ic) ? oos.ic.toFixed(3) : "n/a"}, t ${Number.isFinite(oos.icT) ? oos.icT.toFixed(2) : "n/a"} (needs IC > 0 and t ≥ 2)`);
  if (oos.n && oos.skill < 0) notes.push("out-of-sample error is worse than forecasting the training mean");
  return { model: learner.name, family: learner.family, oos, forecast, score, importance, ...(discarded ? { discarded } : {}), params: final?.params ?? {}, notes };
}

/**
 * Walk-forward evaluate each learner on a pooled feature set and forecast
 * the target symbol from its newest row. Needs ≥ 500 labeled rows.
 */
export function mlReport(
  set: FeatureSet,
  target: string,
  learners: readonly Learner[],
  opts: { folds?: number; testFrac?: number; seed?: number } = {},
): MlReport | null {
  const labeled = set.rows.filter((r) => r.y != null);
  if (labeled.length < 500) return null;
  const sp = splits(labeled, set.horizon, opts.folds ?? 5, opts.testFrac ?? 0.5);
  if (!sp.length) return null;
  const mine = set.rows.filter((r) => r.symbol === target).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const models = learners.map((l, k) => evaluate(set, l, mine, sp, labeled, (opts.seed ?? 1) + k * 7919));
  const passed = models.filter((m) => m.oos.passed).sort((a, b) => b.oos.ic - a.oos.ic);
  return {
    target,
    asOf: mine.at(-1)?.date ?? null,
    horizon: set.horizon,
    rows: set.rows.length,
    labeled: labeled.length,
    symbols: new Set(set.rows.map((r) => r.symbol)).size,
    features: set.names,
    models,
    best: passed[0]?.model ?? null,
  };
}
