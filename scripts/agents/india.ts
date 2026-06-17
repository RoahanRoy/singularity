/**
 * NSE corporate-announcements reader — the India-desk analogue of edgar.ts.
 *
 * Pure HTTP. No LLM, no Appwrite, no downstream context. Returns structured
 * data only. Cannot be influenced by the content of any announcement it fetches.
 *
 * Trust model (per AGENT_DESIGN.md §5) — identical to edgar.ts:
 *   - This module knows how to fetch + parse NSE's announcements JSON.
 *   - It does NOT decide what to do with the result.
 *   - It does NOT call any LLM.
 *   - It does NOT write to Appwrite.
 *
 * NSE's public site fronts its JSON API behind a bot wall: a bare request gets
 * a 401/403. The standard, documented workaround is to first GET the homepage
 * to obtain the `nseappid`/`nsit` cookies, then replay them (with browser-like
 * headers + a Referer) against the API. We cache that cookie jar for a few
 * minutes so a sweep of many tickers warms up once.
 *
 * Failure is expected and non-fatal: NSE rate-limits and geo-blocks. Callers
 * (edgarReader, ingest) treat a throw as "no live data" and fall back to the
 * LLM-only brief, so the desk degrades gracefully instead of collapsing.
 */
import { EdgarFiling } from "./edgar";

const NSE_HOME = "https://www.nseindia.com";
// A real desktop Chrome UA — NSE rejects non-browser agents outright.
const NSE_UA =
  process.env.MERIDIAN_NSE_UA ||
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent": NSE_UA,
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-origin",
};

/** Raw NSE announcement record (only the fields we read; many more exist). */
type NseAnnouncement = {
  symbol?: string;
  desc?: string;          // category, e.g. "Financial Results"
  attchmntText?: string;  // announcement body text (often the real signal)
  attchmntFile?: string;  // PDF URL
  smIndustry?: string;    // industry label
  an_dt?: string;         // "2026-06-10 18:30:00"
  sort_date?: string;
  bdp_descr?: string;     // verbose description (sometimes present)
};

let cookieJar: { value: string; at: number } | null = null;
const COOKIE_TTL_MS = 4 * 60 * 1000; // 4 min — well inside NSE's session window

/** Warm up an NSE session and return a Cookie header string. Cached briefly. */
async function nseCookie(): Promise<string> {
  if (cookieJar && Date.now() - cookieJar.at < COOKIE_TTL_MS) return cookieJar.value;
  const res = await fetch(NSE_HOME, {
    headers: { ...BROWSER_HEADERS, Accept: "text/html,application/xhtml+xml" },
  });
  // Node 18+/undici exposes getSetCookie(); fall back to the combined header.
  const setCookies =
    (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ??
    (res.headers.get("set-cookie") ? [res.headers.get("set-cookie") as string] : []);
  const jar = setCookies.map((c) => c.split(";")[0]).join("; ");
  if (!jar) throw new Error(`NSE handshake returned no cookies (${res.status})`);
  cookieJar = { value: jar, at: Date.now() };
  return jar;
}

async function fetchAnnouncements(symbol: string): Promise<NseAnnouncement[]> {
  const cookie = await nseCookie();
  const url = `${NSE_HOME}/api/corporate-announcements?index=equities&symbol=${encodeURIComponent(symbol)}`;
  const res = await fetch(url, {
    headers: {
      ...BROWSER_HEADERS,
      Accept: "application/json",
      Referer: `${NSE_HOME}/get-quotes/equity?symbol=${encodeURIComponent(symbol)}`,
      Cookie: cookie,
    },
  });
  if (res.status === 401 || res.status === 403) {
    cookieJar = null; // force re-handshake next attempt
    throw new Error(`NSE announcements ${symbol} → ${res.status} (bot wall)`);
  }
  if (!res.ok) throw new Error(`NSE announcements ${symbol} → ${res.status}`);
  const data = (await res.json()) as NseAnnouncement[] | { data?: NseAnnouncement[] };
  // NSE sometimes wraps the array in { data: [...] }, sometimes returns it bare.
  const arr = Array.isArray(data) ? data : data.data ?? [];
  if (!Array.isArray(arr)) throw new Error(`NSE announcements ${symbol} → unexpected shape`);
  return arr;
}

const cleanText = (s: string): string =>
  s.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

function toIsoDate(dt?: string): string {
  if (!dt) return new Date().toISOString().slice(0, 10);
  // "2026-06-10 18:30:00" → "2026-06-10"
  const m = dt.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  const d = new Date(dt);
  return Number.isNaN(d.getTime()) ? new Date().toISOString().slice(0, 10) : d.toISOString().slice(0, 10);
}

/**
 * Fetch the most recent corporate announcement for an NSE-listed symbol and
 * return it in the same shape edgarReader produces, so the downstream
 * summarize → indexFiling → analyst chain is unchanged.
 *
 * `form_type` is the fixed token "NSE-ANNC" (not "NSE-RESULT"), which routes
 * the excerpt through the standard filing-summarizer — it is real, untrusted
 * announcement text, exactly what that summarizer expects. The "NSE-RESULT"
 * sentinel is reserved for the LLM-only fallback path in edgarReader.
 *
 * Throws on any fetch/parse failure or when the symbol has no announcements;
 * callers fall back to the LLM-only brief.
 */
export async function fetchLatestIndiaFiling(ticker: string, excerptChars = 12000): Promise<EdgarFiling> {
  const symbol = ticker.toUpperCase();
  const annc = await fetchAnnouncements(symbol);
  if (!annc.length) throw new Error(`No NSE announcements for ${symbol}`);

  // Most recent first by announcement datetime.
  annc.sort((a, b) => (b.sort_date ?? b.an_dt ?? "").localeCompare(a.sort_date ?? a.an_dt ?? ""));
  const top = annc[0];

  const subject = cleanText(top.desc ?? "Corporate announcement");
  const body = cleanText(top.attchmntText || top.bdp_descr || "");
  const industry = top.smIndustry ? `Industry: ${cleanText(top.smIndustry)}. ` : "";
  const excerpt =
    `[NSE corporate announcement — ${symbol}] ${industry}Subject: ${subject}. ${body}`.slice(0, excerptChars) ||
    `[NSE corporate announcement — ${symbol}] ${subject}`;

  return {
    ticker: symbol,
    cik: "NSE",
    form_type: "NSE-ANNC",
    filed_at: toIsoDate(top.an_dt || top.sort_date),
    source_url: `${NSE_HOME}/companies-listing/corporate-filings-announcements?symbol=${encodeURIComponent(symbol)}`,
    primary_doc_url: top.attchmntFile || "nse-announcement://no-attachment",
    raw_excerpt: excerpt,
  };
}
