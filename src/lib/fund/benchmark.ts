/**
 * Benchmark — is the book beating the broad market?
 *
 * The desk's goal is to beat its index (S&P 500 for US, Nifty 50 for India),
 * and recorded NAV history is too thin to say whether it does. So this replays
 * the book the operator holds today — its current share counts — over the
 * index's own trading days and compares the two:
 *
 *  - Both series are rebased to 100 on the first day of the window.
 *  - A holding with no close on a day carries its last close forward; one that
 *    starts trading inside the window is held at its first close until then.
 *  - Book return = Σ wᵢ·rᵢ with wᵢ the start-of-window weights (buy and hold),
 *    so each holding's share of the excess, wᵢ·(rᵢ − r_index), sums exactly to
 *    the book's excess over the index.
 *  - Beta, tracking error and capture ratios come from daily returns.
 *
 * Pure: no I/O, so the Portfolio screen and the tests share it.
 */

export type Bar = { date: string; close: number };

export type BenchmarkHolding = { ticker: string; label?: string | null; qty: number; bars: Bar[] };

export type HoldingVsIndex = {
  ticker: string;
  label?: string | null;
  /** Share of the book at the start of the window. */
  weight: number;
  /** Price return over the window. */
  ret: number;
  /** ret − index return. */
  excess: number;
  /** weight × excess: this holding's part of the book's excess. */
  contribution: number;
};

export type BenchmarkResult = {
  dates: string[];
  /** Book value rebased to 100 at the first date. */
  book: number[];
  /** Index level rebased to 100 at the first date. */
  index: number[];
  bookReturn: number;
  indexReturn: number;
  excess: number;
  /** Daily-return beta of the book against the index; null with too few days. */
  beta: number | null;
  correlation: number | null;
  /** Annualised standard deviation of the daily excess return. */
  trackingError: number | null;
  /** Mean book return on index up days ÷ mean index return on those days. */
  upCapture: number | null;
  downCapture: number | null;
  bookMaxDrawdown: number;
  indexMaxDrawdown: number;
  holdings: HoldingVsIndex[];
  /** Tickers with no price history in the window, left out of the book. */
  missing: string[];
};

const TRADING_DAYS = 252;
/** Daily returns needed before beta, tracking error, vol or Sharpe is read. */
export const MIN_DAYS_FOR_STATS = 10;

export function compareToIndex(holdings: BenchmarkHolding[], index: Bar[], from?: string): BenchmarkResult | null {
  const idx = index.filter((b) => b.close > 0 && (!from || b.date >= from)).sort((a, b) => a.date.localeCompare(b.date));
  if (idx.length < 2) return null;
  const dates = idx.map((b) => b.date);

  const missing: string[] = [];
  const priced: { h: BenchmarkHolding; closes: number[] }[] = [];
  for (const h of holdings) {
    if (!(h.qty > 0)) continue;
    const closes = alignCloses(h.bars, dates);
    if (!closes) { missing.push(h.ticker); continue; }
    priced.push({ h, closes });
  }
  if (!priced.length) return null;

  const value = dates.map((_, t) => priced.reduce((s, p) => s + p.h.qty * p.closes[t], 0));
  const v0 = value[0];
  const i0 = idx[0].close;
  const book = value.map((v) => (v / v0) * 100);
  const level = idx.map((b) => (b.close / i0) * 100);
  const indexReturn = level[level.length - 1] / 100 - 1;

  const holdingsOut: HoldingVsIndex[] = priced
    .map(({ h, closes }) => {
      const weight = (h.qty * closes[0]) / v0;
      const ret = closes[closes.length - 1] / closes[0] - 1;
      return { ticker: h.ticker, label: h.label, weight, ret, excess: ret - indexReturn, contribution: weight * (ret - indexReturn) };
    })
    .sort((a, b) => b.contribution - a.contribution);

  return { ...compareSeries(dates, book, level), holdings: holdingsOut, missing };
}

/**
 * Two aligned series already rebased to 100 — the book and the index — and
 * the stats that say how one tracks the other. Shared by the replayed book
 * above and the recorded track (scorecard.ts).
 */
export function compareSeries(
  dates: string[], book: number[], index: number[],
): Omit<BenchmarkResult, "holdings" | "missing"> {
  const bookReturn = book[book.length - 1] / book[0] - 1;
  const indexReturn = index[index.length - 1] / index[0] - 1;
  const rb = dailyReturns(book), ri = dailyReturns(index);
  const enough = rb.length >= MIN_DAYS_FOR_STATS;
  const varI = variance(ri);
  const cov = covariance(rb, ri);
  const varB = variance(rb);
  const up = ri.map((r, k) => [rb[k], r] as const).filter(([, r]) => r > 0);
  const down = ri.map((r, k) => [rb[k], r] as const).filter(([, r]) => r < 0);
  const capture = (xs: (readonly [number, number])[]) => {
    const m = mean(xs.map(([, r]) => r));
    return xs.length && m !== 0 ? mean(xs.map(([b]) => b)) / m : null;
  };

  return {
    dates, book, index, bookReturn, indexReturn, excess: bookReturn - indexReturn,
    beta: enough && varI > 0 ? cov / varI : null,
    correlation: enough && varI > 0 && varB > 0 ? cov / Math.sqrt(varI * varB) : null,
    trackingError: enough ? Math.sqrt(variance(rb.map((r, k) => r - ri[k])) * TRADING_DAYS) : null,
    upCapture: enough ? capture(up) : null,
    downCapture: enough ? capture(down) : null,
    bookMaxDrawdown: maxDrawdown(book),
    indexMaxDrawdown: maxDrawdown(index),
  };
}

/** Closes on each of `dates`: last close carried forward, the first close carried back. */
function alignCloses(bars: Bar[], dates: string[]): number[] | null {
  const sorted = bars.filter((b) => b.close > 0).sort((a, b) => a.date.localeCompare(b.date));
  if (!sorted.length || sorted[0].date > dates[dates.length - 1]) return null;
  const out: number[] = [];
  let k = 0;
  let last: number | null = null;
  for (const d of dates) {
    while (k < sorted.length && sorted[k].date <= d) last = sorted[k++].close;
    out.push(last ?? NaN);
  }
  const first = out.find((x) => !Number.isNaN(x));
  if (first == null) return null;
  return out.map((x) => (Number.isNaN(x) ? first : x));
}

function dailyReturns(xs: number[]): number[] {
  const out: number[] = [];
  for (let t = 1; t < xs.length; t++) out.push(xs[t] / xs[t - 1] - 1);
  return out;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);

function covariance(a: number[], b: number[]): number {
  if (a.length < 2) return 0;
  const ma = mean(a), mb = mean(b);
  return a.reduce((s, x, k) => s + (x - ma) * (b[k] - mb), 0) / (a.length - 1);
}

const variance = (xs: number[]) => covariance(xs, xs);

/** Largest peak-to-trough fall, as a negative fraction. */
export function maxDrawdown(xs: number[]): number {
  let peak = -Infinity, dd = 0;
  for (const x of xs) {
    peak = Math.max(peak, x);
    dd = Math.min(dd, x / peak - 1);
  }
  return dd;
}

/**
 * A stand-in's history moved to the level of the holding it stands for: same
 * daily returns, last close equal to `price`. Without this a gold ETF at ₹117
 * standing in for a ₹14,000 gold bond would weigh a hundredth of what it should.
 */
export function rescaleTo(bars: Bar[], price: number): Bar[] {
  const last = bars.reduce<Bar | null>((m, b) => (b.close > 0 && (!m || b.date > m.date) ? b : m), null);
  if (!last || !(price > 0)) return bars;
  const k = price / last.close;
  return bars.map((b) => ({ date: b.date, close: b.close * k }));
}

/** First date of a trailing window ending at `last` (YYYY-MM-DD). */
export function windowStart(last: string, range: BenchmarkRange): string {
  const d = new Date(`${last}T00:00:00Z`);
  if (range === "YTD") return `${d.getUTCFullYear()}-01-01`;
  const months = { "1M": 1, "3M": 3, "6M": 6, "1Y": 12 }[range];
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
}

export type BenchmarkRange = "1M" | "3M" | "6M" | "YTD" | "1Y";
export const BENCHMARK_RANGES: BenchmarkRange[] = ["1M", "3M", "6M", "YTD", "1Y"];
