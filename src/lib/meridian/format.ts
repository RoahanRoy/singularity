/**
 * Market-aware money formatting.
 *
 * US books are denominated in USD and abbreviated K/M/B. India books are
 * denominated in INR and abbreviated with the Indian lakh/crore convention
 * (1 L = 1e5, 1 Cr = 1e7). The agent loop and Kite sync both store raw
 * numeric magnitudes in the `nav_usd` / `market_value` fields regardless of
 * currency — the `market` flag here decides how they are rendered.
 */
export type Market = "US" | "IN";

const CCY: Record<Market, string> = { US: "$", IN: "₹" };

/** Compact magnitude, e.g. "$1.28B" or "₹4.21Cr". */
export function fmtMoney(n: number, market: Market = "US"): string {
  const sym = CCY[market];
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (market === "IN") {
    if (abs >= 1e7) return `${sign}${sym}${(abs / 1e7).toFixed(2)}Cr`;
    if (abs >= 1e5) return `${sign}${sym}${(abs / 1e5).toFixed(2)}L`;
    if (abs >= 1e3) return `${sign}${sym}${(abs / 1e3).toFixed(1)}K`;
    return `${sign}${sym}${abs.toFixed(0)}`;
  }
  if (abs >= 1e9) return `${sign}${sym}${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}${sym}${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}${sym}${(abs / 1e3).toFixed(1)}K`;
  return `${sign}${sym}${abs.toFixed(0)}`;
}

/** Full, grouped magnitude, e.g. "$1,284,000,000" or "₹4,21,00,000". */
export function fmtFullMoney(n: number, market: Market = "US"): string {
  const sym = CCY[market];
  const locale = market === "IN" ? "en-IN" : "en-US";
  return sym + Math.round(n).toLocaleString(locale);
}

/** The currency symbol for a market. */
export function currencySymbol(market: Market = "US"): string {
  return CCY[market];
}
