/**
 * Neural sequence forecasters: an LSTM and a one-block Transformer, trained
 * on the last 20 days of features to predict the forward 1-month return.
 *
 * Autodiff is a small reverse-mode tape over row-major Float64Array
 * matrices. Networks are deliberately tiny (a few thousand weights), use
 * early stopping on a purged validation tail and decoupled weight decay,
 * and are scored on a held-out, purged final 30% of dates. Daily return
 * data is mostly noise; a big network would memorize it.
 */

import { mean, std, percentileOf, mulberry32, type Rng } from "./stats";
import type { FeatureSet, FeatureRow } from "./features";
import { scoreOos, type ModelReport, type OosPoint } from "./ml";

// ── Tensors and the tape ────────────────────────────────────────────────────

/** r × c matrix, row-major, with a gradient buffer of the same shape. */
export type T = { r: number; c: number; d: Float64Array; g: Float64Array };

export const tensor = (r: number, c: number, d?: Float64Array): T => ({ r, c, d: d ?? new Float64Array(r * c), g: new Float64Array(r * c) });

export class Tape {
  private ops: (() => void)[] = [];
  /** `record = false` for inference: no backward closures are kept. */
  constructor(private record = true) {}

  private push(f: () => void) {
    if (this.record) this.ops.push(f);
  }

  /** Run the tape backwards from `t`, seeding its gradient with `seed` (default 1 for a scalar loss). */
  backward(t: T, seed?: Float64Array) {
    if (seed) t.g.set(seed); else t.g[0] = 1;
    for (let k = this.ops.length - 1; k >= 0; k--) this.ops[k]();
    this.ops = [];
  }

  matmul(a: T, b: T): T {
    if (a.c !== b.r) throw new Error(`matmul ${a.r}×${a.c} · ${b.r}×${b.c}`);
    const m = a.r, k = a.c, n = b.c;
    const o = tensor(m, n);
    for (let i = 0; i < m; i++) {
      const oo = i * n;
      for (let p = 0; p < k; p++) {
        const av = a.d[i * k + p];
        if (av === 0) continue;
        const bo = p * n;
        for (let j = 0; j < n; j++) o.d[oo + j] += av * b.d[bo + j];
      }
    }
    this.push(() => {
      for (let i = 0; i < m; i++) {
        const oo = i * n;
        for (let p = 0; p < k; p++) {
          const bo = p * n;
          let s = 0;
          for (let j = 0; j < n; j++) s += o.g[oo + j] * b.d[bo + j];
          a.g[i * k + p] += s;
          const av = a.d[i * k + p];
          if (av !== 0) for (let j = 0; j < n; j++) b.g[bo + j] += av * o.g[oo + j];
        }
      }
    });
    return o;
  }

  /** a + b, where b is the same shape or a 1 × c row broadcast over a's rows. */
  add(a: T, b: T): T {
    const bcast = b.r === 1 && a.r !== 1;
    if (a.c !== b.c || (!bcast && a.r !== b.r)) throw new Error("add shape");
    const o = tensor(a.r, a.c);
    for (let i = 0; i < o.d.length; i++) o.d[i] = a.d[i] + b.d[bcast ? i % a.c : i];
    this.push(() => {
      for (let i = 0; i < o.g.length; i++) {
        a.g[i] += o.g[i];
        b.g[bcast ? i % a.c : i] += o.g[i];
      }
    });
    return o;
  }

  /** Add a per-position row: row i of `a` gets row (i mod L) of `p`. */
  addPos(a: T, p: T): T {
    const L = p.r, c = a.c;
    const o = tensor(a.r, c);
    for (let i = 0; i < a.r; i++) for (let j = 0; j < c; j++) o.d[i * c + j] = a.d[i * c + j] + p.d[(i % L) * c + j];
    this.push(() => {
      for (let i = 0; i < a.r; i++) for (let j = 0; j < c; j++) {
        a.g[i * c + j] += o.g[i * c + j];
        p.g[(i % L) * c + j] += o.g[i * c + j];
      }
    });
    return o;
  }

  mul(a: T, b: T): T {
    const o = tensor(a.r, a.c);
    for (let i = 0; i < o.d.length; i++) o.d[i] = a.d[i] * b.d[i];
    this.push(() => {
      for (let i = 0; i < o.g.length; i++) {
        a.g[i] += o.g[i] * b.d[i];
        b.g[i] += o.g[i] * a.d[i];
      }
    });
    return o;
  }

  private unary(a: T, f: (x: number) => number, dfdy: (y: number, x: number) => number): T {
    const o = tensor(a.r, a.c);
    for (let i = 0; i < o.d.length; i++) o.d[i] = f(a.d[i]);
    this.push(() => {
      for (let i = 0; i < o.g.length; i++) a.g[i] += o.g[i] * dfdy(o.d[i], a.d[i]);
    });
    return o;
  }

  sigmoid(a: T): T {
    return this.unary(a, (x) => 1 / (1 + Math.exp(-x)), (y) => y * (1 - y));
  }

  tanh(a: T): T {
    return this.unary(a, Math.tanh, (y) => 1 - y * y);
  }

  relu(a: T): T {
    return this.unary(a, (x) => (x > 0 ? x : 0), (_, x) => (x > 0 ? 1 : 0));
  }

  /** Row-wise layer normalization with learned gain and bias (1 × c each). */
  layerNorm(a: T, gain: T, bias: T, eps = 1e-5): T {
    const { r, c } = a;
    const o = tensor(r, c);
    const xh = new Float64Array(r * c), inv = new Float64Array(r);
    for (let i = 0; i < r; i++) {
      let m = 0;
      for (let j = 0; j < c; j++) m += a.d[i * c + j];
      m /= c;
      let v = 0;
      for (let j = 0; j < c; j++) v += (a.d[i * c + j] - m) ** 2;
      inv[i] = 1 / Math.sqrt(v / c + eps);
      for (let j = 0; j < c; j++) {
        xh[i * c + j] = (a.d[i * c + j] - m) * inv[i];
        o.d[i * c + j] = gain.d[j] * xh[i * c + j] + bias.d[j];
      }
    }
    this.push(() => {
      for (let i = 0; i < r; i++) {
        let s1 = 0, s2 = 0;
        for (let j = 0; j < c; j++) {
          const go = o.g[i * c + j];
          gain.g[j] += go * xh[i * c + j];
          bias.g[j] += go;
          const dx = go * gain.d[j];
          s1 += dx;
          s2 += dx * xh[i * c + j];
        }
        for (let j = 0; j < c; j++) {
          const dx = o.g[i * c + j] * gain.d[j];
          a.g[i * c + j] += inv[i] * (dx - s1 / c - (xh[i * c + j] * s2) / c);
        }
      }
    });
    return o;
  }

  /**
   * Scaled dot-product self-attention, one head, run separately for each of
   * `B` samples whose `L` positions are consecutive rows of Q, K and V.
   */
  attention(q: T, k: T, v: T, B: number, L: number): T {
    const d = q.c, scale = 1 / Math.sqrt(d);
    const o = tensor(q.r, v.c);
    const A = new Float64Array(B * L * L);
    for (let s = 0; s < B; s++) {
      const base = s * L;
      for (let i = 0; i < L; i++) {
        let mx = -Infinity;
        const ai = (s * L + i) * L;
        for (let j = 0; j < L; j++) {
          let dot = 0;
          for (let t = 0; t < d; t++) dot += q.d[(base + i) * d + t] * k.d[(base + j) * d + t];
          A[ai + j] = dot * scale;
          if (A[ai + j] > mx) mx = A[ai + j];
        }
        let z = 0;
        for (let j = 0; j < L; j++) { A[ai + j] = Math.exp(A[ai + j] - mx); z += A[ai + j]; }
        for (let j = 0; j < L; j++) A[ai + j] /= z;
        for (let j = 0; j < L; j++) {
          const w = A[ai + j];
          for (let t = 0; t < v.c; t++) o.d[(base + i) * v.c + t] += w * v.d[(base + j) * v.c + t];
        }
      }
    }
    this.push(() => {
      const dA = new Float64Array(L);
      for (let s = 0; s < B; s++) {
        const base = s * L;
        for (let i = 0; i < L; i++) {
          const ai = (s * L + i) * L;
          let rowDot = 0;
          for (let j = 0; j < L; j++) {
            let g = 0;
            for (let t = 0; t < v.c; t++) {
              g += o.g[(base + i) * v.c + t] * v.d[(base + j) * v.c + t];
              v.g[(base + j) * v.c + t] += A[ai + j] * o.g[(base + i) * v.c + t];
            }
            dA[j] = g;
            rowDot += g * A[ai + j];
          }
          for (let j = 0; j < L; j++) {
            const dS = A[ai + j] * (dA[j] - rowDot) * scale;
            if (dS === 0) continue;
            for (let t = 0; t < d; t++) {
              q.g[(base + i) * d + t] += dS * k.d[(base + j) * d + t];
              k.g[(base + j) * d + t] += dS * q.d[(base + i) * d + t];
            }
          }
        }
      }
    });
    return o;
  }

  /** Mean over each sample's L consecutive rows: (B·L) × c → B × c. */
  meanPool(a: T, B: number, L: number): T {
    const c = a.c;
    const o = tensor(B, c);
    for (let s = 0; s < B; s++) for (let t = 0; t < L; t++) for (let j = 0; j < c; j++) o.d[s * c + j] += a.d[(s * L + t) * c + j] / L;
    this.push(() => {
      for (let s = 0; s < B; s++) for (let t = 0; t < L; t++) for (let j = 0; j < c; j++) a.g[(s * L + t) * c + j] += o.g[s * c + j] / L;
    });
    return o;
  }

  /** Mean squared error of an m × 1 prediction against targets; returns a 1 × 1 loss. */
  mse(pred: T, y: Float64Array): T {
    const m = pred.r;
    const o = tensor(1, 1);
    for (let i = 0; i < m; i++) o.d[0] += (pred.d[i] - y[i]) ** 2 / m;
    this.push(() => {
      for (let i = 0; i < m; i++) pred.g[i] += (2 * (pred.d[i] - y[i]) * o.g[0]) / m;
    });
    return o;
  }
}

// ── Parameters and optimizer ────────────────────────────────────────────────

/** Glorot-uniform initialized weight matrix. */
export function glorot(r: number, c: number, rng: Rng): T {
  const lim = Math.sqrt(6 / (r + c));
  return tensor(r, c, Float64Array.from({ length: r * c }, () => (2 * rng() - 1) * lim));
}

export const filled = (r: number, c: number, v: number): T => tensor(r, c, new Float64Array(r * c).fill(v));

/** Adam with decoupled weight decay (AdamW) and global-norm gradient clipping. */
export class Adam {
  private m: Float64Array[];
  private v: Float64Array[];
  private t = 0;
  constructor(private params: T[], private lr = 3e-3, private wd = 1e-4, private clip = 1, private b1 = 0.9, private b2 = 0.999) {
    this.m = params.map((p) => new Float64Array(p.d.length));
    this.v = params.map((p) => new Float64Array(p.d.length));
  }

  step() {
    this.t++;
    let norm = 0;
    for (const p of this.params) for (const g of p.g) norm += g * g;
    norm = Math.sqrt(norm);
    const k = norm > this.clip ? this.clip / norm : 1;
    const c1 = 1 - Math.pow(this.b1, this.t), c2 = 1 - Math.pow(this.b2, this.t);
    this.params.forEach((p, n) => {
      const m = this.m[n], v = this.v[n];
      for (let i = 0; i < p.d.length; i++) {
        const g = p.g[i] * k;
        m[i] = this.b1 * m[i] + (1 - this.b1) * g;
        v[i] = this.b2 * v[i] + (1 - this.b2) * g * g;
        p.d[i] -= this.lr * ((m[i] / c1) / (Math.sqrt(v[i] / c2) + 1e-8) + this.wd * p.d[i]);
        p.g[i] = 0;
      }
    });
  }
}

// ── Models ──────────────────────────────────────────────────────────────────

/** A batch: B sequences of L steps × p features, sample s's step t at row s·L + t. */
export type Batch = { B: number; L: number; p: number; x: Float64Array };

export interface SeqNet {
  readonly name: string;
  params(): T[];
  /** B × 1 standardized forecasts. */
  forward(tape: Tape, batch: Batch): T;
}

export class Lstm implements SeqNet {
  readonly name = "LSTM";
  private W: Record<"i" | "f" | "o" | "g", { x: T; h: T; b: T }>;
  private wy: T;
  private by: T;
  constructor(p: number, readonly hidden: number, rng: Rng) {
    const gate = (bias: number) => ({ x: glorot(p, hidden, rng), h: glorot(hidden, hidden, rng), b: filled(1, hidden, bias) });
    // Forget-gate bias 1 so the cell remembers by default early in training.
    this.W = { i: gate(0), f: gate(1), o: gate(0), g: gate(0) };
    this.wy = glorot(hidden, 1, rng);
    this.by = filled(1, 1, 0);
  }

  params(): T[] {
    return [...Object.values(this.W).flatMap((w) => [w.x, w.h, w.b]), this.wy, this.by];
  }

  forward(tape: Tape, { B, L, p, x }: Batch): T {
    const H = this.hidden;
    let h = tensor(B, H), c = tensor(B, H);
    for (let t = 0; t < L; t++) {
      const xt = tensor(B, p);
      for (let s = 0; s < B; s++) xt.d.set(x.subarray((s * L + t) * p, (s * L + t + 1) * p), s * p);
      const pre = (w: { x: T; h: T; b: T }) => tape.add(tape.add(tape.matmul(xt, w.x), tape.matmul(h, w.h)), w.b);
      const i = tape.sigmoid(pre(this.W.i));
      const f = tape.sigmoid(pre(this.W.f));
      const o = tape.sigmoid(pre(this.W.o));
      const g = tape.tanh(pre(this.W.g));
      c = tape.add(tape.mul(f, c), tape.mul(i, g));
      h = tape.mul(o, tape.tanh(c));
    }
    return tape.add(tape.matmul(h, this.wy), this.by);
  }
}

export class Transformer implements SeqNet {
  readonly name = "Transformer";
  private w: Record<string, T>;
  constructor(p: number, L: number, readonly dModel: number, rng: Rng, readonly ffn = 2 * dModel) {
    const d = dModel;
    this.w = {
      win: glorot(p, d, rng), bin: filled(1, d, 0), pos: tensor(L, d, Float64Array.from({ length: L * d }, () => (2 * rng() - 1) * 0.1)),
      wq: glorot(d, d, rng), wk: glorot(d, d, rng), wv: glorot(d, d, rng), wo: glorot(d, d, rng),
      g1: filled(1, d, 1), b1: filled(1, d, 0),
      w1: glorot(d, ffn, rng), c1: filled(1, ffn, 0), w2: glorot(ffn, d, rng), c2: filled(1, d, 0),
      g2: filled(1, d, 1), b2: filled(1, d, 0),
      wy: glorot(d, 1, rng), by: filled(1, 1, 0),
    };
  }

  params(): T[] {
    return Object.values(this.w);
  }

  forward(tape: Tape, { B, L, p, x }: Batch): T {
    const w = this.w;
    const X = tensor(B * L, p, x);
    const e = tape.addPos(tape.add(tape.matmul(X, w.win), w.bin), w.pos);
    const att = tape.attention(tape.matmul(e, w.wq), tape.matmul(e, w.wk), tape.matmul(e, w.wv), B, L);
    const z1 = tape.layerNorm(tape.add(e, tape.matmul(att, w.wo)), w.g1, w.b1);
    const ff = tape.add(tape.matmul(tape.relu(tape.add(tape.matmul(z1, w.w1), w.c1)), w.w2), w.c2);
    const z2 = tape.layerNorm(tape.add(z1, ff), w.g2, w.b2);
    return tape.add(tape.matmul(tape.meanPool(z2, B, L), w.wy), w.by);
  }
}

export const paramCount = (net: SeqNet) => net.params().reduce((s, p) => s + p.d.length, 0);

// ── Data ────────────────────────────────────────────────────────────────────

/** One training example: the `L` most recent feature rows of a symbol ending on `date`. */
export type Sequence = { symbol: string; date: string; rows: number[][]; y: number | null };

export function sequences(set: FeatureSet, L: number): Sequence[] {
  const bySym = new Map<string, FeatureRow[]>();
  for (const r of set.rows) {
    const list = bySym.get(r.symbol);
    if (list) list.push(r); else bySym.set(r.symbol, [r]);
  }
  const out: Sequence[] = [];
  for (const [symbol, rows] of bySym) {
    rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    for (let j = L - 1; j < rows.length; j++) out.push({ symbol, date: rows[j].date, rows: rows.slice(j - L + 1, j + 1).map((r) => r.x), y: rows[j].y });
  }
  return out;
}

type Scaler = { mu: number[]; sd: number[]; yMu: number; ySd: number };

function fitScaler(train: readonly Sequence[]): Scaler {
  const last = train.map((s) => s.rows[s.rows.length - 1]);
  const p = last[0].length;
  const mu: number[] = [], sd: number[] = [];
  for (let j = 0; j < p; j++) {
    const col = last.map((r) => r[j]);
    mu.push(mean(col));
    sd.push(std(col) || 1);
  }
  const ys = train.map((s) => s.y as number);
  return { mu, sd, yMu: mean(ys), ySd: std(ys) || 1 };
}

/** Replace one feature's history in sample s with that of sequence `source[s]` (permutation importance). */
type Permute = { feature: number; source: readonly number[] };

function toBatch(seqs: readonly Sequence[], idx: readonly number[], sc: Scaler, permute?: Permute): Batch {
  const L = seqs[idx[0]].rows.length, p = sc.mu.length, B = idx.length;
  const x = new Float64Array(B * L * p);
  idx.forEach((si, s) => {
    const rows = seqs[si].rows;
    const alt = permute ? seqs[permute.source[s]].rows : null;
    for (let t = 0; t < L; t++) for (let j = 0; j < p; j++) {
      const v = alt && j === permute!.feature ? alt[t][j] : rows[t][j];
      x[(s * L + t) * p + j] = Math.max(-5, Math.min(5, (v - sc.mu[j]) / sc.sd[j]));
    }
  });
  return { B, L, p, x };
}

function predictAll(net: SeqNet, seqs: readonly Sequence[], idx: readonly number[], sc: Scaler, permute?: Permute): number[] {
  const out: number[] = [];
  for (let a = 0; a < idx.length; a += 256) {
    const chunk = idx.slice(a, a + 256);
    const perm = permute ? { feature: permute.feature, source: permute.source.slice(a, a + 256) } : undefined;
    const pred = net.forward(new Tape(false), toBatch(seqs, chunk, sc, perm));
    for (let i = 0; i < chunk.length; i++) out.push(sc.yMu + sc.ySd * pred.d[i]);
  }
  return out;
}

export type TrainOpts = { epochs: number; batch: number; lr: number; weightDecay: number; patience: number };
export const TRAIN_DEFAULTS: TrainOpts = { epochs: 12, batch: 64, lr: 3e-3, weightDecay: 1e-4, patience: 2 };

/**
 * Train with minibatch AdamW. With `val` indices, stop after `patience`
 * epochs without improvement and restore the best weights; returns the
 * number of epochs actually used (for a refit on all the data).
 */
function train(net: SeqNet, seqs: readonly Sequence[], trainIdx: readonly number[], val: readonly number[] | null, sc: Scaler, o: TrainOpts, rng: Rng): { epochs: number; valMse: number | null } {
  const params = net.params();
  const opt = new Adam(params, o.lr, o.weightDecay);
  const order = [...trainIdx];
  let best = Infinity, bestEpoch = o.epochs, since = 0;
  let snapshot: Float64Array[] | null = null;
  const yv = val ? val.map((i) => seqs[i].y as number) : [];
  for (let ep = 1; ep <= o.epochs; ep++) {
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    for (let a = 0; a < order.length; a += o.batch) {
      const idx = order.slice(a, a + o.batch);
      const tape = new Tape();
      const pred = net.forward(tape, toBatch(seqs, idx, sc));
      const y = Float64Array.from(idx, (i) => ((seqs[i].y as number) - sc.yMu) / sc.ySd);
      tape.backward(tape.mse(pred, y));
      opt.step();
    }
    if (!val?.length) continue;
    const pv = predictAll(net, seqs, val, sc);
    const mse = mean(pv.map((p, i) => (p - yv[i]) ** 2));
    if (mse < best - 1e-12) {
      best = mse; bestEpoch = ep; since = 0;
      snapshot = params.map((p) => p.d.slice());
    } else if (++since >= o.patience) break;
  }
  if (snapshot) params.forEach((p, i) => p.d.set(snapshot![i]));
  return { epochs: val?.length ? bestEpoch : o.epochs, valMse: val?.length ? best : null };
}

export type SeqKind = "lstm" | "transformer";

export type SeqOpts = {
  seqLen?: number;
  hidden?: number;
  /** Use every `stride`-th date for training (overlapping windows add little but cost a lot). */
  stride?: number;
  testFrac?: number;
  seed?: number;
  train?: Partial<TrainOpts>;
  /** Max test sequences used for permutation importance. */
  importanceSample?: number;
};

function makeNet(kind: SeqKind, p: number, L: number, hidden: number, rng: Rng): SeqNet {
  return kind === "lstm" ? new Lstm(p, hidden, rng) : new Transformer(p, L, hidden, rng);
}

/**
 * Hold out the last `testFrac` of dates (purged by the label horizon), train
 * with early stopping on a purged validation tail of the training dates,
 * score out of sample, then refit on all labeled data for the chosen number
 * of epochs and forecast the target's newest sequence.
 */
export function sequenceModelReport(set: FeatureSet, target: string, kind: SeqKind, opts: SeqOpts = {}): ModelReport | null {
  const L = opts.seqLen ?? 20, H = opts.hidden ?? 16, stride = opts.stride ?? 3;
  const o: TrainOpts = { ...TRAIN_DEFAULTS, ...opts.train };
  const seqs = sequences(set, L);
  const labeled = seqs.map((s, i) => (s.y != null ? i : -1)).filter((i) => i >= 0);
  if (labeled.length < 500) return null;
  const dates = [...new Set(labeled.map((i) => seqs[i].date))].sort();
  const pos = new Map(dates.map((d, i) => [d, i] as const));
  const testStart = Math.floor(dates.length * (1 - (opts.testFrac ?? 0.3)));
  const trainEnd = testStart - set.horizon;
  const valStart = Math.floor(trainEnd * 0.8);
  const fitEnd = valStart - set.horizon;
  if (fitEnd < 100) return null;
  const at = (i: number) => pos.get(seqs[i].date)!;
  const thin = (i: number) => at(i) % stride === 0;
  const fitIdx = labeled.filter((i) => at(i) < fitEnd && thin(i));
  const valIdx = labeled.filter((i) => at(i) >= valStart && at(i) < trainEnd);
  const testIdx = labeled.filter((i) => at(i) >= testStart);
  const seed = opts.seed ?? 1;

  // 1. Out-of-sample evaluation.
  const scEval = fitScaler(fitIdx.map((i) => seqs[i]));
  const evalNet = makeNet(kind, set.names.length, L, H, mulberry32(seed));
  const fit = train(evalNet, seqs, fitIdx, valIdx, scEval, o, mulberry32(seed + 1));
  const bench = scEval.yMu;
  const testPred = predictAll(evalNet, seqs, testIdx, scEval);
  const points: OosPoint[] = testIdx.map((i, k) => ({ symbol: seqs[i].symbol, date: seqs[i].date, fold: 0, pred: testPred[k], bench, y: seqs[i].y as number }));
  const oos = scoreOos(points, set.horizon);

  // 2. Permutation importance on a test sample: MSE increase when one feature is shuffled across sequences.
  const prng = mulberry32(seed + 2);
  const sample = testIdx.length > (opts.importanceSample ?? 600)
    ? Array.from({ length: opts.importanceSample ?? 600 }, () => testIdx[Math.floor(prng() * testIdx.length)])
    : testIdx;
  const ys = sample.map((i) => seqs[i].y as number);
  const baseMse = mean(predictAll(evalNet, seqs, sample, scEval).map((p, k) => (p - ys[k]) ** 2));
  const rise = set.names.map((_, j) => {
    const source = [...sample];
    for (let a = source.length - 1; a > 0; a--) { const b = Math.floor(prng() * (a + 1)); [source[a], source[b]] = [source[b], source[a]]; }
    const m = mean(predictAll(evalNet, seqs, sample, scEval, { feature: j, source }).map((p, k) => (p - ys[k]) ** 2));
    return Math.max(0, m - baseMse);
  });
  const total = rise.reduce((a, b) => a + b, 0);

  // 3. Refit on everything labeled for the epochs early stopping chose, then forecast.
  const allIdx = labeled.filter(thin);
  const scAll = fitScaler(allIdx.map((i) => seqs[i]));
  const net = makeNet(kind, set.names.length, L, H, mulberry32(seed + 3));
  train(net, seqs, allIdx, null, scAll, { ...o, epochs: fit.epochs }, mulberry32(seed + 4));
  const mine = seqs.map((s, i) => (s.symbol === target ? i : -1)).filter((i) => i >= 0).sort((a, b) => (seqs[a].date < seqs[b].date ? -1 : 1));
  const history = mine.length ? predictAll(net, seqs, mine.slice(-504), scAll) : [];
  const forecast = history.length ? history[history.length - 1] : null;
  const flat = history.length < 2 || Math.max(...history) - Math.min(...history) < 1e-12;
  const score = forecast == null ? null : flat ? 0 : Math.round(100 * (2 * percentileOf(history, forecast) - 1));

  const notes: string[] = [];
  if (!oos.passed) notes.push(`failed held-out validation: IC ${Number.isFinite(oos.ic) ? oos.ic.toFixed(3) : "n/a"}, t ${Number.isFinite(oos.icT) ? oos.icT.toFixed(2) : "n/a"} (needs IC > 0 and t ≥ 2)`);
  if (oos.skill < 0) notes.push("held-out error is worse than forecasting the training mean");
  if (fit.epochs <= 1) notes.push("early stopping kept the first epoch: more training only fit noise");
  return {
    model: net.name,
    family: "sequence",
    oos,
    forecast,
    score,
    importance: set.names.map((feature, j) => ({ feature, weight: total > 0 ? rise[j] / total : 0 })).sort((a, b) => b.weight - a.weight),
    params: {
      seqLen: L, hidden: H, weights: paramCount(net), epochs: fit.epochs, maxEpochs: o.epochs,
      trainSequences: fitIdx.length, testSequences: testIdx.length, stride, testFrac: opts.testFrac ?? 0.3,
    },
    notes,
  };
}
