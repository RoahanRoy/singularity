/**
 * Scorecard — the book's recorded track against its index.
 *
 * The benchmark panel's replay holds today's share counts over past prices,
 * which is blind to every trade and its timing. This is the record that isn't:
 * each Horizon pull writes, beside the NAV, two levels to `fund_snapshots`:
 *
 *  - `book_index`: a running book level, chained pull to pull by the return
 *    of the holdings the book had at the earlier pull. Buying with new cash or
 *    selling moves NAV but not this level, so it is performance, not flows.
 *  - `index_level`: the desk's index (S&P 500 / Nifty 50) at the same pull.
 *
 * Rebased to a common start, the two make a like-for-like track record.
 *
 * Pure: no I/O, so the sync, the Portfolio screen and the tests share it.
 */

import { compareSeries, type BenchmarkResult } from "./benchmark";

export type PulledHolding = { ticker: string; qty: number; marketValue: number };

/** Where the running book level starts on a desk's first recorded pull. */
export const BOOK_INDEX_BASE = 100;

/**
 * The book's return between two pulls: the earlier share counts marked from
 * the earlier prices to the later ones. A holding sold (or bought) in between
 * has no price at one end and is left out of both the gain and the base.
 * Null when nothing overlaps.
 */
export function holdingsReturn(prev: PulledHolding[], next: PulledHolding[]): number | null {
  const later = new Map<string, number>();
  for (const h of next) if (h.qty > 0 && h.marketValue > 0) later.set(h.ticker, h.marketValue / h.qty);
  let base = 0, gain = 0;
  for (const h of prev) {
    const now = later.get(h.ticker);
    if (now == null || !(h.qty > 0) || !(h.marketValue > 0)) continue;
    base += h.marketValue;
    gain += h.qty * now - h.marketValue;
  }
  return base > 0 ? gain / base : null;
}

/** The running level after a pull: starts at the base, holds flat when the return is unknown. */
export function nextBookIndex(prev: number | null | undefined, r: number | null): number {
  if (prev == null || !(prev > 0)) return BOOK_INDEX_BASE;
  return r == null ? prev : prev * (1 + r);
}

export type RecordedPoint = { captured_at: string; book_index?: number | null; index_level?: number | null };

/**
 * The recorded track as a benchmark result: one point per day (that day's
 * last pull carrying both levels), from `from` on, rebased to 100. Null until
 * two days are on record.
 */
export function recordedTrack(points: RecordedPoint[], from?: string): BenchmarkResult | null {
  const byDay = new Map<string, { at: string; book: number; index: number }>();
  for (const p of points) {
    if (!(Number(p.book_index) > 0) || !(Number(p.index_level) > 0)) continue;
    const day = p.captured_at.slice(0, 10);
    if (from && day < from) continue;
    const prior = byDay.get(day);
    if (!prior || p.captured_at > prior.at) byDay.set(day, { at: p.captured_at, book: Number(p.book_index), index: Number(p.index_level) });
  }
  const days = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b));
  if (days.length < 2) return null;
  const [, first] = days[0];
  return {
    ...compareSeries(
      days.map(([d]) => d),
      days.map(([, v]) => (v.book / first.book) * 100),
      days.map(([, v]) => (v.index / first.index) * 100),
    ),
    holdings: [],
    missing: [],
  };
}
