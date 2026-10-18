/**
 * Backtesting, built around the four classic pitfalls. The timing rules the
 * technical and momentum agents use (SMA crossovers, time-series momentum,
 * RSI and Bollinger reversion, MACD, the composite technical score) are run
 * long/flat on the target and its sector peers, pooled equal-weight:
 *
 * - look-ahead: a position decided at the close of bar t earns bar t+1's
 *   return, and every rule is recomputed on truncated history; a rule whose
 *   past positions change when later bars are removed is excluded;
 * - costs: every change of position pays costBps; gross and net results are
 *   both kept, with the cost per unit of turnover that would erase the edge;
 * - overfitting: each family's parameters are chosen walk-forward (expanding
 *   window, traded only on the block after it), the gap to hindsight-picked
 *   parameters is reported, and the best full-period rule's timing alpha is
 *   deflated for the number of rules tried;
 * - survivorship: the universe is today's members, which flatters absolute
 *   returns; flagged on every report, since no fix exists without
 *   delisted-name data.
 *
 * A family counts as validated when, walk-forward and after costs, it earns
 * timing alpha over buy-and-hold at t ≥ 2 (Newey-West) while invested on
 * 10–90% of days (see timingAlpha: a Sharpe comparison would favor any rule
 * that is often in cash whenever the asset falls). The Sharpe test is still
 * reported.
 */

import { mean, std, correlation, skewness, excessKurtosis, normCdf, normInv, clamp } from "./stats";
import { sma, rsi, macd, bollinger, technicalScoreSeries } from "./technicals";
import { TRADING_DAYS, sharpe, sortino, maxDrawdown, curveCagr, sharpeDifferenceTest, timingAlpha } from "./risk";
import { walkForwardFolds } from "./ml";
import type { Bar } from "./types";

export type Family = "sma-cross" | "ts-momentum" | "rsi-reversion" | "macd" | "bollinger-reversion" | "technical-composite";

export const FAMILY_LABEL: Record<Family, string> = {
  "sma-cross": "SMA crossover",
  "ts-momentum": "Time-series momentum",
  "rsi-reversion": "RSI reversion",
  macd: "MACD",
  "bollinger-reversion": "Bollinger reversion",
  "technical-composite": "Composite technical score",
};

/** A long/flat rule: the position (0 or 1) decided at each bar's close, NaN while it warms up. */
export type Strategy = {
  family: Family;
  label: string;
  warmup: number;
  positions: (bars: readonly Bar[]) => number[];
};

const closes = (bars: readonly Bar[]) => bars.map((b) => b.close);

const level = (n: number, warmup: number, on: (i: number) => boolean) =>
  Array.from({ length: n }, (_, i) => (i < warmup ? NaN : on(i) ? 1 : 0));

/** Long from the bar `enter` fires until the bar `exit` fires. */
function latch(n: number, warmup: number, enter: (i: number) => boolean, exit: (i: number) => boolean): number[] {
  const out = new Array<number>(n).fill(NaN);
  let p = 0;
  for (let i = warmup; i < n; i++) {
    if (p === 0 ? enter(i) : exit(i)) p = 1 - p;
    out[i] = p;
  }
  return out;
}

export function smaCross(fast: number, slow: number): Strategy {
  return {
    family: "sma-cross", label: `SMA ${fast}/${slow}`, warmup: slow - 1,
    positions: (bars) => {
      const c = closes(bars), f = sma(c, fast), s = sma(c, slow);
      return level(c.length, slow - 1, (i) => f[i] > s[i]);
    },
  };
}

/** Long while the price `skip` bars ago is above the price `from` bars ago (12-1 momentum = 252, 21). */
export function tsMomentum(from: number, skip: number): Strategy {
  const m = (k: number) => Math.round(k / 21);
  return {
    family: "ts-momentum", label: skip ? `${m(from)}-${m(skip)} momentum` : `${m(from)}-month momentum`, warmup: from,
    positions: (bars) => {
      const c = closes(bars);
      return level(c.length, from, (i) => c[i - skip] > c[i - from]);
    },
  };
}

/** Buy when RSI(14) drops below `enterBelow`, sell once it recovers above `exitAbove`. */
export function rsiReversion(enterBelow: number, exitAbove: number): Strategy {
  return {
    family: "rsi-reversion", label: `RSI <${enterBelow} → >${exitAbove}`, warmup: 14,
    positions: (bars) => {
      const r = rsi(closes(bars));
      return latch(bars.length, 14, (i) => r[i] < enterBelow, (i) => r[i] > exitAbove);
    },
  };
}

/** Long while the MACD line is above its signal line. */
export function macdCross(fast: number, slow: number, signal: number): Strategy {
  const warmup = slow + signal - 2;
  return {
    family: "macd", label: `MACD ${fast}/${slow}/${signal}`, warmup,
    positions: (bars) => {
      const h = macd(closes(bars), fast, slow, signal).hist;
      return level(bars.length, warmup, (i) => h[i] > 0);
    },
  };
}

/** Buy a close below the lower band (20 days, kσ); sell back at the 20-day mean. */
export function bollingerReversion(k: number): Strategy {
  return {
    family: "bollinger-reversion", label: `Bollinger ${k}σ reversion`, warmup: 19,
    positions: (bars) => {
      const c = closes(bars), b = bollinger(c, 20, k);
      return latch(c.length, 19, (i) => c[i] < b.lower[i], (i) => c[i] >= b.mid[i]);
    },
  };
}

/** Long while the technical analyst's composite score is above `above`. */
export function technicalComposite(above: number): Strategy {
  return {
    family: "technical-composite", label: `Technical score > ${above}`, warmup: 199,
    positions: (bars) => {
      const s = technicalScoreSeries(bars);
      return level(bars.length, 199, (i) => s[i] > above);
    },
  };
}

/** Every rule tried. Each one counts as a trial when the best result is deflated. */
export const STRATEGIES: readonly Strategy[] = [
  smaCross(10, 50), smaCross(20, 100), smaCross(50, 200),
  tsMomentum(252, 21), tsMomentum(126, 21), tsMomentum(63, 0),
  rsiReversion(30, 50), rsiReversion(25, 50), rsiReversion(30, 70),
  macdCross(12, 26, 9), macdCross(8, 17, 9), macdCross(5, 35, 5),
  bollingerReversion(1.5), bollingerReversion(2), bollingerReversion(2.5),
  technicalComposite(0), technicalComposite(25),
];

export type Simulated = { gross: number[]; net: number[]; held: number[]; turnover: number[] };

/**
 * Daily returns of a long/flat position series with a one-bar shift: the
 * position decided at the close of bar t (t ≥ start) is held over bar t+1
 * and every change of position pays `costBps`; cash earns rf. The first
 * entry, from flat at `start`, is charged too, so buy-and-hold pays it once.
 * Output index j is bar start + 1 + j.
 */
export function simulate(adjCloses: readonly number[], positions: readonly number[], start: number, costBps: number, rfAnnual = 0): Simulated {
  const c = costBps / 1e4, rf = rfAnnual / TRADING_DAYS;
  const out: Simulated = { gross: [], net: [], held: [], turnover: [] };
  let prev = 0;
  for (let t = start; t < adjCloses.length - 1; t++) {
    const p = Number.isFinite(positions[t]) ? positions[t] : 0;
    const g = p * (adjCloses[t + 1] / adjCloses[t] - 1) + (1 - p) * rf;
    const turn = Math.abs(p - prev);
    out.gross.push(g);
    out.net.push(g - c * turn);
    out.held.push(p);
    out.turnover.push(turn);
    prev = p;
  }
  return out;
}

export type BacktestStats = {
  days: number;
  totalReturn: number;
  cagr: number;
  annVol: number;
  sharpe: number;
  sortino: number;
  maxDrawdown: number;
  exposure: number;
  /** One-way turnover per year: a full round trip counts 2. */
  turnover: number;
};

function equity(rets: readonly number[]): number[] {
  const lv = [1];
  for (const r of rets) lv.push(lv[lv.length - 1] * (1 + r));
  return lv;
}

export function backtestStats(net: readonly number[], held: readonly number[], turnover: readonly number[], rfAnnual = 0): BacktestStats {
  const lv = equity(net);
  return {
    days: net.length,
    totalReturn: lv[lv.length - 1] - 1,
    cagr: curveCagr(lv),
    annVol: std(net) * Math.sqrt(TRADING_DAYS),
    sharpe: sharpe(net, rfAnnual),
    sortino: sortino(net, rfAnnual),
    maxDrawdown: maxDrawdown(lv).maxDrawdown,
    exposure: mean(held),
    turnover: mean(turnover) * TRADING_DAYS,
  };
}

/**
 * Recompute each rule on truncated history. If its position on any bar
 * before the cut changes, it used data from after that bar. (A rule that
 * peeks one bar ahead differs only on the last bar before a cut, about half
 * the time, so eight cuts miss it with probability 1/256.)
 */
export function lookAheadViolations(strategies: readonly Strategy[], bars: readonly Bar[], cuts: readonly number[] = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95]): Map<Strategy, string> {
  const out = new Map<Strategy, string>();
  for (const st of strategies) {
    const full = st.positions(bars);
    for (const f of cuts) {
      const m = Math.floor(bars.length * f);
      if (m <= st.warmup + 1) continue;
      const part = st.positions(bars.slice(0, m));
      const bad = part.length !== m ? 0 : part.findIndex((v, i) => !(v === full[i] || (Number.isNaN(v) && Number.isNaN(full[i]))));
      if (bad >= 0) {
        out.set(st, `${st.label}: position on ${bars[bad].date} changes when bars after ${bars[m - 1].date} are removed`);
        break;
      }
    }
  }
  return out;
}

const EULER_GAMMA = 0.5772156649015329;

/**
 * Deflated Sharpe ratio (Bailey & López de Prado, 2014): the probability that
 * the best of N per-period Sharpe ratios beats SR₀, the maximum expected
 * from N trials with no skill,
 *   SR₀ = σ₀·((1−γ)Φ⁻¹(1 − 1/N) + γΦ⁻¹(1 − 1/(N·e))),
 * with a standard error that allows for skew and fat tails:
 *   DSR = Φ((SR − SR₀)·√(T−1) / √(1 − skew·SR + (kurt − 1)/4·SR²)).
 * σ₀ = 1/√(T−1) is the sampling error of a Sharpe estimate when the true
 * Sharpe is zero. (The paper estimates it from the dispersion across trials,
 * which on real data also contains genuine differences between rules, so a
 * bad rule would make a good one look worse.) Pass N as the effective number
 * of independent trials when trials are correlated.
 */
export function deflatedSharpe(best: number, trials: number, T: number, skew: number, exKurt: number): { dsr: number; sr0: number } {
  const sr0 = trials > 1
    ? Math.max(0, ((1 - EULER_GAMMA) * normInv(1 - 1 / trials) + EULER_GAMMA * normInv(1 - 1 / (trials * Math.E))) / Math.sqrt(T - 1))
    : 0;
  const se2 = (1 - skew * best + ((exKurt + 2) / 4) * best * best) / (T - 1);
  return { dsr: se2 > 0 ? normCdf((best - sr0) / Math.sqrt(se2)) : NaN, sr0 };
}

export type BacktestSeries = { symbol: string; bars: readonly Bar[] };

export type BacktestOpts = {
  costBps?: number;
  rfAnnual?: number;
  folds?: number;
  testFrac?: number;
  strategies?: readonly Strategy[];
};

export const BACKTEST_DEFAULTS = { costBps: 10, rfAnnual: 0, folds: 5, testFrac: 0.5 };

export type WalkForward = BacktestStats & {
  grossSharpe: number;
  buyHoldSharpe: number;
  /** Jobson-Korkie-Memmel z of walk-forward vs buy-and-hold Sharpe (returns in excess of rf). Reported, not used to validate. */
  sharpeDiffZ: number;
  /** Annualized timing alpha over buy-and-hold after costs, its Newey-West t and the beta (≈ average exposure). */
  alpha: number;
  alphaT: number;
  beta: number;
  grossAlpha: number;
  /** Cost per unit of turnover, in bps, at which the timing alpha is gone; null when there is none before costs. */
  breakEvenBps: number | null;
  /** The parameters chosen for each test block, using only the data before it. */
  picks: { from: string; label: string }[];
  /** The same picks traded on the target alone. */
  onTarget: { days: number; sharpe: number; buyHoldSharpe: number; exposure: number; alpha: number; alphaT: number } | null;
};

export type FamilyResult = {
  family: Family;
  name: string;
  candidates: string[];
  /** Parameters picked with hindsight on the test span itself: what a naive backtest would report. */
  hindsight: { label: string; sharpe: number };
  walkForward: WalkForward;
  /** Today's position on the target under the parameters walk-forward would pick now. */
  current: { label: string; position: number } | null;
  passed: boolean;
};

export type BacktestReport = {
  target: string;
  asOf: string;
  symbols: string[];
  start: string;
  oosStart: string;
  end: string;
  days: number;
  oosDays: number;
  /** Buy-and-hold over the walk-forward test span (pooled). */
  buyHold: BacktestStats;
  families: FamilyResult[];
  /** Walk-forward that picks the best rule of any family for each block. */
  overall: { hindsight: { label: string; sharpe: number }; walkForward: WalkForward };
  /**
   * The best full-period rule by appraisal ratio (timing alpha per unit of
   * residual risk, annualized), deflated for the number of rules tried.
   */
  inSample: { label: string; appraisalRatio: number; trials: number; effectiveTrials: number; sr0: number; deflatedSharpe: number } | null;
  pitfalls: {
    lookAhead: { checked: number; violations: string[] };
    survivorship: { flagged: true; note: string };
    overfitting: { flagged: boolean; deflatedSharpe: number | null; hindsightSharpe: number; walkForwardSharpe: number };
    costs: { flagged: boolean; costBps: number; grossSharpe: number; netSharpe: number; breakEvenBps: number | null };
  };
  /** Equity of the overall walk-forward rule and of buy-and-hold over the test span, at most 60 points. */
  curve: { date: string; strategy: number; buyHold: number }[];
  /** −100…100 from validated families' current positions (long +, flat −), scaled by their alpha t; 0 when none validated. */
  score: number;
  passed: boolean;
  params: { costBps: number; rfAnnual: number; folds: number; testFrac: number; rules: number; warmup: number };
  notes: string[];
};

export const SURVIVORSHIP_NOTE =
  "universe is today's members: names delisted, acquired or dropped over the window are missing, which flatters absolute returns (the rule-vs-buy-and-hold comparison shares the bias)";

type Pooled = { gross: number[]; net: number[]; held: number[]; turnover: number[] };

export function backtestReport(series: readonly BacktestSeries[], target: string, opts: BacktestOpts = {}): BacktestReport | null {
  const o = { ...BACKTEST_DEFAULTS, ...opts };
  const clean = series.map((s) => ({ symbol: s.symbol, bars: s.bars.filter((b) => b.close > 0 && b.adjClose > 0) }));
  const own = clean.find((s) => s.symbol === target);
  if (!own) return null;
  const tried = o.strategies ?? STRATEGIES;
  const leaks = lookAheadViolations(tried, own.bars);
  const rules = tried.filter((s) => !leaks.has(s));
  if (!rules.length) return null;
  const W = Math.max(...rules.map((s) => s.warmup));

  type Run = { symbol: string; dates: string[]; hold: Simulated; sims: Simulated[]; now: number[] };
  const runs: Run[] = [];
  for (const s of clean) {
    const n = s.bars.length;
    if (n < W + 61) continue;
    const adj = s.bars.map((b) => b.adjClose);
    const pos = rules.map((st) => st.positions(s.bars));
    runs.push({
      symbol: s.symbol,
      dates: s.bars.slice(W + 1).map((b) => b.date),
      hold: simulate(adj, new Array<number>(n).fill(1), W, o.costBps, o.rfAnnual),
      sims: pos.map((p) => simulate(adj, p, W, o.costBps, o.rfAnnual)),
      now: pos.map((p) => p[n - 1]),
    });
  }
  const ownRun = runs.find((r) => r.symbol === target);
  if (!ownRun) return null;

  // Equal-weight pool across names on each date (daily rebalanced).
  const dates = [...new Set(runs.flatMap((r) => r.dates))].sort();
  const D = dates.length;
  if (D < 300) return null;
  const at = new Map(dates.map((d, i) => [d, i]));
  const count = new Array<number>(D).fill(0);
  for (const r of runs) for (const d of r.dates) count[at.get(d)!]++;
  const pool = (get: (r: Run) => Simulated): Pooled => {
    const p: Pooled = { gross: new Array<number>(D).fill(0), net: new Array<number>(D).fill(0), held: new Array<number>(D).fill(0), turnover: new Array<number>(D).fill(0) };
    for (const r of runs) {
      const s = get(r);
      r.dates.forEach((d, j) => {
        const i = at.get(d)!;
        p.gross[i] += s.gross[j]; p.net[i] += s.net[j]; p.held[i] += s.held[j]; p.turnover[i] += s.turnover[j];
      });
    }
    for (let i = 0; i < D; i++) { p.gross[i] /= count[i]; p.net[i] /= count[i]; p.held[i] /= count[i]; p.turnover[i] /= count[i]; }
    return p;
  };
  const hold = pool((r) => r.hold);
  const pooled = rules.map((_, k) => pool((r) => r.sims[k]));

  const folds = walkForwardFolds(D, { folds: o.folds, testFrac: o.testFrac });
  if (!folds.length) return null;
  const first = folds[0].testStart;
  const rfd = o.rfAnnual / TRADING_DAYS;
  const excess = (xs: readonly number[]) => xs.map((x) => x - rfd);
  const sharpeOn = (k: number, a: number, b: number) => {
    const v = sharpe(pooled[k].net.slice(a, b), o.rfAnnual);
    return Number.isFinite(v) ? v : -Infinity;
  };
  const bestOf = (ks: readonly number[], a: number, b: number) => {
    let best = ks[0], top = -Infinity;
    for (const k of ks) { const v = sharpeOn(k, a, b); if (v > top) { top = v; best = k; } }
    return best;
  };
  const ownAt = new Map(ownRun.dates.map((d, j) => [d, j]));

  // Picks for each block use only the blocks before it. (Switching rules at a
  // block boundary isn't charged: at most one trade per block.)
  const walk = (ks: readonly number[]) => {
    const net: number[] = [], gross: number[] = [], held: number[] = [], turn: number[] = [];
    const tNet: number[] = [], tHold: number[] = [], tHeld: number[] = [];
    const picks: { from: string; label: string }[] = [];
    for (const f of folds) {
      const k = bestOf(ks, 0, f.trainEnd);
      picks.push({ from: dates[f.testStart], label: rules[k].label });
      for (let i = f.testStart; i < f.testEnd; i++) {
        net.push(pooled[k].net[i]); gross.push(pooled[k].gross[i]); held.push(pooled[k].held[i]); turn.push(pooled[k].turnover[i]);
        const j = ownAt.get(dates[i]);
        if (j !== undefined) { tNet.push(ownRun.sims[k].net[j]); tHold.push(ownRun.hold.net[j]); tHeld.push(ownRun.sims[k].held[j]); }
      }
    }
    const span = (p: Pooled, key: keyof Pooled) => p[key].slice(first, first + net.length);
    const holdNet = span(hold, "net");
    const holdEx = excess(holdNet);
    const ta = timingAlpha(excess(net), holdEx);
    const taGross = timingAlpha(excess(gross), excess(span(hold, "gross")));
    const tTa = timingAlpha(excess(tNet), excess(tHold));
    const meanTurn = mean(turn);
    const wf: WalkForward = {
      ...backtestStats(net, held, turn, o.rfAnnual),
      grossSharpe: sharpe(gross, o.rfAnnual),
      buyHoldSharpe: sharpe(holdNet, o.rfAnnual),
      sharpeDiffZ: sharpeDifferenceTest(excess(net), holdEx)?.z ?? NaN,
      alpha: ta?.alpha ?? NaN,
      alphaT: ta?.t ?? NaN,
      beta: ta?.beta ?? NaN,
      grossAlpha: taGross?.alpha ?? NaN,
      breakEvenBps: taGross && taGross.alpha > 0 && meanTurn > 0 ? (1e4 * taGross.alpha) / TRADING_DAYS / meanTurn : null,
      picks,
      onTarget: tNet.length >= 60
        ? { days: tNet.length, sharpe: sharpe(tNet, o.rfAnnual), buyHoldSharpe: sharpe(tHold, o.rfAnnual), exposure: mean(tHeld), alpha: tTa?.alpha ?? NaN, alphaT: tTa?.t ?? NaN }
        : null,
    };
    return { wf, net, holdNet };
  };
  const hindsight = (ks: readonly number[]) => {
    const k = bestOf(ks, first, D);
    return { label: rules[k].label, sharpe: sharpeOn(k, first, D) };
  };
  const validated = (wf: WalkForward) => wf.exposure >= 0.1 && wf.exposure <= 0.9 && wf.alphaT >= 2;

  const families: FamilyResult[] = [...new Set(rules.map((s) => s.family))].map((family) => {
    const ks = rules.flatMap((s, k) => (s.family === family ? [k] : []));
    const { wf } = walk(ks);
    const kNow = bestOf(ks, 0, D);
    const pos = ownRun.now[kNow];
    return {
      family,
      name: FAMILY_LABEL[family],
      candidates: ks.map((k) => rules[k].label),
      hindsight: hindsight(ks),
      walkForward: wf,
      current: Number.isFinite(pos) ? { label: rules[kNow].label, position: pos } : null,
      passed: validated(wf),
    };
  });

  const allKs = rules.map((_, k) => k);
  const overall = walk(allKs);
  const overallHindsight = hindsight(allKs);

  // Full-period deflated appraisal ratio: each rule's timing return
  // r_rule − β·r_hold (alpha plus residual) is treated as a trial.
  const holdEx = excess(hold.net);
  const actives = pooled.map((p) => {
    const ex = excess(p.net);
    const b = timingAlpha(ex, holdEx)?.beta ?? 0;
    return ex.map((x, i) => x - b * holdEx[i]);
  });
  const srs = actives.map((a) => { const s = std(a); return s > 0 ? mean(a) / s : NaN; });
  const valid = allKs.filter((k) => Number.isFinite(srs[k]));
  let inSample: BacktestReport["inSample"] = null;
  if (valid.length) {
    const kBest = valid.reduce((b, k) => (srs[k] > srs[b] ? k : b));
    let rhoSum = 0, pairs = 0;
    for (let i = 0; i < valid.length; i++) {
      for (let j = i + 1; j < valid.length; j++) {
        const r = correlation(actives[valid[i]], actives[valid[j]]);
        if (Number.isFinite(r)) { rhoSum += r; pairs++; }
      }
    }
    const rhoBar = pairs ? clamp(rhoSum / pairs, 0, 1) : 1;
    const nEff = rhoBar + (1 - rhoBar) * valid.length;
    const a = actives[kBest];
    const { dsr, sr0 } = deflatedSharpe(srs[kBest], nEff, D, skewness(a), excessKurtosis(a));
    inSample = { label: rules[kBest].label, appraisalRatio: srs[kBest] * Math.sqrt(TRADING_DAYS), trials: valid.length, effectiveTrials: nEff, sr0, deflatedSharpe: dsr };
  }

  const owf = overall.wf;
  const costsFlagged = owf.breakEvenBps !== null && owf.breakEvenBps < 2 * o.costBps;
  const winners = families.filter((f) => f.passed);
  const voters = winners.filter((f) => f.current);
  const score = voters.length
    ? Math.round(100 * mean(voters.map((f) => (f.current!.position > 0 ? 1 : -1) * Math.min(1, f.walkForward.alphaT / 4))))
    : 0;

  const lvS = equity(overall.net), lvH = equity(overall.holdNet);
  const step = Math.max(1, Math.ceil(lvS.length / 60));
  const curve: BacktestReport["curve"] = [];
  for (let i = 0; i < lvS.length; i += step) curve.push({ date: dates[first - 1 + i], strategy: lvS[i], buyHold: lvH[i] });
  if ((lvS.length - 1) % step) curve.push({ date: dates[D - 1], strategy: lvS[lvS.length - 1], buyHold: lvH[lvH.length - 1] });

  const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "n/a");
  const pct = (x: number) => (Number.isFinite(x) ? `${(100 * x).toFixed(1)}%` : "n/a");
  const notes: string[] = [];
  if (leaks.size) notes.push(`look-ahead: ${leaks.size} rule(s) changed past positions when later bars were removed and were excluded`);
  if (!winners.length) notes.push("no rule family earned timing alpha over buy-and-hold out of sample at t ≥ 2 (walk-forward, after costs)");
  for (const f of winners) {
    const w = f.walkForward;
    notes.push(`${f.name} earned timing alpha out of sample: ${pct(w.alpha)} a year (t ${w.alphaT.toFixed(1)}), Sharpe ${f2(w.sharpe)} vs buy-and-hold ${f2(w.buyHoldSharpe)}`);
  }
  notes.push(`hindsight-picked rule (${overallHindsight.label}) shows Sharpe ${f2(overallHindsight.sharpe)} on the test span; picked walk-forward it was ${f2(owf.sharpe)}`);
  if (inSample) {
    notes.push(`best full-period rule ${inSample.label}: appraisal ratio ${f2(inSample.appraisalRatio)}, deflated ${f2(inSample.deflatedSharpe)} after ${inSample.trials} rules (≈ ${inSample.effectiveTrials.toFixed(1)} independent)${inSample.deflatedSharpe >= 0.95 ? "" : ": consistent with luck from trying many rules"}`);
  }
  if (owf.breakEvenBps === null) notes.push("walk-forward rule had no timing alpha even before costs");
  else if (costsFlagged) notes.push(`costs erase most of the timing alpha: break-even ${owf.breakEvenBps.toFixed(0)} bps per trade vs ${o.costBps} bps assumed`);
  notes.push(SURVIVORSHIP_NOTE);

  return {
    target,
    asOf: own.bars[own.bars.length - 1].date,
    symbols: runs.map((r) => r.symbol),
    start: dates[0],
    oosStart: dates[first],
    end: dates[D - 1],
    days: D,
    oosDays: D - first,
    buyHold: backtestStats(hold.net.slice(first), hold.held.slice(first), hold.turnover.slice(first), o.rfAnnual),
    families,
    overall: { hindsight: overallHindsight, walkForward: owf },
    inSample,
    pitfalls: {
      lookAhead: { checked: tried.length, violations: [...leaks.values()] },
      survivorship: { flagged: true, note: SURVIVORSHIP_NOTE },
      overfitting: { flagged: !(inSample && inSample.deflatedSharpe >= 0.95), deflatedSharpe: inSample?.deflatedSharpe ?? null, hindsightSharpe: overallHindsight.sharpe, walkForwardSharpe: owf.sharpe },
      costs: { flagged: costsFlagged, costBps: o.costBps, grossSharpe: owf.grossSharpe, netSharpe: owf.sharpe, breakEvenBps: owf.breakEvenBps },
    },
    curve,
    score,
    passed: winners.length > 0,
    params: { costBps: o.costBps, rfAnnual: o.rfAnnual, folds: o.folds, testFrac: o.testFrac, rules: rules.length, warmup: W },
    notes,
  };
}
