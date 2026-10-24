import type { NextRequest } from "next/server";
import { requireOperator } from "@/lib/appwrite/server";
import type { Bar } from "@/lib/fund/benchmark";
import { DESK_INDEX as INDEX } from "@/lib/market/indices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A year of daily closes for the desk's index and the tickers it holds, so the
 * Portfolio screen can chart the book against the broad market. Yahoo blocks
 * browser CORS, so this proxies its chart endpoint server-side. Call as
 * `?market=US&tickers=AAPL,MSFT`; tickers Yahoo can't resolve come back absent.
 * Closes change once a day, so each symbol is memoised for half an hour.
 *
 * The US desk holds everything bought abroad, so a ticker that isn't a US
 * listing ("ADYEN", "NQSE") is looked up on Yahoo's search and priced from the
 * listing whose base symbol it is (ADYEN.AS), converted into dollars at each
 * day's rate. Sovereign gold bonds have no Yahoo history; they pay the gold
 * price, so a gold ETF stands in for them, and `sources` says so.
 */

const DESK_CCY = { US: "USD", IN: "INR" } as const;

/** Stand-ins for instruments Yahoo doesn't carry, by ticker pattern. */
const PROXIES: { market: "US" | "IN"; match: RegExp; symbol: string; why: string }[] = [
  { market: "IN", match: /^SGB[A-Z]{3}\d{2}/, symbol: "GOLDBEES.NS", why: "gold bond, tracked by the GOLDBEES gold ETF" },
];

const YF = "https://query1.finance.yahoo.com";
const PER_SYMBOL_TIMEOUT = 8000;
const TTL_MS = 30 * 60_000;
const BATCH = 8;
/** One quote is a price, not a history: Yahoo returns that for thinly traded SME listings. */
const MIN_BARS = 2;

type Series = { bars: Bar[]; currency: string };

const memo = new Map<string, { at: number; series: Series | null }>();
const searchMemo = new Map<string, { at: number; symbol: string | null }>();

/** Desk ticker → Yahoo symbol: NSE names take ".NS"; US class shares use a dash (BRK.B → BRK-B). */
function yahooSymbol(ticker: string, market: "US" | "IN"): string {
  const t = ticker.trim().toUpperCase();
  if (t.startsWith("^") || t.includes("=") || /\.(NS|BO)$/.test(t)) return t;
  return market === "IN" ? `${t}.NS` : t.replace(/\./g, "-");
}

async function getJson(url: string): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), PER_SYMBOL_TIMEOUT);
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: ctrl.signal, cache: "no-store" });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function fetchSeries(symbol: string): Promise<Series | null> {
  const hit = memo.get(symbol);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.series;
  const json = (await getJson(`${YF}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1y`)) as
    | { chart?: { result?: { timestamp?: unknown; meta?: { gmtoffset?: unknown; currency?: unknown }; indicators?: { quote?: { close?: unknown }[] } }[] } }
    | null;
  if (json === null) return hit?.series ?? null; // a failed request isn't remembered as "no history"
  const r = json?.chart?.result?.[0];
  const ts = r?.timestamp;
  const closes = r?.indicators?.quote?.[0]?.close;
  let series: Series | null = null;
  if (Array.isArray(ts) && Array.isArray(closes)) {
    // Exchange-local calendar date: the timestamp is the session open in UTC.
    const offset = typeof r?.meta?.gmtoffset === "number" ? r.meta.gmtoffset : 0;
    const bars: Bar[] = [];
    ts.forEach((s, k) => {
      const c = closes[k];
      if (typeof s === "number" && typeof c === "number" && c > 0) {
        bars.push({ date: new Date((s + offset) * 1000).toISOString().slice(0, 10), close: c });
      }
    });
    const currency = typeof r?.meta?.currency === "string" ? r.meta.currency : "";
    if (bars.length >= MIN_BARS) series = { bars, currency };
  }
  memo.set(symbol, { at: Date.now(), series });
  return series;
}

/** The listing abroad a bare ticker names: the first equity or ETF whose symbol is `TICKER.<exchange>`. */
async function searchListing(ticker: string): Promise<string | null> {
  const hit = searchMemo.get(ticker);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.symbol;
  const json = (await getJson(`${YF}/v1/finance/search?q=${encodeURIComponent(ticker)}&quotesCount=8&newsCount=0`)) as
    | { quotes?: { symbol?: unknown; quoteType?: unknown }[] }
    | null;
  if (json === null) return null;
  const symbol =
    (json.quotes ?? [])
      .map((q) => ({ symbol: typeof q.symbol === "string" ? q.symbol : "", type: q.quoteType }))
      .find((q) => (q.type === "EQUITY" || q.type === "ETF") && q.symbol.toUpperCase().startsWith(`${ticker.toUpperCase()}.`))
      ?.symbol ?? null;
  searchMemo.set(ticker, { at: Date.now(), symbol });
  return symbol;
}

/**
 * Restate a series in the desk's currency at each day's close of the pair,
 * carrying the last rate over FX holidays. Pence and other minor units first
 * become their major unit.
 */
async function toDeskCurrency(s: Series, desk: string): Promise<Series | null> {
  const minor: Record<string, [string, number]> = { GBp: ["GBP", 100], GBX: ["GBP", 100], ZAc: ["ZAR", 100], ILA: ["ILS", 100] };
  const [ccy, div] = minor[s.currency] ?? [s.currency.toUpperCase(), 1];
  const bars = div === 1 ? s.bars : s.bars.map((b) => ({ date: b.date, close: b.close / div }));
  if (!ccy || ccy === desk) return { bars, currency: desk };
  const fx = await fetchSeries(`${ccy}${desk}=X`);
  if (!fx) return null;
  const rates = fx.bars;
  const out: Bar[] = [];
  let k = 0;
  let rate: number | null = null;
  for (const b of bars) {
    while (k < rates.length && rates[k].date <= b.date) rate = rates[k++].close;
    const r = rate ?? rates[0].close;
    out.push({ date: b.date, close: b.close * r });
  }
  return { bars: out, currency: desk };
}

type Source = { symbol: string; currency?: string; proxy?: string };

async function resolve(ticker: string, market: "US" | "IN"): Promise<{ bars: Bar[]; source: Source | null } | null> {
  const desk = DESK_CCY[market];
  const proxy = PROXIES.find((p) => p.market === market && p.match.test(ticker.toUpperCase()));
  let symbol = proxy?.symbol ?? yahooSymbol(ticker, market);
  let series = await fetchSeries(symbol);
  if (!series && !proxy && market === "US") {
    const abroad = await searchListing(ticker);
    if (abroad) {
      symbol = abroad;
      series = await fetchSeries(abroad);
    }
  }
  if (!series) return null;
  const converted = await toDeskCurrency(series, desk);
  if (!converted) return null;
  const foreign = series.currency && series.currency !== desk;
  const source: Source | null =
    proxy ? { symbol, proxy: proxy.why }
    : symbol !== yahooSymbol(ticker, market) || foreign ? { symbol, ...(foreign ? { currency: series.currency } : {}) }
    : null;
  return { bars: converted.bars, source };
}

export async function GET(request: NextRequest) {
  const denied = await requireOperator(request);
  if (denied) return denied;
  const market = request.nextUrl.searchParams.get("market") === "IN" ? "IN" : "US";
  const raw = request.nextUrl.searchParams.get("tickers") ?? "";
  const tickers = [...new Set(raw.split(",").map((s) => s.trim()).filter((s) => s && !s.startsWith("MF:")))].slice(0, 80);

  const index = INDEX[market];
  const indexSeries = await fetchSeries(index.symbol);
  if (!indexSeries) {
    return Response.json({ error: `no history for ${index.name}` }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }

  const bars: Record<string, Bar[]> = {};
  const sources: Record<string, Source> = {};
  for (let k = 0; k < tickers.length; k += BATCH) {
    const chunk = tickers.slice(k, k + BATCH);
    const got = await Promise.all(chunk.map((t) => resolve(t, market)));
    chunk.forEach((t, j) => {
      const g = got[j];
      if (!g) return;
      bars[t] = g.bars;
      if (g.source) sources[t] = g.source;
    });
  }

  return Response.json(
    { index: { ...index, bars: indexSeries.bars }, bars, sources, at: new Date().toISOString() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
