import { test } from "node:test";
import assert from "node:assert/strict";
import { sma, ema, crossovers, rsi, macd, bollinger, momentum, obv, relativeVolume, rollingVwap, sessionVwap, technicalSnapshot, technicalScoreSeries, momentumScore } from "./technicals";
import { mulberry32, normalSampler } from "./stats";
import type { Bar } from "./types";

const close = (a: number, b: number, tol: number, msg?: string) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg ?? ""} expected ${b}, got ${a}`);

const mkBars = (closes: number[], vol = 1000): Bar[] =>
  closes.map((c, i) => ({ t: i * 86400, date: `d${String(i).padStart(4, "0")}`, open: c, high: c * 1.01, low: c * 0.99, close: c, adjClose: c, volume: vol }));

test("SMA and EMA", () => {
  const s = sma([1, 2, 3, 4, 5], 3);
  assert.ok(Number.isNaN(s[1]));
  assert.deepEqual(s.slice(2), [2, 3, 4]);
  const e = ema([1, 2, 3, 4, 5], 3);
  assert.equal(e[2], 2, "seeded with SMA");
  close(e[3], 0.5 * 4 + 0.5 * 2, 1e-12, "α = 2/(n+1) = 0.5");
});

test("crossovers detect golden and death crosses", () => {
  const fast = [1, 2, 3, 2, 1];
  const slow = [2, 2, 2, 2, 2];
  assert.deepEqual(crossovers(fast, slow), [{ index: 2, type: "golden" }, { index: 4, type: "death" }]);
});

test("RSI extremes and a textbook value", () => {
  const up = Array.from({ length: 30 }, (_, i) => 100 + i);
  assert.equal(rsi(up)[29], 100, "no losses ⇒ RSI 100");
  const down = up.slice().reverse();
  close(rsi(down)[29], 0, 1e-12);
  // Alternating +1/−1 ⇒ avg gain = avg loss ⇒ RSI 50 at the seed.
  const alt = Array.from({ length: 15 }, (_, i) => 100 + (i % 2));
  close(rsi(alt)[14], 50, 1e-9);
});

test("MACD and Bollinger shapes", () => {
  const xs = Array.from({ length: 100 }, (_, i) => 100 + Math.sin(i / 5) * 5 + i * 0.1);
  const m = macd(xs);
  assert.ok(Number.isNaN(m.macd[24]) && Number.isFinite(m.macd[25]));
  assert.ok(Number.isFinite(m.signal[33]) && Number.isNaN(m.signal[32]), "signal starts 9 bars after MACD");
  close(m.hist[99], m.macd[99] - m.signal[99], 1e-12);
  const flat = bollinger(Array(30).fill(10));
  assert.equal(flat.upper[29], 10);
  assert.equal(flat.pctB[29], 0.5);
});

test("momentum skips the latest month", () => {
  const xs = Array.from({ length: 300 }, (_, i) => 100 * Math.pow(1.001, i));
  const m = momentum(xs);
  close(m.mom12_1!, Math.pow(1.001, 231) - 1, 1e-9);
  close(m.ret1m!, Math.pow(1.001, 21) - 1, 1e-9);
  assert.equal(momentum([1, 2]).mom12_1, null);
});

test("volume tools and VWAP", () => {
  assert.deepEqual(obv([1, 2, 1, 1], [10, 20, 30, 40]), [0, 20, -10, -10]);
  close(relativeVolume([...Array(20).fill(100), 300])!, 3, 1e-12);
  const bars = mkBars([10, 20], 100);
  close(rollingVwap(bars)!, 15, 1e-9);
  const intra: Bar[] = [
    { t: 0, date: "2026-01-02", open: 9, high: 11, low: 9, close: 10, adjClose: 10, volume: 100 },
    { t: 300, date: "2026-01-02", open: 10, high: 12, low: 10, close: 11, adjClose: 11, volume: 300 },
  ];
  close(sessionVwap(intra)!, (10 * 100 + 11 * 300) / 400, 1e-9);
});

test("technical snapshot of an uptrend votes long", () => {
  const xs = Array.from({ length: 260 }, (_, i) => 100 * Math.pow(1.002, i) * (1 + 0.01 * Math.sin(i)));
  const snap = technicalSnapshot(mkBars(xs))!;
  assert.ok(snap.score > 0, `score ${snap.score}`);
  assert.equal(snap.votes.length, 8);
  assert.equal(technicalSnapshot(mkBars(xs.slice(0, 100))), null);
  const ms = momentumScore({ mom12_1: 0.4, mom6_1: 0.2, ret1m: 0.01, ret3m: 0.05 }, [0.1, 0.2, 0.3]);
  assert.ok(ms.score > 50 && ms.percentile === 1);
});

test("score series replays the snapshot bar by bar, without look-ahead", () => {
  const g = normalSampler(mulberry32(4));
  let p = 100;
  const bars = mkBars(Array.from({ length: 420 }, () => (p *= Math.exp(0.0004 + 0.02 * g()))));
  for (const b of bars) { b.volume = 1000 * (1 + Math.abs(g())); b.high = b.close * (1 + 0.01 * Math.abs(g())); b.low = b.close * (1 - 0.01 * Math.abs(g())); }
  const series = technicalScoreSeries(bars);
  assert.ok(Number.isNaN(series[198]) && Number.isFinite(series[199]));
  for (const end of [200, 257, 333, 419, 420]) {
    assert.equal(series[end - 1], technicalSnapshot(bars.slice(0, end))!.score, `bar ${end - 1}`);
  }
  // A flat tape has no trend for volume to confirm.
  const flat = technicalSnapshot(mkBars(Array(220).fill(50)))!;
  assert.equal(flat.votes.find((v) => v.name === "OBV confirms trend")!.vote, 0);
});
