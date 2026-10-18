import { test } from "node:test";
import assert from "node:assert/strict";
import { simulate, lookAheadViolations, deflatedSharpe, backtestReport, STRATEGIES, SURVIVORSHIP_NOTE, type BacktestSeries, type Strategy } from "./backtest";
import { mean, normCdf, mulberry32, normalSampler } from "./stats";
import type { Bar } from "./types";

const close = (a: number, b: number, tol: number, msg?: string) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg ?? ""} expected ${b}, got ${a}`);

const day = (i: number) => new Date(Date.UTC(2015, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);

function toBars(closes: readonly number[], g: () => number): Bar[] {
  return closes.map((c, i) => ({
    t: i, date: day(i), open: c, close: c, adjClose: c,
    high: c * (1 + 0.005 * Math.abs(g())), low: c * (1 - 0.005 * Math.abs(g())), volume: 1e6 * (1 + 0.3 * Math.abs(g())),
  }));
}

/** Persistent up/down drift (±0.2% a day, ~200-day spells) under 1.2% daily noise: trend rules should work. */
function trends(n: number, symbols: number, seed: number): BacktestSeries[] {
  const rng = mulberry32(seed);
  const g = normalSampler(rng);
  return Array.from({ length: symbols }, (_, s) => {
    let up = rng() < 0.5, p = 100;
    const closes: number[] = [];
    for (let i = 0; i < n; i++) {
      if (rng() > 0.995) up = !up;
      p *= Math.exp((up ? 0.002 : -0.002) + 0.012 * g());
      closes.push(p);
    }
    return { symbol: `S${s}`, bars: toBars(closes, g) };
  });
}

/** Geometric random walks with drift `mu`: no rule can time them. */
function walks(n: number, symbols: number, seed: number, mu: number): BacktestSeries[] {
  const g = normalSampler(mulberry32(seed));
  return Array.from({ length: symbols }, (_, s) => {
    let p = 50;
    const closes = Array.from({ length: n }, () => (p *= Math.exp(mu + 0.015 * g())));
    return { symbol: `S${s}`, bars: toBars(closes, g) };
  });
}

test("simulate trades on the next bar, charges every change of position and pays rf on cash", () => {
  const sim = simulate([100, 110, 99, 99, 120], [1, 0, 1, NaN, 1], 0, 10, 0.0252);
  // Bar 0's decision earns bar 1's return; bar 3's NaN position counts as cash.
  assert.deepEqual(sim.held, [1, 0, 1, 0]);
  assert.deepEqual(sim.turnover, [1, 1, 1, 1]);
  close(sim.gross[0], 0.1, 1e-12);
  close(sim.gross[1], 0.0001, 1e-12, "cash earns rf/252");
  close(sim.gross[2], 0, 1e-12);
  close(sim.gross[3], 0.0001, 1e-12);
  sim.net.forEach((x, i) => close(x, sim.gross[i] - 0.001, 1e-12, `10 bps on trade ${i}`));
  const hold = simulate([100, 110, 99], [1, 1, 1], 0, 10);
  assert.deepEqual(hold.turnover, [1, 0], "buy-and-hold pays its entry once");
  assert.equal(simulate([100, 110, 99], [1, 1, 1], 1, 10).gross.length, 1, "output starts the bar after `start`");
});

/** Long when tomorrow closes higher: impossible to trade, perfect on paper. */
const peek: Strategy = {
  family: "sma-cross", label: "tomorrow's close", warmup: 0,
  positions: (bars) => bars.map((b, i) => (i + 1 < bars.length && bars[i + 1].close > b.close ? 1 : 0)),
};

test("a rule that peeks at the next bar is caught and dropped", () => {
  const series = walks(900, 4, 8, 0.0003);
  const own = series[0].bars;
  const leaks = lookAheadViolations([peek, ...STRATEGIES], own);
  assert.deepEqual([...leaks.keys()], [peek], "only the peeking rule leaks");
  assert.match(leaks.get(peek)!, /^tomorrow's close: position on \d{4}-\d{2}-\d{2} changes when bars after/);

  const rep = backtestReport(series, "S0", { strategies: [peek, ...STRATEGIES] })!;
  assert.equal(rep.pitfalls.lookAhead.checked, STRATEGIES.length + 1);
  assert.equal(rep.pitfalls.lookAhead.violations.length, 1);
  assert.equal(rep.params.rules, STRATEGIES.length);
  assert.ok(!rep.families.some((f) => f.candidates.includes(peek.label)));
  assert.ok(rep.notes[0].startsWith("look-ahead: 1 rule(s)"));
  // Kept in, it would have looked like a money machine.
  const leaky = simulate(own.map((b) => b.adjClose), peek.positions(own), 0, 10);
  assert.ok(mean(leaky.net) / Math.sqrt(mean(leaky.net.map((x) => x * x))) > 0.5, "per-day Sharpe far beyond any real rule");
});

test("deflated Sharpe: one trial is the probabilistic Sharpe; the best of many noise trials rarely clears it", () => {
  const one = deflatedSharpe(0.1, 1, 252, 0, 0);
  assert.equal(one.sr0, 0);
  close(one.dsr, normCdf(0.1 / Math.sqrt(1.005 / 251)), 1e-12);

  // 300 experiments of 10 unskilled rules, 500 days each: pick the best each time.
  const g = normalSampler(mulberry32(4));
  let naive = 0, deflated = 0;
  for (let e = 0; e < 300; e++) {
    let best = -Infinity;
    for (let k = 0; k < 10; k++) {
      const xs = Array.from({ length: 500 }, () => 0.01 * g());
      const m = mean(xs);
      best = Math.max(best, m / Math.sqrt(mean(xs.map((x) => (x - m) ** 2))));
    }
    if (deflatedSharpe(best, 1, 500, 0, 0).dsr > 0.95) naive++;
    if (deflatedSharpe(best, 10, 500, 0, 0).dsr > 0.95) deflated++;
  }
  assert.ok(naive / 300 > 0.3, `undeflated, the best of 10 looks significant ${naive}/300 times`);
  assert.ok(deflated / 300 < 0.06, `deflated: ${deflated}/300`);

  // A real edge (0.2 per-day Sharpe over 1000 days) survives 10 trials.
  assert.ok(deflatedSharpe(0.2, 10, 1000, -0.3, 2).dsr > 0.99);
});

test("trend rules validate walk-forward on trending markets", () => {
  for (const seed of [1, 3]) {
    const rep = backtestReport(trends(1500, 8, seed), "S0")!;
    const fam = (f: string) => rep.families.find((x) => x.family === f)!;
    assert.ok(rep.passed && fam("sma-cross").passed && fam("ts-momentum").passed, `seed ${seed}: ${rep.notes.join(" | ")}`);
    for (const f of rep.families.filter((x) => x.passed)) {
      const w = f.walkForward;
      assert.ok(w.alphaT >= 2 && w.exposure >= 0.1 && w.exposure <= 0.9 && w.alpha > 0);
      assert.equal(w.picks.length, rep.params.folds);
      assert.ok(w.picks.every((p, i) => f.candidates.includes(p.label) && p.from >= rep.oosStart && (i === 0 || p.from > w.picks[i - 1].from)));
    }
    // Score: validated families vote with today's position, weighted by their t (capped at 4).
    const voters = rep.families.filter((f) => f.passed && f.current);
    const expected = Math.round(100 * mean(voters.map((f) => (f.current!.position > 0 ? 1 : -1) * Math.min(1, f.walkForward.alphaT / 4))));
    assert.equal(rep.score, expected);
    assert.ok(rep.inSample!.deflatedSharpe >= 0.95 && !rep.pitfalls.overfitting.flagged);
    assert.ok(rep.notes.some((n) => n.startsWith("SMA crossover earned timing alpha out of sample")));
  }
});

test("random walks never validate, and hindsight flatters the backtest", () => {
  for (const seed of [4, 5, 6]) {
    const rep = backtestReport(walks(1250, 10, seed, 0.0003), "S0")!;
    assert.ok(!rep.passed && rep.score === 0, `seed ${seed}`);
    assert.ok(rep.overall.hindsight.sharpe > rep.overall.walkForward.sharpe, "picking the best rule after the fact overstates it");
    assert.ok(rep.families.every((f) => f.hindsight.sharpe >= f.walkForward.sharpe));
    assert.ok(rep.pitfalls.overfitting.flagged && rep.inSample!.deflatedSharpe < 0.95);
    assert.ok(rep.notes.includes("no rule family earned timing alpha over buy-and-hold out of sample at t ≥ 2 (walk-forward, after costs)"));
  }
  // In a falling market, rules that sit in cash beat buy-and-hold's Sharpe without any timing skill.
  for (const seed of [200, 201, 202]) {
    const rep = backtestReport(walks(1250, 10, seed, -0.0015), "S0")!;
    const fooled = rep.families.filter((f) => f.walkForward.sharpeDiffZ >= 2 && f.walkForward.exposure >= 0.1 && f.walkForward.exposure <= 0.9);
    assert.ok(fooled.length > 0, `seed ${seed}: some rule beats a falling buy-and-hold on Sharpe`);
    assert.ok(!rep.passed, `seed ${seed}: but none earns timing alpha`);
  }
});

test("costs: none leaves gross equal to net; prohibitive costs are flagged and kill validation", () => {
  const free = backtestReport(trends(1500, 8, 1), "S0", { costBps: 0 })!;
  for (const f of free.families) {
    assert.equal(f.walkForward.grossSharpe, f.walkForward.sharpe);
    assert.equal(f.walkForward.grossAlpha, f.walkForward.alpha);
  }
  assert.ok(!free.pitfalls.costs.flagged && free.overall.walkForward.breakEvenBps! > 0);

  const dear = backtestReport(trends(1500, 8, 1), "S0", { costBps: 2000 })!;
  const w = dear.overall.walkForward;
  assert.ok(w.grossAlpha > 0 && w.alpha < w.grossAlpha && w.sharpe < w.grossSharpe);
  assert.ok(dear.pitfalls.costs.flagged && w.breakEvenBps! < 4000);
  assert.ok(!dear.passed);
  assert.ok(dear.notes.some((n) => n.startsWith("costs erase most of the timing alpha: break-even")));
});

test("report shape: survivorship always flagged, a short equity curve, null without enough data", () => {
  const rep = backtestReport(walks(1250, 3, 9, 0.0003), "S1")!;
  assert.deepEqual(rep.pitfalls.survivorship, { flagged: true, note: SURVIVORSHIP_NOTE });
  assert.ok(rep.notes.at(-1) === SURVIVORSHIP_NOTE);
  assert.ok(rep.curve.length <= 61 && rep.curve.length > 30);
  assert.deepEqual([rep.curve[0].strategy, rep.curve[0].buyHold], [1, 1]);
  assert.ok(rep.curve.every((p, i) => i === 0 || p.date > rep.curve[i - 1].date));
  assert.equal(rep.curve.at(-1)!.date, rep.end);
  assert.ok(rep.curve[0].date < rep.oosStart);
  assert.ok(Math.abs(rep.oosDays / rep.days - 0.5) < 0.01);
  assert.equal(rep.asOf, rep.end);
  assert.deepEqual(rep.symbols, ["S0", "S1", "S2"]);

  assert.equal(backtestReport(walks(1250, 3, 9, 0), "MISSING"), null);
  assert.equal(backtestReport(walks(300, 3, 9, 0), "S0"), null, "shorter than the longest warmup + 60 days");
  assert.equal(backtestReport(walks(500, 3, 9, 0), "S0"), null, "under 300 pooled days after the warmup");
});
