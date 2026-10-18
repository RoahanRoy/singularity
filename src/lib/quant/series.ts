/** Date alignment and resampling helpers for daily bar series. */

import type { Bar } from "./types";

export type Aligned = { dates: string[]; cols: number[][] };

/**
 * Inner-join several bar series on date, returning one value column per
 * series (default: adjusted close). Dates appear oldest → newest.
 */
export function alignOnDates(series: readonly (readonly Bar[])[], pick: (b: Bar) => number = (b) => b.adjClose): Aligned {
  if (!series.length) return { dates: [], cols: [] };
  const maps = series.map((s) => new Map(s.map((b) => [b.date, pick(b)] as const)));
  const dates = series[0].map((b) => b.date).filter((d) => maps.every((m) => {
    const v = m.get(d);
    return typeof v === "number" && Number.isFinite(v) && v > 0;
  }));
  return { dates, cols: maps.map((m) => dates.map((d) => m.get(d) as number)) };
}

/** Align a date-keyed value map (e.g. Fama-French factors) to bar dates. */
export function alignMap<T>(dates: readonly string[], m: ReadonlyMap<string, T>): { idx: number[]; vals: T[] } {
  const idx: number[] = [];
  const vals: T[] = [];
  dates.forEach((d, i) => { const v = m.get(d); if (v !== undefined) { idx.push(i); vals.push(v); } });
  return { idx, vals };
}

/** Every k-th observation counted back from the newest, oldest → newest (e.g. weekly from daily with k = 5). */
export function sampleEvery<T>(xs: readonly T[], k: number): T[] {
  const out: T[] = [];
  for (let i = xs.length - 1; i >= 0; i -= k) out.push(xs[i]);
  return out.reverse();
}

/** The close on or before `date` (bars sorted oldest → newest), or null. */
export function closeOnOrBefore(bars: readonly Bar[], date: string): number | null {
  let lo = 0, hi = bars.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].date <= date) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans >= 0 ? bars[ans].close : null;
}
