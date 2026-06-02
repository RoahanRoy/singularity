/**
 * MERIDIAN — News ingestion agent.
 *
 * Fetches Google News RSS per ticker and indexes results into the `news`
 * Appwrite collection. Free, no API key. Items are deduped via a unique
 * index on sha256(url), so re-running is safe.
 *
 * Run with:
 *   npm run agents:news               continuous (every NEWS_INTERVAL_MS)
 *   MERIDIAN_NEWS_ONCE=1 npm run agents:news    single pass and exit
 *
 * Env knobs:
 *   MERIDIAN_NEWS_INTERVAL_MS    pause between passes (default 1800000 / 30min)
 *   MERIDIAN_NEWS_MARKETS        comma-list of markets to ingest (default "US,IN")
 *   MERIDIAN_NEWS_PER_TICKER     max items kept per ticker per pass (default 5)
 */
import { createHash } from "node:crypto";
import { db, DB, ID } from "./appwrite";
import { FULL_UNIVERSE, INDIA_UNIVERSE } from "./universe";

const ONCE = process.env.MERIDIAN_NEWS_ONCE === "1";
const INTERVAL_MS = Number(process.env.MERIDIAN_NEWS_INTERVAL_MS || 30 * 60_000);
const PER_TICKER = Number(process.env.MERIDIAN_NEWS_PER_TICKER || 5);
const MARKETS: Array<"US" | "IN"> = (process.env.MERIDIAN_NEWS_MARKETS || "US,IN")
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter((m): m is "US" | "IN" => m === "US" || m === "IN");

let stopping = false;
process.on("SIGTERM", () => { stopping = true; });
process.on("SIGINT",  () => { stopping = true; });

type RssItem = { title: string; link: string; pubDate: string; source: string };

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

/** Minimal RSS parser tuned for Google News output. */
function parseRss(xml: string): RssItem[] {
  const items: RssItem[] = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml))) {
    const block = m[1];
    const titleM = /<title>([\s\S]*?)<\/title>/.exec(block);
    const linkM = /<link>([\s\S]*?)<\/link>/.exec(block);
    const dateM = /<pubDate>([\s\S]*?)<\/pubDate>/.exec(block);
    const sourceM = /<source[^>]*>([\s\S]*?)<\/source>/.exec(block);
    if (!titleM || !linkM) continue;
    const title = decodeEntities(titleM[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim());
    const link = decodeEntities(linkM[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim());
    const pubDate = dateM ? new Date(dateM[1].trim()).toISOString() : new Date().toISOString();
    const source = sourceM
      ? decodeEntities(sourceM[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim())
      : "Google News";
    items.push({ title, link, pubDate, source });
  }
  return items;
}

function queryFor(ticker: string, market: "US" | "IN"): string {
  if (market === "IN") return `${ticker} NSE stock`;
  return `${ticker} stock`;
}

async function fetchTickerNews(ticker: string, market: "US" | "IN"): Promise<RssItem[]> {
  const q = encodeURIComponent(queryFor(ticker, market));
  const hl = market === "IN" ? "en-IN" : "en-US";
  const gl = market === "IN" ? "IN" : "US";
  const ceid = market === "IN" ? "IN:en" : "US:en";
  const url = `https://news.google.com/rss/search?q=${q}&hl=${hl}&gl=${gl}&ceid=${ceid}`;

  const res = await fetch(url, {
    headers: {
      "User-Agent": "MeridianNewsBot/1.0 (+https://meridian.local)",
      "Accept": "application/rss+xml,application/xml;q=0.9",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${ticker}`);
  }
  const xml = await res.text();
  return parseRss(xml).slice(0, PER_TICKER);
}

async function indexItem(ticker: string, market: "US" | "IN", item: RssItem): Promise<"new" | "dup"> {
  const url = item.link.slice(0, 1024);
  const url_hash = createHash("sha256").update(url).digest("hex");
  try {
    await db.createDocument(DB, "news", ID.unique(), {
      ticker,
      market,
      source: item.source.slice(0, 64),
      title: item.title.slice(0, 512),
      url,
      url_hash,
      summary: null,
      sentiment: null,
      published_at: item.pubDate,
      fetched_at: new Date().toISOString(),
    });
    return "new";
  } catch (err) {
    const msg = (err as Error).message || "";
    // unique index on `url_hash` rejects duplicates — treat as a quiet no-op.
    if (/already exists|duplicate|conflict/i.test(msg)) return "dup";
    throw err;
  }
}

function universeFor(market: "US" | "IN"): readonly string[] {
  return market === "IN" ? INDIA_UNIVERSE : FULL_UNIVERSE;
}

async function pass(): Promise<void> {
  for (const market of MARKETS) {
    const tickers = universeFor(market);
    console.log(`[news] ${market} pass — ${tickers.length} tickers`);
    let added = 0, dup = 0, failed = 0;
    for (const ticker of tickers) {
      if (stopping) return;
      try {
        const items = await fetchTickerNews(ticker, market);
        for (const it of items) {
          const r = await indexItem(ticker, market, it);
          if (r === "new") added++; else dup++;
        }
      } catch (err) {
        failed++;
        console.warn(`[news] ${market}/${ticker} failed: ${(err as Error).message}`);
      }
      // Gentle pacing — Google News tolerates ~1 req/sec from a single IP.
      await new Promise((r) => setTimeout(r, 600));
    }
    console.log(`[news] ${market} pass done — +${added} new, ${dup} dup, ${failed} failed`);
  }
}

async function main(): Promise<void> {
  console.log(`[news] booted — markets=${MARKETS.join(",")} interval=${INTERVAL_MS}ms per_ticker=${PER_TICKER}`);
  while (!stopping) {
    const t0 = Date.now();
    try {
      await pass();
    } catch (err) {
      console.error(`[news] pass crashed: ${(err as Error).message}`);
    }
    if (ONCE || stopping) break;
    const elapsed = Date.now() - t0;
    const wait = Math.max(60_000, INTERVAL_MS - elapsed);
    console.log(`[news] sleeping ${(wait / 1000) | 0}s`);
    await new Promise((r) => setTimeout(r, wait));
  }
  console.log(`[news] stopped.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
