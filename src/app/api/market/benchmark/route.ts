import type { NextRequest } from "next/server";
import { requireOperator } from "@/lib/appwrite/server";
import type { Bar } from "@/lib/fund/benchmark";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A year of daily closes for the desk's index and the tickers it holds, so the
 * Portfolio screen can chart the book against the broad market. Yahoo blocks
 * browser CORS, so this proxies its chart endpoint server-side. Call as
 * `?market=US&tickers=AAPL,MSFT`; tickers Yahoo can't resolve come back absent.
 * Closes change once a day, so each symbol is memoised for half an hour.
 */

const INDEX = { US: { symbol: "^GSPC", name: "S&P 500" }, IN: { symbol: "^NSEI", name: "Nifty 50" } } as const;

const YF = "https://query1.finance.yahoo.com/v8/finance/chart/";
const PER_SYMBOL_TIMEOUT = 8000;
const TTL_MS = 30 * 60_000;
const BATCH = 8;

const memo = new Map<string, { at: number; bars: Bar[] }>();

/** Desk ticker → Yahoo symbol: NSE names take ".NS"; US class shares use a dash (BRK.B → BRK-B). */
function yahooSymbol(ticker: string, market: "US" | "IN"): string {
  const t = ticker.trim().toUpperCase();
  if (t.startsWith("^") || /\.(NS|BO)$/.test(t)) return t;
  return market === "IN" ? `${t}.NS` : t.replace(/\./g, "-");
}

async function fetchBars(symbol: string): Promise<Bar[] | null> {
  const hit = memo.get(symbol);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.bars;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), PER_SYMBOL_TIMEOUT);
    const res = await fetch(`${YF}${encodeURIComponent(symbol)}?interval=1d&range=1y`, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: ctrl.signal,
      cache: "no-store",
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const json = await res.json();
    const r = json?.chart?.result?.[0];
    const ts: unknown = r?.timestamp;
    const closes: unknown = r?.indicators?.quote?.[0]?.close;
    if (!Array.isArray(ts) || !Array.isArray(closes)) return null;
    // Exchange-local calendar date: the timestamp is the session open in UTC.
    const offset = typeof r?.meta?.gmtoffset === "number" ? r.meta.gmtoffset : 0;
    const bars: Bar[] = [];
    ts.forEach((s, k) => {
      const c = closes[k];
      if (typeof s === "number" && typeof c === "number" && c > 0) {
        bars.push({ date: new Date((s + offset) * 1000).toISOString().slice(0, 10), close: c });
      }
    });
    if (!bars.length) return null;
    memo.set(symbol, { at: Date.now(), bars });
    return bars;
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest) {
  const denied = await requireOperator(request);
  if (denied) return denied;
  const market = request.nextUrl.searchParams.get("market") === "IN" ? "IN" : "US";
  const raw = request.nextUrl.searchParams.get("tickers") ?? "";
  const tickers = [...new Set(raw.split(",").map((s) => s.trim()).filter((s) => s && !s.startsWith("MF:")))].slice(0, 80);

  const index = INDEX[market];
  const indexBars = await fetchBars(index.symbol);
  if (!indexBars) {
    return Response.json({ error: `no history for ${index.name}` }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }

  const bars: Record<string, Bar[]> = {};
  for (let k = 0; k < tickers.length; k += BATCH) {
    const chunk = tickers.slice(k, k + BATCH);
    const got = await Promise.all(chunk.map((t) => fetchBars(yahooSymbol(t, market))));
    chunk.forEach((t, j) => { const b = got[j]; if (b) bars[t] = b; });
  }

  return Response.json(
    { index: { ...index, bars: indexBars }, bars, at: new Date().toISOString() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
