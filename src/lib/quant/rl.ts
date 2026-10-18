/**
 * Reinforcement learning: a tabular (double) Q-learning agent that decides each day
 * whether to hold the stock or sit in cash.
 *
 * State = (trailing 1-month return tercile, 1-month volatility tercile,
 * current position): 18 states. Reward = position × next-day return minus a
 * transaction cost on every change of position. Terciles come from each
 * symbol's own training window only. The agent learns from the target and its
 * sector peers (more episodes, same state definition), then runs greedily on
 * the held-out final 30% and is compared with buy-and-hold and cash.
 *
 * With daily data most of what any policy learns is noise. The agent only
 * counts as validated when, out of sample, it is invested on 10–90% of days
 * (otherwise it is cash or buy-and-hold, with no timing to test) and earns
 * timing alpha over buy-and-hold at t ≥ 2 (Newey-West; see timingAlpha).
 * The raw excess return over buy-and-hold is too noisy a test: when the
 * policy sits out turbulent stretches, the noise is buy-and-hold's.
 */

import { mean, std, quantile, mulberry32, type Rng } from "./stats";
import { TRADING_DAYS, maxDrawdown, sharpeDifferenceTest, timingAlpha } from "./risk";

export type RlSeries = { symbol: string; dates: readonly string[]; closes: readonly number[] };

export type RlOpts = {
  costBps?: number;
  trainFrac?: number;
  episodes?: number;
  alphaStart?: number;
  alphaEnd?: number;
  gamma?: number;
  /** Independent agents (exploration seeds) whose Q-tables are averaged. */
  runs?: number;
  seed?: number;
};

export const RL_DEFAULTS = { costBps: 10, trainFrac: 0.7, episodes: 40, alphaStart: 0.1, alphaEnd: 0.01, gamma: 0.9, runs: 5, seed: 1 };

const LEVEL = ["low", "mid", "high"] as const;
type Level = (typeof LEVEL)[number];

export type PolicyStats = {
  days: number;
  totalReturn: number;
  annReturn: number;
  sharpe: number;
  maxDrawdown: number;
  /** Fraction of days invested. */
  exposure: number;
  trades: number;
};

export type QState = {
  ret: Level;
  vol: Level;
  position: "flat" | "long";
  qFlat: number;
  qLong: number;
  visits: number;
  action: "flat" | "long";
};

export type RlReport = {
  target: string;
  asOf: string | null;
  cutDate: string;
  symbols: number;
  trainDays: number;
  testDays: number;
  states: QState[];
  /** Today's state for the target and the action the greedy policy takes from cash. */
  current: { ret: Level; vol: Level; action: "flat" | "long"; advantage: number; ifLong: "flat" | "long" } | null;
  oos: {
    target: { policy: PolicyStats; buyHold: PolicyStats; cash: PolicyStats } | null;
    /** Equal-weight across all symbols, per date: the basis for validation. */
    pooled: {
      days: number;
      policySharpe: number;
      buyHoldSharpe: number;
      /** Jobson-Korkie-Memmel z for policy Sharpe − buy-and-hold Sharpe (NaN when undefined). */
      sharpeDiffZ: number;
      excessAnnual: number;
      excessT: number;
      /** Annualized timing alpha over buy-and-hold, its Newey-West t and beta: the basis for validation. */
      alphaAnnual: number;
      alphaT: number;
      beta: number;
      exposure: number;
    };
  };
  /** −100..100: today's long-vs-cash advantage relative to the strongest state's. */
  score: number;
  passed: boolean;
  params: Record<string, number>;
  notes: string[];
};

type Prepared = {
  symbol: string;
  dates: readonly string[];
  /** Simple return from t−1 to t. */
  r: number[];
  retB: number[];
  volB: number[];
  train: number[];
  test: number[];
};

const tercile = (x: number, lo: number, hi: number) => (x <= lo ? 0 : x <= hi ? 1 : 2);

function prepare(s: RlSeries, cutDate: string): Prepared | null {
  const n = s.closes.length;
  if (n < 120 || s.dates.length !== n) return null;
  const lp = s.closes.map(Math.log);
  const r = s.closes.map((c, i) => (i ? c / s.closes[i - 1] - 1 : 0));
  const lr = lp.map((v, i) => (i ? v - lp[i - 1] : 0));
  const ret21 = lp.map((v, i) => (i >= 21 ? v - lp[i - 21] : NaN));
  const vol21 = lr.map((_, i) => (i >= 21 ? std(lr.slice(i - 20, i + 1)) : NaN));
  // Decision days need a next-day reward, so t runs to n − 2. A training
  // day's reward must also be realized before the cut (one-day purge).
  const days = Array.from({ length: n - 22 }, (_, k) => k + 21).filter((t) => t + 1 < n && Number.isFinite(ret21[t]) && Number.isFinite(vol21[t]));
  const train = days.filter((t) => s.dates[t + 1] < cutDate);
  const test = days.filter((t) => s.dates[t] >= cutDate);
  if (train.length < 60) return null;
  const rq = [quantile(train.map((t) => ret21[t]), 1 / 3), quantile(train.map((t) => ret21[t]), 2 / 3)];
  const vq = [quantile(train.map((t) => vol21[t]), 1 / 3), quantile(train.map((t) => vol21[t]), 2 / 3)];
  return {
    symbol: s.symbol,
    dates: s.dates,
    r,
    retB: ret21.map((x) => (Number.isFinite(x) ? tercile(x, rq[0], rq[1]) : -1)),
    volB: vol21.map((x) => (Number.isFinite(x) ? tercile(x, vq[0], vq[1]) : -1)),
    train,
    test,
  };
}

const stateOf = (p: Prepared, t: number, pos: number) => (p.retB[t] * 3 + p.volB[t]) * 2 + pos;
const greedy = (Q: Float64Array, s: number) => (Q[s * 2 + 1] > Q[s * 2] ? 1 : 0);

/**
 * Double Q-learning (van Hasselt, 2010). Plain Q-learning's max over noisy
 * estimates is biased upward most where two actions are nearly tied, which
 * here is staying in cash vs buying, so it drifts toward cash. Keeping two
 * tables and valuing each one's greedy choice with the other removes that.
 */
function trainQ(data: readonly Prepared[], o: typeof RL_DEFAULTS, cost: number, rng: Rng, visits: Float64Array): Float64Array {
  const QA = new Float64Array(36), QB = new Float64Array(36), Q = new Float64Array(36);
  const order = data.map((_, i) => i);
  for (let ep = 0; ep < o.episodes; ep++) {
    const frac = o.episodes > 1 ? ep / (o.episodes - 1) : 1;
    const eps = Math.max(0.05, 1 - frac / 0.7);
    const alpha = o.alphaStart + (o.alphaEnd - o.alphaStart) * frac;
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    for (const k of order) {
      const p = data[k];
      let pos = 0;
      for (let idx = 0; idx < p.train.length; idx++) {
        const t = p.train[idx];
        const s = stateOf(p, t, pos);
        for (let i = s * 2; i < s * 2 + 2; i++) Q[i] = QA[i] + QB[i];
        const a = rng() < eps ? (rng() < 0.5 ? 0 : 1) : greedy(Q, s);
        const reward = a * p.r[t + 1] - cost * Math.abs(a - pos);
        const [U, V] = rng() < 0.5 ? [QA, QB] : [QB, QA];
        const next = p.train[idx + 1];
        let target = reward;
        if (next === t + 1) {
          const s2 = stateOf(p, next, a);
          target += o.gamma * V[s2 * 2 + greedy(U, s2)];
        }
        U[s * 2 + a] += alpha * (target - U[s * 2 + a]);
        visits[s * 2 + a]++;
        pos = a;
      }
    }
  }
  for (let i = 0; i < 36; i++) Q[i] = (QA[i] + QB[i]) / 2;
  return Q;
}

function stats(daily: readonly number[], positions: readonly number[]): PolicyStats {
  const n = daily.length;
  if (!n) return { days: 0, totalReturn: 0, annReturn: 0, sharpe: 0, maxDrawdown: 0, exposure: 0, trades: 0 };
  const curve: number[] = [1];
  for (const d of daily) curve.push(curve[curve.length - 1] * (1 + d));
  const total = curve[n] - 1;
  const sd = std(daily);
  let trades = 0;
  for (let i = 0; i < positions.length; i++) if (positions[i] !== (i ? positions[i - 1] : 0)) trades++;
  return {
    days: n,
    totalReturn: total,
    annReturn: Math.pow(Math.max(1e-9, 1 + total), TRADING_DAYS / n) - 1,
    sharpe: sd > 0 ? (mean(daily) / sd) * Math.sqrt(TRADING_DAYS) : 0,
    maxDrawdown: maxDrawdown(curve).maxDrawdown,
    exposure: positions.length ? mean(positions) : 0,
    trades,
  };
}

/** Run the greedy policy over a symbol's test days, starting in cash. */
function runPolicy(Q: Float64Array, p: Prepared, cost: number) {
  let pos = 0;
  const byDate = new Map<string, { policy: number; hold: number }>();
  const pnl: number[] = [], hold: number[] = [], positions: number[] = [];
  for (const t of p.test) {
    const a = greedy(Q, stateOf(p, t, pos));
    // Decided at t's close, earns t → t+1, pays cost on a change.
    const d = a * p.r[t + 1] - cost * Math.abs(a - pos);
    pnl.push(d);
    hold.push(p.r[t + 1]);
    positions.push(a);
    byDate.set(p.dates[t + 1], { policy: d, hold: p.r[t + 1] });
    pos = a;
  }
  return { pnl, hold, positions, byDate };
}

const tStat = (xs: readonly number[]) => (xs.length > 2 && std(xs) > 0 ? mean(xs) / (std(xs) / Math.sqrt(xs.length)) : 0);

export function rlReport(series: readonly RlSeries[], target: string, opts: RlOpts = {}): RlReport | null {
  const o = { ...RL_DEFAULTS, ...opts };
  const cost = o.costBps / 10_000;
  const own = series.find((s) => s.symbol === target);
  if (!own || own.closes.length < 120) return null;
  const cutDate = own.dates[Math.floor(21 + (own.dates.length - 22) * o.trainFrac)];
  const data = series.map((s) => prepare(s, cutDate)).filter((p): p is Prepared => p !== null);
  const mine = data.find((p) => p.symbol === target);
  if (!mine) return null;

  const visits = new Float64Array(36);
  const Q = new Float64Array(36);
  for (let run = 0; run < o.runs; run++) {
    const q = trainQ(data, o, cost, mulberry32(o.seed + 7919 * run), visits);
    for (let i = 0; i < 36; i++) Q[i] += q[i] / o.runs;
  }

  // Held-out evaluation: every symbol, then an equal-weight portfolio by date.
  const runs = data.map((p) => ({ p, ...runPolicy(Q, p, cost) }));
  const dates = new Map<string, { policy: number[]; hold: number[] }>();
  for (const { byDate } of runs) for (const [d, v] of byDate) {
    const e = dates.get(d) ?? { policy: [], hold: [] };
    e.policy.push(v.policy); e.hold.push(v.hold);
    dates.set(d, e);
  }
  const ordered = [...dates.keys()].sort();
  const polEw = ordered.map((d) => mean(dates.get(d)!.policy));
  const holdEw = ordered.map((d) => mean(dates.get(d)!.hold));
  const excess = polEw.map((x, i) => x - holdEw[i]);
  const jkm = sharpeDifferenceTest(polEw, holdEw);
  const ta = timingAlpha(polEw, holdEw);
  const pooled = {
    days: ordered.length,
    policySharpe: stats(polEw, []).sharpe,
    buyHoldSharpe: stats(holdEw, []).sharpe,
    sharpeDiffZ: jkm?.z ?? NaN,
    excessAnnual: mean(excess) * TRADING_DAYS,
    excessT: tStat(excess),
    alphaAnnual: ta?.alpha ?? NaN,
    alphaT: ta?.t ?? NaN,
    beta: ta?.beta ?? NaN,
    exposure: mean(runs.flatMap((r) => r.positions)),
  };
  const t = runs.find((r) => r.p.symbol === target)!;
  const targetOos = t.pnl.length
    ? { policy: stats(t.pnl, t.positions), buyHold: stats(t.hold, t.hold.map(() => 1)), cash: stats(t.hold.map(() => 0), t.hold.map(() => 0)) }
    : null;

  const states: QState[] = [];
  for (let rb = 0; rb < 3; rb++) for (let vb = 0; vb < 3; vb++) for (let pos = 0; pos < 2; pos++) {
    const s = (rb * 3 + vb) * 2 + pos;
    states.push({ ret: LEVEL[rb], vol: LEVEL[vb], position: pos ? "long" : "flat", qFlat: Q[s * 2], qLong: Q[s * 2 + 1], visits: visits[s * 2] + visits[s * 2 + 1], action: greedy(Q, s) ? "long" : "flat" });
  }

  const last = mine.dates.length - 1;
  const rb = mine.retB[last], vb = mine.volB[last];
  let current: RlReport["current"] = null;
  let score = 0;
  if (rb >= 0 && vb >= 0) {
    const sFlat = (rb * 3 + vb) * 2, sLong = sFlat + 1;
    const adv = Q[sFlat * 2 + 1] - Q[sFlat * 2];
    current = { ret: LEVEL[rb], vol: LEVEL[vb], action: adv > 0 ? "long" : "flat", advantage: adv, ifLong: greedy(Q, sLong) ? "long" : "flat" };
    const maxAdv = Math.max(...Array.from({ length: 9 }, (_, m) => Math.abs(Q[m * 4 + 1] - Q[m * 4])));
    score = maxAdv > 0 ? Math.round((100 * adv) / maxAdv) : 0;
  }

  const passed = pooled.exposure >= 0.1 && pooled.exposure <= 0.9 && pooled.alphaT >= 2;
  const notes: string[] = [];
  if (pooled.exposure < 0.1) notes.push(`policy stayed in cash ${(100 * (1 - pooled.exposure)).toFixed(0)}% of held-out days: no timing evidence`);
  else if (pooled.exposure > 0.9) notes.push(`policy was invested ${(100 * pooled.exposure).toFixed(0)}% of held-out days: effectively buy-and-hold, no timing to validate`);
  else if (!passed) {
    const f = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
    notes.push(`policy earned no timing alpha over buy-and-hold out of sample (${f(100 * pooled.alphaAnnual, 1)}% a year, t ${f(pooled.alphaT)}, needs ≥ 2; Sharpe ${f(pooled.policySharpe)} vs ${f(pooled.buyHoldSharpe)})`);
  }
  const thin = states.filter((s) => s.visits < 30 * o.runs).length;
  if (thin) notes.push(`${thin} of 18 states were visited fewer than 30 times per agent in training`);

  return {
    target,
    asOf: own.dates[last] ?? null,
    cutDate,
    symbols: data.length,
    trainDays: mine.train.length,
    testDays: mine.test.length,
    states,
    current,
    oos: { target: targetOos, pooled },
    score,
    passed,
    params: { costBps: o.costBps, trainFrac: o.trainFrac, episodes: o.episodes, alphaStart: o.alphaStart, alphaEnd: o.alphaEnd, gamma: o.gamma, runs: o.runs },
    notes,
  };
}
