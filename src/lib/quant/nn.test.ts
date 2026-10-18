import { test } from "node:test";
import assert from "node:assert/strict";
import { Tape, tensor, glorot, filled, Lstm, Transformer, sequences, sequenceModelReport, paramCount, type T, type Batch } from "./nn";
import { mulberry32, normalSampler } from "./stats";
import type { FeatureSet, FeatureRow } from "./features";

const day = (i: number) => new Date(Date.UTC(2018, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);

const rng = mulberry32(11);
const gauss = normalSampler(rng);
const randn = (r: number, c: number): T => tensor(r, c, Float64Array.from({ length: r * c }, () => gauss()));

/**
 * Compare the tape's gradient of L = Σ out·R (R random) with central
 * differences for every element of every input.
 */
function gradCheck(name: string, inputs: T[], f: (tape: Tape) => T, eps = 1e-6, tol = 1e-6) {
  const tape = new Tape();
  const out = f(tape);
  const R = Float64Array.from({ length: out.d.length }, () => 2 * rng() - 1);
  for (const x of inputs) x.g.fill(0);
  tape.backward(out, R);
  const analytic = inputs.map((x) => x.g.slice());
  const loss = () => {
    const o = f(new Tape(false));
    let s = 0;
    for (let i = 0; i < o.d.length; i++) s += o.d[i] * R[i];
    return s;
  };
  let worst = 0;
  inputs.forEach((x, k) => {
    for (let i = 0; i < x.d.length; i++) {
      const v = x.d[i];
      x.d[i] = v + eps; const up = loss();
      x.d[i] = v - eps; const dn = loss();
      x.d[i] = v;
      const num = (up - dn) / (2 * eps);
      const err = Math.abs(num - analytic[k][i]) / Math.max(1, Math.abs(num), Math.abs(analytic[k][i]));
      worst = Math.max(worst, err);
    }
  });
  assert.ok(worst < tol, `${name}: worst relative gradient error ${worst}`);
}

test("every tape op passes a finite-difference gradient check", () => {
  const a = randn(3, 4), b = randn(4, 5), c = randn(3, 4), row = randn(1, 4);
  gradCheck("matmul", [a, b], (t) => t.matmul(a, b));
  gradCheck("add", [a, c], (t) => t.add(a, c));
  gradCheck("add (row broadcast)", [a, row], (t) => t.add(a, row));
  const pos = randn(2, 4), seq = randn(6, 4);
  gradCheck("addPos", [seq, pos], (t) => t.addPos(seq, pos));
  gradCheck("mul", [a, c], (t) => t.mul(a, c));
  gradCheck("sigmoid", [a], (t) => t.sigmoid(a));
  gradCheck("tanh", [a], (t) => t.tanh(a));
  gradCheck("relu", [a], (t) => t.relu(a));
  const gain = randn(1, 4), bias = randn(1, 4);
  gradCheck("layerNorm", [a, gain, bias], (t) => t.layerNorm(a, gain, bias));
  // Two samples of three positions each.
  const q = randn(6, 4), k = randn(6, 4), v = randn(6, 3);
  gradCheck("attention", [q, k, v], (t) => t.attention(q, k, v, 2, 3));
  gradCheck("meanPool", [seq], (t) => t.meanPool(seq, 2, 3));
  const pred = randn(5, 1), y = Float64Array.from({ length: 5 }, () => gauss());
  gradCheck("mse", [pred], (t) => t.mse(pred, y));
  // Composite: gradients must accumulate correctly when a tensor is reused.
  gradCheck("reuse", [a], (t) => t.mul(t.tanh(a), t.add(a, a)));
});

test("attention rows are a convex combination and stay within each sample", () => {
  const t = new Tape(false);
  const v = tensor(4, 1, Float64Array.from([1, 2, 100, 200]));
  const o = t.attention(randn(4, 2), randn(4, 2), v, 2, 2);
  for (const i of [0, 1]) assert.ok(o.d[i] >= 1 && o.d[i] <= 2, "sample 0 only mixes its own positions");
  for (const i of [2, 3]) assert.ok(o.d[i] >= 100 && o.d[i] <= 200);
});

test("full LSTM and Transformer gradients match finite differences", () => {
  const batch: Batch = { B: 2, L: 4, p: 3, x: Float64Array.from({ length: 24 }, () => gauss()) };
  const lstm = new Lstm(3, 4, mulberry32(1));
  gradCheck("LSTM", lstm.params(), (t) => lstm.forward(t, batch), 1e-6, 1e-5);
  const tf = new Transformer(3, 4, 4, mulberry32(2));
  gradCheck("Transformer", tf.params(), (t) => tf.forward(t, batch), 1e-6, 1e-5);
  assert.equal(paramCount(lstm), 4 * (3 * 4 + 4 * 4 + 4) + 4 + 1);
  assert.equal(glorot(3, 5, mulberry32(3)).d.length, 15);
  assert.ok(filled(2, 2, 7).d.every((x) => x === 7));
});

/** One symbol, i.i.d. features; y_t = signal(x_{t-4..t}) + noise (horizon 1, so labels don't overlap). */
function lagged(n: number, signal: number, seed: number, symbols = 1): FeatureSet {
  const g = normalSampler(mulberry32(seed));
  const rows: FeatureRow[] = [];
  for (let s = 0; s < symbols; s++) {
    const xs = Array.from({ length: n }, () => [g(), g(), g()]);
    for (let i = 0; i < n; i++) {
      let m = 0;
      for (let k = 0; k < 5 && i - k >= 0; k++) m += xs[i - k][0];
      rows.push({ symbol: `S${s}`, date: day(i), x: xs[i], y: i === n - 1 ? null : signal * (m / Math.sqrt(5)) + g() });
    }
  }
  return { names: ["x0", "x1", "x2"], horizon: 1, rows };
}

test("sequences end on their date and never include later rows", () => {
  const set = lagged(50, 0, 1, 2);
  const seqs = sequences(set, 10);
  assert.equal(seqs.length, 2 * (50 - 9));
  const byKey = new Map(set.rows.map((r) => [`${r.symbol}|${r.date}`, r]));
  for (const s of seqs) {
    const own = byKey.get(`${s.symbol}|${s.date}`)!;
    assert.equal(s.rows.at(-1), own.x, "last step is the date's own row");
    assert.equal(s.y, own.y);
    assert.equal(s.rows.length, 10);
    assert.ok(s.rows.every((x) => set.rows.find((r) => r.x === x)!.date <= s.date), "no future rows");
  }
});

test("LSTM and Transformer learn a 5-day moving signal and pass validation", () => {
  const set = lagged(1600, 0.6, 21);
  for (const kind of ["lstm", "transformer"] as const) {
    const rep = sequenceModelReport(set, "S0", kind, { seqLen: 10, hidden: 8, stride: 1, seed: 5 })!;
    assert.ok(rep.oos.passed && rep.oos.ic > 0.2, `${rep.model} IC ${rep.oos.ic} t ${rep.oos.icT}`);
    assert.ok(rep.oos.skill > 0.03, `${rep.model} skill ${rep.oos.skill}`);
    assert.equal(rep.importance[0].feature, "x0", `${rep.model} importance`);
    assert.ok(rep.forecast !== null && rep.score! >= -100 && rep.score! <= 100);
    assert.equal(rep.family, "sequence");
  }
});

test("sequence models fail validation on noise", () => {
  const set = lagged(1600, 0, 22, 2);
  for (const kind of ["lstm", "transformer"] as const) {
    const rep = sequenceModelReport(set, "S0", kind, { seqLen: 10, hidden: 8, stride: 1, seed: 6 })!;
    assert.ok(!rep.oos.passed, `${rep.model} passed on noise: IC ${rep.oos.ic} t ${rep.oos.icT}`);
    assert.ok(rep.oos.skill < 0.01, `${rep.model} skill on noise ${rep.oos.skill}`);
    assert.ok(rep.notes.some((n) => n.startsWith("failed held-out validation")));
  }
  assert.equal(sequenceModelReport({ ...set, rows: set.rows.slice(0, 200) }, "S0", "lstm"), null);
});
