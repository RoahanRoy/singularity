import { test } from "node:test";
import assert from "node:assert/strict";
import { BOOK_INDEX_BASE, holdingsReturn, nextBookIndex, recordedTrack } from "./scorecard";

const close = (a: number, b: number, tol: number, msg?: string) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg ?? ""} expected ${b}, got ${a}`);

test("the return between pulls marks the earlier share counts, so new money is not performance", () => {
  const prev = [
    { ticker: "A", qty: 10, marketValue: 1000 }, // 100 → 110
    { ticker: "B", qty: 5, marketValue: 1000 }, // 200 → 190
  ];
  const next = [
    { ticker: "A", qty: 30, marketValue: 3300 }, // bought 20 more: NAV jumps, return doesn't
    { ticker: "B", qty: 5, marketValue: 950 },
    { ticker: "C", qty: 1, marketValue: 500 }, // new: no earlier price
  ];
  close(holdingsReturn(prev, next)!, (100 - 50) / 2000, 1e-12);
});

test("a holding sold between pulls drops out of both the gain and the base", () => {
  const r = holdingsReturn(
    [{ ticker: "A", qty: 1, marketValue: 100 }, { ticker: "GONE", qty: 1, marketValue: 900 }],
    [{ ticker: "A", qty: 1, marketValue: 105 }],
  );
  close(r!, 0.05, 1e-12);
  assert.equal(holdingsReturn([], [{ ticker: "A", qty: 1, marketValue: 1 }]), null);
});

test("the running level starts at the base and holds flat on an unknown return", () => {
  assert.equal(nextBookIndex(null, 0.1), BOOK_INDEX_BASE);
  close(nextBookIndex(100, 0.1), 110, 1e-12);
  assert.equal(nextBookIndex(110, null), 110);
});

test("the recorded track keeps each day's last pull and rebases both to 100", () => {
  const t = recordedTrack([
    { captured_at: "2026-10-24T08:00:00Z", book_index: 100, index_level: 5000 },
    { captured_at: "2026-10-24T20:00:00Z", book_index: 101, index_level: 5050 },
    { captured_at: "2026-10-25T20:00:00Z", book_index: 103.02, index_level: 5100 },
    { captured_at: "2026-10-25T21:00:00Z", book_index: null, index_level: null }, // an IBKR / enrich row
  ])!;
  assert.deepEqual(t.dates, ["2026-10-24", "2026-10-25"]);
  close(t.book[1], 102, 1e-9);
  close(t.indexReturn, 5100 / 5050 - 1, 1e-12);
  assert.equal(recordedTrack([{ captured_at: "2026-10-24T08:00:00Z", book_index: 100, index_level: 1 }]), null);
});
