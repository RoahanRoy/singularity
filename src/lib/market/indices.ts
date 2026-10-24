/**
 * The broad-market index each desk is measured against, and its level now.
 * Framework-free so the benchmark route and the Horizon sync share it.
 */

export type DeskMarket = "US" | "IN";

/** `etf`: the exchange-traded fund the desk holds as its index core. */
export const DESK_INDEX = {
  US: { symbol: "^GSPC", name: "S&P 500", etf: "SPY" },
  IN: { symbol: "^NSEI", name: "Nifty 50", etf: "NIFTYBEES" },
} as const;

/**
 * The index's latest level from Yahoo (the live price in session, the close
 * after it); null if Yahoo doesn't answer within a few seconds, so a caller
 * recording it can skip the point rather than stall.
 */
export async function indexLevel(market: DeskMarket, timeoutMs = 6000): Promise<number | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(DESK_INDEX[market].symbol)}?interval=1d&range=5d`,
      { headers: { "User-Agent": "Mozilla/5.0" }, signal: ctrl.signal, cache: "no-store" },
    );
    if (!res.ok) return null;
    const json = (await res.json()) as { chart?: { result?: { meta?: { regularMarketPrice?: unknown } }[] } };
    const level = json.chart?.result?.[0]?.meta?.regularMarketPrice;
    return typeof level === "number" && level > 0 ? level : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}
