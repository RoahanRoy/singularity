import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Live quotes for the top ticker. Yahoo Finance's chart endpoint is free and
 * key-less but blocks browser CORS, so we proxy it server-side. Pass the
 * Yahoo symbols as `?symbols=ES=F,NVDA,^VIX`; we return a price + day-change %
 * per symbol. Symbols that fail to resolve are simply omitted so the client
 * can fall back to its seed value.
 */

type Quote = { price: number; changePct: number };

const YF = "https://query1.finance.yahoo.com/v8/finance/chart/";
// Keep a single fetch from hanging the whole batch.
const PER_SYMBOL_TIMEOUT = 6000;

async function fetchOne(symbol: string): Promise<[string, Quote] | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), PER_SYMBOL_TIMEOUT);
    const res = await fetch(`${YF}${encodeURIComponent(symbol)}?interval=1d&range=1d`, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: ctrl.signal,
      cache: "no-store",
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const json = await res.json();
    const meta = json?.chart?.result?.[0]?.meta;
    const price = meta?.regularMarketPrice;
    const prev = meta?.chartPreviousClose ?? meta?.previousClose;
    if (typeof price !== "number" || typeof prev !== "number" || prev === 0) return null;
    return [symbol, { price, changePct: ((price - prev) / prev) * 100 }];
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest) {
  const raw = request.nextUrl.searchParams.get("symbols") ?? "";
  const symbols = [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))].slice(0, 40);
  if (symbols.length === 0) return Response.json({ quotes: {} });

  const settled = await Promise.all(symbols.map(fetchOne));
  const quotes: Record<string, Quote> = {};
  for (const r of settled) if (r) quotes[r[0]] = r[1];

  return Response.json(
    { quotes, at: new Date().toISOString() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
