import { test } from "node:test";
import assert from "node:assert/strict";
import { rlReport, type RlSeries } from "./rl";
import { mulberry32, normalSampler } from "./stats";

const day = (i: number) => new Date(Date.UTC(2018, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);

/**
 * Markov volatility regimes (stay probability 0.99, ~100-day spells): calm
 * days drift up (+0.15%, σ 0.6%), turbulent days drift down (−0.15%, σ 2%),
 * so buy-and-hold has no drift on average. Only the vol tercile in the
 * state reveals the regime, and it lags a switch by a couple of weeks.
 */
function regimes(n: number, symbols: number, seed: number): RlSeries[] {
  const rng = mulberry32(seed);
  const g = normalSampler(rng);
  return Array.from({ length: symbols }, (_, s) => {
    let calm = rng() < 0.5, p = 100;
    const closes: number[] = [];
    for (let i = 0; i < n; i++) {
      if (rng() < 0.01) calm = !calm;
      p *= Math.exp(calm ? 0.0015 + 0.006 * g() : -0.0015 + 0.02 * g());
      closes.push(p);
    }
    return { symbol: `S${s}`, dates: closes.map((_, i) => day(i)), closes };
  });
}

function randomWalks(n: number, symbols: number, seed: number): RlSeries[] {
  const g = normalSampler(mulberry32(seed));
  return Array.from({ length: symbols }, (_, s) => {
    let p = 50;
    const closes = Array.from({ length: n }, () => (p *= Math.exp(0.0003 + 0.015 * g())));
    return { symbol: `S${s}`, dates: closes.map((_, i) => day(i)), closes };
  });
}

test("Q-learning learns to hold calm regimes and sit out turbulent ones", () => {
  const rep = rlReport(regimes(2500, 6, 3), "S0")!;
  assert.equal(rep.states.length, 18);
  const act = (ret: string, vol: string) => rep.states.find((s) => s.ret === ret && s.vol === vol && s.position === "flat")!.action;
  // (Low return + low vol is rare in an up-drifting calm spell, so its row is left untested.)
  assert.deepEqual([act("mid", "low"), act("high", "low")], ["long", "long"], "low vol ⇒ long");
  assert.deepEqual(["low", "mid", "high"].map((r) => act(r, "high")), ["flat", "flat", "flat"], "high vol ⇒ cash");
  const pooled = rep.oos.pooled;
  assert.ok(rep.passed && pooled.alphaT >= 2, `alpha ${pooled.alphaAnnual} t ${pooled.alphaT}`);
  assert.ok(pooled.sharpeDiffZ >= 2, `Sharpe ${pooled.policySharpe} vs ${pooled.buyHoldSharpe}, z ${pooled.sharpeDiffZ}`);
  assert.ok(pooled.policySharpe > pooled.buyHoldSharpe + 1);
  const tgt = rep.oos.target!;
  assert.ok(tgt.policy.exposure > 0.2 && tgt.policy.exposure < 0.8, `exposure ${tgt.policy.exposure}`);
  assert.ok(tgt.policy.maxDrawdown < tgt.buyHold.maxDrawdown);
  assert.equal(tgt.cash.totalReturn, 0);
  // Today's recommendation agrees with the learned table.
  const now = rep.current!;
  const row = rep.states.find((s) => s.ret === now.ret && s.vol === now.vol && s.position === "flat")!;
  assert.equal(now.action, row.action);
  assert.equal(Math.sign(rep.score) || -1, now.action === "long" ? 1 : -1);
  assert.ok(Math.abs(rep.score) <= 100);
});

test("on random walks the policy does not validate", () => {
  for (const seed of [5, 6]) {
    const rep = rlReport(randomWalks(1500, 4, seed), "S1")!;
    assert.ok(!rep.passed, `seed ${seed}: t ${rep.oos.pooled.alphaT}`);
    assert.ok(rep.notes.some((n) => /^policy (earned no timing alpha|stayed in cash|was invested)/.test(n)), rep.notes.join(" | "));
  }
});

test("prohibitive costs stop the agent trading", () => {
  const rep = rlReport(regimes(2500, 6, 3), "S0", { costBps: 2000 })!;
  assert.equal(rep.oos.target!.policy.trades, 0);
  assert.equal(rep.oos.target!.policy.exposure, 0);
  assert.ok(!rep.passed && rep.notes.some((n) => n.startsWith("policy stayed in cash")));
});

test("split is chronological and uses only training data for state cutoffs", () => {
  const series = regimes(1000, 2, 9);
  const rep = rlReport(series, "S0")!;
  assert.equal(rep.cutDate, day(Math.floor(21 + (1000 - 22) * 0.7)));
  assert.equal(rep.trainDays + rep.testDays, 1000 - 23, "every decision day with a next-day reward, less a one-day purge");
  // Changing prices after the cut can't change what was learned before it… only what's evaluated.
  const shocked = series.map((s) => ({ ...s, closes: s.closes.map((c, i) => (s.dates[i] >= rep.cutDate ? c * (1 + 0.5 * Math.sin(i)) : c)) }));
  const rep2 = rlReport(shocked, "S0")!;
  assert.deepEqual(rep2.states.map((s) => [s.qFlat, s.qLong]), rep.states.map((s) => [s.qFlat, s.qLong]));
  assert.equal(rlReport([{ symbol: "S0", dates: [day(0)], closes: [1] }], "S0"), null);
  assert.equal(rlReport(series, "MISSING"), null);
});
