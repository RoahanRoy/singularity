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
import { extractText, getDocumentProxy } from "unpdf";
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
    signal: AbortSignal.timeout(15_000),
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

/**
 * GET an NSE API path with the session cookie. From the cloud sandbox NSE
 * often drops the connection or answers 5xx/bot-wall for one request in a
 * sweep, so a failed attempt re-handshakes and tries once more after a pause.
 */
async function nseGet(apiPath: string, refererPath: string): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      const cookie = await nseCookie();
      res = await fetch(`${NSE_HOME}${apiPath}`, {
        headers: { ...BROWSER_HEADERS, Accept: "application/json", Referer: `${NSE_HOME}${refererPath}`, Cookie: cookie },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      if (attempt >= 2) throw err;
      cookieJar = null;
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    const retryable = res.status === 401 || res.status === 403 || res.status >= 500;
    if (retryable) cookieJar = null; // force re-handshake next attempt
    if (!retryable || attempt >= 2) return res;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function fetchAnnouncements(symbol: string): Promise<NseAnnouncement[]> {
  const res = await nseGet(
    `/api/corporate-announcements?index=equities&symbol=${encodeURIComponent(symbol)}`,
    `/get-quotes/equity?symbol=${encodeURIComponent(symbol)}`,
  );
  if (res.status === 401 || res.status === 403) {
    throw new Error(`NSE announcements ${symbol} → ${res.status} (bot wall)`);
  }
  if (!res.ok) throw new Error(`NSE announcements ${symbol} → ${res.status}`);
  const data = (await res.json()) as NseAnnouncement[] | { data?: NseAnnouncement[] };
  // NSE sometimes wraps the array in { data: [...] }, sometimes returns it bare.
  const arr = Array.isArray(data) ? data : data.data ?? [];
  if (!Array.isArray(arr)) throw new Error(`NSE announcements ${symbol} → unexpected shape`);
  return arr;
}

/**
 * GET any other NSE JSON API path (e.g. "/api/corporates-pit?...") through the
 * same cookie handshake. Used by market-data.ts for insider (PIT) disclosures.
 * Throws on failure, like fetchAnnouncements.
 */
export async function nseJson<T>(apiPath: string, refererPath: string): Promise<T> {
  const res = await nseGet(apiPath, refererPath);
  if (res.status === 401 || res.status === 403) {
    throw new Error(`NSE ${apiPath} → ${res.status} (bot wall)`);
  }
  if (!res.ok) throw new Error(`NSE ${apiPath} → ${res.status}`);
  return (await res.json()) as T;
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

// How "material" an announcement category is, for ranking. Procedural notices
// (trading-window closures, board-meeting intimations) carry no fundamental
// signal on their own, so a single one of them would starve the analyst. We
// surface a DIGEST of recent disclosures and lead with the most material.
function materiality(desc: string): number {
  const d = desc.toLowerCase();
  if (/financial result|outcome of board|earnings|quarterly result/.test(d)) return 100;
  if (/investor|analyst|press release|presentation|conference call|transcript/.test(d)) return 80;
  if (/acquisition|merger|amalgamation|order|contract|capacity|expansion|fund rais|dividend|buyback|bonus/.test(d)) return 70;
  if (/credit rating|agreement|joint venture|subsidiary|allotment/.test(d)) return 50;
  if (/trading window|board meeting|loss of|duplicate|newspaper|record date|book closure/.test(d)) return 10;
  return 30;
}

/** Figures as results statements print them: 1,54,034 · 30,622.84 · 18% */
const FIGURE = /\d{1,3}(?:,\d{2,3})+(?:\.\d+)?|\d+\.\d{2}\b|\d+(?:\.\d+)?\s?%/g;
/** A results PDF with fewer figures than this is scanned images or a cover letter. */
const MIN_FIGURES = 40;
/** Results older than this are no longer a read on the business. */
const RESULTS_MAX_AGE_DAYS = 200;

/** Filers post results as "Financial Results" or inside an "Outcome of Board Meeting". */
const mayHoldResults = (a: NseAnnouncement): boolean =>
  /financial result|outcome of board/i.test(a.desc ?? "") || /financial results for the/i.test(a.attchmntText ?? "");

/**
 * The figures in a results announcement's PDF: the slice of its text densest
 * in numbers, starting just above a statement line so the period headings come
 * along. Null when the PDF is gone, scanned (no text layer) or unreadable.
 */
async function resultsExcerpt(url: string, chars: number): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": NSE_UA }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    if (new TextDecoder().decode(buf.slice(0, 4)) !== "%PDF") return null;
    const { text } = await extractText(await getDocumentProxy(buf), { mergePages: true });
    // Some filers' PDFs space out digit groups ("5 , 75 , 612").
    const flat = text.replace(/\s+/g, " ").replace(/(\d) , (?=\d)/g, "$1,");
    const starts = [0];
    for (const m of flat.matchAll(/revenue from operations|total income|interest earned/gi)) {
      starts.push(Math.max(0, m.index - 400));
    }
    let best = 0;
    let bestCount = 0;
    for (const s of starts) {
      const count = flat.slice(s, s + chars).match(FIGURE)?.length ?? 0;
      if (count > bestCount) [best, bestCount] = [s, count];
    }
    return bestCount >= MIN_FIGURES ? flat.slice(best, best + chars) : null;
  } catch {
    return null;
  }
}

/**
 * Fetch recent corporate announcements for an NSE-listed symbol and return a
 * DIGEST in the same shape edgarReader produces, so the downstream
 * summarize → indexFiling → analyst chain is unchanged.
 *
 * Why a digest, not just the latest: most NSE announcements are procedural
 * (trading-window closures, board-meeting intimations). Feeding only the newest
 * one frequently hands the analyst nothing to underwrite. We instead surface the
 * most material recent disclosures (results, presentations, M&A, ratings) so the
 * desk reasons over the real recent disclosure flow.
 *
 * `form_type` is the fixed token "NSE-ANNC" (not "NSE-RESULT"), which routes the
 * excerpt through the standard filing-summarizer — it is real, untrusted
 * announcement text, exactly what that summarizer expects. The "NSE-RESULT"
 * sentinel is reserved for the LLM-only fallback path in edgarReader.
 *
 * Throws on any fetch/parse failure or when the symbol has no announcements;
 * callers fall back to the LLM-only brief.
 */
/**
 * Cheap "what's the newest announcement" probe for the event scanner — the
 * India analogue of edgar.ts's fetchLatestFilingKey. Warms the NSE cookie and
 * reads the announcements list only; returns the most recent announcement's
 * datetime as a stable key the scanner diffs against its watermark. Best-effort:
 * NSE's bot wall / rate limits make failure routine, so any throw returns null
 * and the sweep simply skips this symbol.
 */
export async function fetchLatestIndiaKey(
  ticker: string,
): Promise<{ key: string; form: string; filedAt: string } | null> {
  try {
    const annc = await fetchAnnouncements(ticker.toUpperCase());
    if (!annc.length) return null;
    annc.sort((a, b) => (b.sort_date ?? b.an_dt ?? "").localeCompare(a.sort_date ?? a.an_dt ?? ""));
    const top = annc[0];
    const key = (top.sort_date || top.an_dt || "").trim();
    return {
      key: key || toIsoDate(top.an_dt || top.sort_date),
      form: cleanText(top.desc ?? "NSE-ANNC") || "NSE-ANNC",
      filedAt: toIsoDate(top.an_dt || top.sort_date),
    };
  } catch {
    return null;
  }
}

/**
 * Does the symbol post NSE announcements? False only for a confirmed empty
 * list (ETFs, gold bonds, SME listings); a failed fetch counts as yes, so an
 * NSE outage doesn't empty the round-robin.
 */
export async function hasNseAnnouncements(ticker: string): Promise<boolean> {
  try {
    return (await fetchAnnouncements(ticker.toUpperCase())).length > 0;
  } catch {
    return true;
  }
}

export async function fetchLatestIndiaFiling(ticker: string, excerptChars = 12000): Promise<EdgarFiling> {
  const symbol = ticker.toUpperCase();
  const annc = await fetchAnnouncements(symbol);
  if (!annc.length) throw new Error(`No NSE announcements for ${symbol}`);

  // Most recent first by announcement datetime.
  annc.sort((a, b) => (b.sort_date ?? b.an_dt ?? "").localeCompare(a.sort_date ?? a.an_dt ?? ""));
  const top = annc[0];

  // NSE's own industry classification, where present (often blank for newer or
  // market-infrastructure names). Prefer the most recent record that carries it.
  const industry = cleanText(annc.find((a) => a.smIndustry)?.smIndustry ?? "");
  const industryLine = industry ? `Industry: ${industry}.\n` : "";

  // Take the most recent ~15 announcements, then order by materiality so the
  // summarizer leads with substance, not the latest procedural notice.
  const recent = annc.slice(0, 15);
  recent.sort((a, b) => materiality(b.desc ?? "") - materiality(a.desc ?? ""));
  const lines = recent
    .map((a) => {
      const date = toIsoDate(a.an_dt || a.sort_date);
      const subj = cleanText(a.desc ?? "Announcement");
      const text = cleanText(a.attchmntText || a.bdp_descr || "");
      return `- [${date}] ${subj}${text ? `: ${text}` : ""}`;
    })
    .join("\n");

  const digest = `[NSE corporate-announcements digest — ${symbol}]\n${industryLine}Most material recent disclosures:\n${lines}`;

  // A results announcement's text only says results were filed; the numbers
  // are in its PDF. Follow the digest with the latest results' figures, trying
  // the newest few candidates (a board outcome may be only a dividend notice).
  const lead = digest.slice(0, 4000);
  const candidates = annc
    .filter((a) => mayHoldResults(a) && a.attchmntFile)
    .filter((a) => Date.now() - Date.parse(toIsoDate(a.an_dt || a.sort_date)) <= RESULTS_MAX_AGE_DAYS * 86_400_000)
    .slice(0, 3);
  let results: NseAnnouncement | undefined;
  let figures: string | null = null;
  for (const a of candidates) {
    figures = await resultsExcerpt(a.attchmntFile!, excerptChars - lead.length - 100);
    if (figures) { results = a; break; }
  }
  const excerpt = results
    ? `${lead}\n\n[Financial results filed ${toIsoDate(results.an_dt || results.sort_date)}, from the attached PDF]\n${figures}`
    : digest.slice(0, excerptChars);

  return {
    ticker: symbol,
    cik: "NSE",
    form_type: "NSE-ANNC",
    filed_at: toIsoDate(top.an_dt || top.sort_date),
    source_url: `${NSE_HOME}/companies-listing/corporate-filings-announcements?symbol=${encodeURIComponent(symbol)}`,
    primary_doc_url: (results ?? top).attchmntFile || "nse-announcement://no-attachment",
    raw_excerpt: excerpt,
    industry: industry || undefined,
  };
}
