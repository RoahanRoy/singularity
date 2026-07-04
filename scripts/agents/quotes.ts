/**
 * Real quotes for the paper broker.
 *
 * Yahoo Finance's chart endpoint is free and key-less; we call it directly from
 * the agent scripts (no browser CORS to worry about here). US tickers use the
 * bare symbol; NSE names take a ".NS" suffix. On any failure we return null so
 * the caller can fall back to a deterministic stub — the loop must never wedge
 * because a quote provider hiccuped.
 *
 * Trust tier: pure HTTP. No LLM, no DB. Cannot be influenced beyond the number
 * it returns, which the broker sanity-bounds before use.
 */
const YF = "https://query1.finance.yahoo.com/v8/finance/chart/";
const TIMEOUT_MS = 6000;

/** Map a desk ticker to its Yahoo symbol. */
export function yahooSymbol(ticker: string, market: "US" | "IN" = "US"): string {
  const t = ticker.trim().toUpperCase();
  return market === "IN" ? `${t}.NS` : t;
}

/**
 * Latest regular-market price for a ticker, or null if unavailable.
 * Deterministic fallback is the caller's responsibility.
 */
export async function getQuote(ticker: string, market: "US" | "IN" = "US"): Promise<number | null> {
  const symbol = yahooSymbol(ticker, market);
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const res = await fetch(`${YF}${encodeURIComponent(symbol)}?interval=1d&range=1d`, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: ctrl.signal,
      cache: "no-store",
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const json = await res.json();
    const price = json?.chart?.result?.[0]?.meta?.regularMarketPrice;
    return typeof price === "number" && price > 0 ? price : null;
  } catch {
    return null;
  }
}

/**
 * Deterministic per-ticker stub price for when the quote provider is down or the
 * symbol doesn't resolve (e.g. offline dev). Stable for a given ticker so a
 * position's avg_cost doesn't jump around across cycles on the fallback path.
 */
export function stubPrice(ticker: string): number {
  let h = 0;
  for (let i = 0; i < ticker.length; i++) h = (h * 31 + ticker.charCodeAt(i)) >>> 0;
  return Number((50 + (h % 45000) / 100).toFixed(2)); // ~50..500
}
