import { test } from "node:test";
import assert from "node:assert/strict";
import {
  POSITIVE, NEGATIVE, UNCERTAINTY, tokenize, tone, newsTone, revisionsScore, insiderScore, shortInterestScore,
  sentimentComposite, earningsDelivery, callTone, type Headline, type RatingChange,
} from "./sentiment";
import { mean } from "./stats";

const close = (a: number, b: number, tol: number, msg?: string) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg ?? ""} expected ${b}, got ${a}`);

const asOf = new Date("2026-10-18T12:00:00Z");

test("lexicon: no word carries two tones, and ambiguous finance words carry none", () => {
  for (const w of POSITIVE) assert.ok(!NEGATIVE.has(w) && !UNCERTAINTY.has(w), w);
  for (const w of NEGATIVE) assert.ok(!UNCERTAINTY.has(w), w);
  for (const w of ["may", "fine", "top", "lower", "raise", "liability", "tax", "cost", "capital", "short"]) {
    assert.ok(!POSITIVE.has(w) && !NEGATIVE.has(w) && !UNCERTAINTY.has(w), w);
  }
  const t = tone("The liability, tax and cost of capital may top estimates in May");
  assert.deepEqual([t.positive, t.negative, t.uncertainty], [0, 0, 0]);
});

test("tokenize and tone: hyphens join, negation flips within three words, plurals fall back", () => {
  assert.deepEqual(tokenize("Write-off at Acme’s plant didn’t help"), ["writeoff", "at", "acme's", "plant", "didn't", "help"]);

  const beat = tone("Revenue beat estimates and margins improved");
  assert.deepEqual([beat.positive, beat.negative], [2, 0]);
  close(beat.net, 2 / 3, 1e-12, "shrunk: two hits give 2/3, not 1");

  const notStrong = tone("Results were not strong");
  assert.deepEqual(notStrong.hits, [{ word: "strong", polarity: "negative", negated: true }]);
  close(notStrong.net, -0.5, 1e-12);
  assert.equal(tone("There were no losses this quarter").positive, 1, "a negated negative reads positive");
  assert.equal(tone("Sales didn’t disappoint").positive, 1, "n't negates, curly apostrophe or not");
  assert.equal(tone("Not that we expected anything but strong").positive, 1, "a negator four words back is out of range");

  const plurals = tone("two upturns and three recessions");
  assert.deepEqual([plurals.positive, plurals.negative, plurals.net], [1, 1, 0]);
  assert.equal(tone("consumer goods and company records").hits.length, 0, "plural exceptions");

  const hedged = tone("Demand could be volatile and the outlook is uncertain");
  assert.equal(hedged.uncertainty, 3);
  close(hedged.uncertaintyShare, 3 / 9, 1e-12);
  assert.deepEqual([tone("").tokens, tone("").net, tone("").uncertaintyShare], [0, 0, 0]);
});

test("news tone: duplicates count once, a 7-day half-life, nothing stale or undated, shrunk by two neutral headlines", () => {
  const items: Headline[] = [
    { title: "Apple beats estimates, shares surge", publishedAt: "2026-10-18T12:00:00Z", publisher: "Wire" },
    { title: "APPLE BEATS ESTIMATES; SHARES SURGE", publishedAt: "2026-10-18T10:00:00Z" },
    { title: "Apple faces lawsuit over patents", publishedAt: "2026-10-11T12:00:00Z" },
    { title: "Record profits lift Apple", publishedAt: "2026-09-01T12:00:00Z" },
    { title: "Apple unveils new phone", publishedAt: "not a date" },
    { title: "Future-dated item beats", publishedAt: "2026-10-25T00:00:00Z" },
  ];
  const r = newsTone(items, asOf)!;
  assert.equal(r.count, 2);
  assert.deepEqual([r.positive, r.negative, r.neutral], [1, 1, 0]);
  // Today's +2/3 at weight 1, last week's −1/2 at weight ½, plus two neutral pseudo-headlines.
  assert.equal(r.score, Math.round((100 * (2 / 3 - 0.5 * 0.5)) / (1.5 + 2)));
  assert.equal(newsTone(items, asOf, { pseudo: 0 })!.score, Math.round((100 * (2 / 3 - 0.25)) / 1.5));
  assert.equal(r.items[0].title, items[0].title, "newest first");
  assert.equal(r.items[0].publisher, "Wire");
  assert.deepEqual(r.items[1].hits, ["lawsuit−"]);
  assert.equal(newsTone([], asOf), null);
  assert.equal(newsTone([items[3], items[4]], asOf), null, "only stale or undated items");
});

test("revisions: rating changes in the last 90 days, EPS estimate drift and EPS revision counts", () => {
  const changes: RatingChange[] = [
    { date: "2026-10-01", firm: "A", action: "up" },
    { date: "2026-09-15", firm: "B", action: "up" },
    { date: "2026-08-01", firm: "C", action: "up" },
    { date: "2026-09-20", firm: "D", action: "down" },
    { date: "2026-07-01", firm: "E", action: "up" },
    { date: "2026-10-10", firm: "F", action: "main" },
  ];
  const r = revisionsScore({ ratingChanges: changes, epsTrend: { current: 6, d30: 5.9, d90: 5.7 }, epsRevisions: { up30: 5, down30: 1 } }, asOf)!;
  assert.deepEqual([r.upgrades, r.downgrades], [3, 1], "July's upgrade is outside the window");
  close(r.epsDriftPct!, ((6 - 5.7) / 5.7) * 100, 1e-9, "90-day drift preferred");
  const parts = [Math.round((100 * 2) / 6), Math.round(100 * Math.tanh(r.epsDriftPct! / 5)), 50];
  assert.deepEqual(r.parts.map((p) => p.score), parts);
  assert.equal(r.score, Math.round(mean(parts)));

  const ratingsOnly = revisionsScore({ ratingChanges: changes }, asOf)!;
  assert.deepEqual([ratingsOnly.score, ratingsOnly.epsDriftPct, ratingsOnly.parts.length], [33, null, 1]);
  close(revisionsScore({ ratingChanges: [], epsTrend: { current: 6, d30: 6.3 } }, asOf)!.epsDriftPct!, (-0.3 / 6.3) * 100, 1e-9, "30-day drift without a 90-day figure");
  assert.equal(revisionsScore({ ratingChanges: [changes[4]] }, asOf), null);

  // Maintained ratings with moved targets: three raises and a cut in the window, a stale raise ignored.
  const targets: RatingChange[] = [
    { date: "2026-10-12", firm: "G", action: "main", priceTarget: "raise" },
    { date: "2026-09-30", firm: "H", action: "reit", priceTarget: "raise" },
    { date: "2026-08-20", firm: "I", action: "main", priceTarget: "raise" },
    { date: "2026-09-02", firm: "J", action: "main", priceTarget: "lower" },
    { date: "2026-06-01", firm: "K", action: "main", priceTarget: "raise" },
    { date: "2026-10-05", firm: "L", action: "main", priceTarget: null },
  ];
  const t = revisionsScore({ ratingChanges: targets }, asOf)!;
  assert.deepEqual([t.targetRaises, t.targetCuts, t.upgrades, t.downgrades], [3, 1, 0, 0]);
  assert.deepEqual(t.parts, [{ name: "rating changes", score: 0 }, { name: "price targets", score: 33 }]);
  assert.equal(t.score, 17);
});

test("insiders: a sale counts a quarter of a purchase; short interest: free below 5% of float, −100 from 20%", () => {
  const base = { period: "6m", source: "test" };
  assert.equal(insiderScore({ ...base, buys: 2, sells: 8 })!.score, 0, "eight routine sales offset two purchases");
  assert.equal(insiderScore({ ...base, buys: 5, sells: 0 })!.score, 71);
  assert.equal(insiderScore({ ...base, buys: 0, sells: 20 })!.score, -71);
  assert.equal(insiderScore({ ...base, buys: 0, sells: 0 }), null);

  assert.equal(shortInterestScore({ pctFloat: 0.03 })!.score, 0);
  assert.equal(shortInterestScore({ pctFloat: 0.2 })!.score, -100);
  assert.equal(shortInterestScore({ pctFloat: 0.125 })!.score, -50);
  const rising = shortInterestScore({ pctFloat: 0.125, shares: 1.25e6, priorShares: 1e6 })!;
  close(rising.changePct!, 25, 1e-9);
  assert.equal(rising.score, Math.round(100 * (-0.5 - 0.2 * Math.tanh(1))));
  assert.equal(shortInterestScore({ pctFloat: 0.125, shares: 0.8e6, priorShares: 1e6 })!.score, Math.round(100 * (-0.5 + 0.2 * Math.tanh(0.8))));
  assert.equal(shortInterestScore({ pctFloat: null }), null);
});

test("sentiment composite renormalizes over the components it has", () => {
  const c = sentimentComposite({ news: 50, revisions: -20, insiders: null, shortInterest: -100 })!;
  assert.equal(c.score, Math.round((0.35 * 50 - 0.3 * 20 - 0.15 * 100) / 0.8));
  assert.equal(c.components.length, 3);
  close(c.components.reduce((a, x) => a + x.weight, 0), 1, 1e-12);
  close(c.components.find((x) => x.name === "news")!.weight, 0.35 / 0.8, 1e-12);
  assert.equal(sentimentComposite({ insiders: 30 })!.score, 30);
  assert.equal(sentimentComposite({}), null);
});

test("earnings delivery: last four quarters against a 70% beat base rate, the latest surprise weighted most", () => {
  const r = earningsDelivery([
    { date: "2026-07-30", actual: 1.2, estimate: 1.0 },
    { date: "2025-07-30", actual: 0.5, estimate: 1.0 },
    { date: "2025-10-30", actual: 1.0, estimate: 0.9 },
    { date: "2026-01-30", actual: 1.1, estimate: 1.0 },
    { date: "2026-04-30", actual: 0.95, estimate: 1.0 },
    { date: "2026-05-01", actual: NaN, estimate: 1.0 },
  ])!;
  assert.equal(r.quarters, 4, "the oldest quarter and the bad row are dropped");
  assert.equal(r.beatRate, 0.75);
  close(r.lastSurprisePct, 20, 1e-9);
  assert.equal(r.lastDate, "2026-07-30");
  close(r.medianSurprisePct, (10 + 100 / 9) / 2, 1e-9);
  assert.equal(r.score, Math.round(100 * (0.6 * 1 + 0.4 * ((0.75 - 0.7) / 0.3))));
  assert.deepEqual(r.history.map((q) => q.date), ["2025-10-30", "2026-01-30", "2026-04-30", "2026-07-30"]);

  const loss = earningsDelivery([{ date: "2026-07-30", actual: -0.4, estimate: -0.5 }])!;
  close(loss.lastSurprisePct, 20, 1e-9, "a smaller loss than expected is a beat");
  assert.equal(loss.score, 100);
  const misses = earningsDelivery(["2025-10-30", "2026-01-30", "2026-04-30", "2026-07-30"].map((date) => ({ date, actual: 0.9, estimate: 1 })))!;
  assert.equal(misses.score, -100);
  assert.equal(earningsDelivery([]), null);
});

test("call tone: management's upbeat baseline, hedging and bad news all move the score", () => {
  assert.equal(callTone("Strong quarter."), null, "too short to read");
  const upbeat = callTone("We delivered record revenue and strong growth, and margins improved across every segment. ".repeat(6))!;
  const hedged = callTone("We delivered strong growth but the outlook remains uncertain and demand could be volatile; results might fluctuate. ".repeat(5))!;
  const bad = callTone("Revenue declined and margins deteriorated as demand weakened; we missed our targets. ".repeat(5))!;
  assert.equal(upbeat.score, 100);
  assert.equal(hedged.score, 50, "hedging costs up to half the scale");
  assert.equal(bad.score, -100);
  assert.ok(hedged.uncertaintyShare > 0.04 && upbeat.uncertaintyShare === 0);
});
