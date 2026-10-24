import { test } from "node:test";
import assert from "node:assert/strict";
import { compareToIndex, maxDrawdown, rescaleTo, windowStart, type Bar } from "./benchmark";

const close = (a: number, b: number, tol: number, msg?: string) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg ?? ""} expected ${b}, got ${a}`);

const day = (k: number) => new Date(Date.UTC(2026, 0, 1 + k)).toISOString().slice(0, 10);
const series = (closes: number[], offset = 0): Bar[] => closes.map((c, k) => ({ date: day(k + offset), close: c }));

test("the book is the current share counts held over the window, rebased to 100", () => {
  const index = series([100, 101, 102, 103, 110]);
  const r = compareToIndex([
    { ticker: "A", qty: 10, bars: series([10, 10, 11, 12, 13]) },
    { ticker: "B", qty: 1, bars: series([100, 100, 100, 100, 100]) },
  ], index)!;
  close(r.book[0], 100, 1e-12);
  close(r.book.at(-1)!, (130 + 100) / 200 * 100, 1e-9);
  close(r.bookReturn, 0.15, 1e-12);
  close(r.indexReturn, 0.1, 1e-12);
  close(r.excess, 0.05, 1e-12);
  const a = r.holdings.find((h) => h.ticker === "A")!;
  close(a.weight, 0.5, 1e-12);
  close(a.ret, 0.3, 1e-12);
  close(r.holdings.reduce((s, h) => s + h.contribution, 0), r.excess, 1e-12, "contributions sum to the excess");
  assert.equal(r.holdings[0].ticker, "A", "largest contributor first");
});

test("gaps carry the last close; a late listing is held flat until it trades; unpriced names are reported", () => {
  const index = series([100, 100, 100, 100]);
  const r = compareToIndex([
    { ticker: "GAP", qty: 1, bars: [{ date: day(0), close: 50 }, { date: day(3), close: 60 }] },
    { ticker: "LATE", qty: 1, bars: series([20, 30], 2) },
    { ticker: "NONE", qty: 1, bars: [] },
    { ticker: "ZERO", qty: 0, bars: series([1, 1, 1, 1]) },
  ], index)!;
  close(r.book[1], 100, 1e-12, "GAP holds 50, LATE back-filled at 20");
  close(r.book.at(-1)!, ((60 + 30) / 70) * 100, 1e-9);
  assert.deepEqual(r.missing, ["NONE"]);
  assert.equal(r.holdings.length, 2);
});

test("a book that is the index has beta 1, no tracking error and full capture", () => {
  const closes = [100, 102, 99, 101, 104, 103, 105, 101, 106, 108, 107, 110];
  const r = compareToIndex([{ ticker: "SPY", qty: 3, bars: series(closes) }], series(closes))!;
  close(r.beta!, 1, 1e-9);
  close(r.correlation!, 1, 1e-9);
  close(r.trackingError!, 0, 1e-9);
  close(r.upCapture!, 1, 1e-9);
  close(r.downCapture!, 1, 1e-9);
  close(r.excess, 0, 1e-12);
});

test("too few days leaves the risk stats empty; the window filter applies", () => {
  const r = compareToIndex([{ ticker: "A", qty: 1, bars: series([1, 2, 3]) }], series([1, 2, 3]))!;
  assert.equal(r.beta, null);
  assert.equal(r.trackingError, null);
  const w = compareToIndex([{ ticker: "A", qty: 1, bars: series([1, 2, 4]) }], series([1, 2, 4]), day(1))!;
  close(w.bookReturn, 1, 1e-12, "window starts at day 1: 2 → 4");
  assert.equal(compareToIndex([], series([1, 2])), null);
});

test("drawdown and window starts", () => {
  close(maxDrawdown([100, 120, 90, 130, 117]), -0.25, 1e-12);
  assert.equal(windowStart("2026-10-23", "3M"), "2026-07-23");
  assert.equal(windowStart("2026-10-23", "YTD"), "2026-01-01");
  assert.equal(windowStart("2026-10-23", "1Y"), "2025-10-23");
});

test("a stand-in is moved to the holding's price level, keeping its returns", () => {
  const scaled = rescaleTo(series([100, 110, 121]), 14000);
  close(scaled.at(-1)!.close, 14000, 1e-9);
  close(scaled[1].close / scaled[0].close, 1.1, 1e-12);
  assert.deepEqual(rescaleTo(series([1, 2]), 0), series([1, 2]), "no price, no change");
});
