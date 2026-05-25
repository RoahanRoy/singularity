/**
 * EDGAR reader — the strictest trust tier.
 *
 * Pure HTTP. No LLM, no Appwrite, no downstream context. Returns structured
 * data only. Cannot be influenced by the content of any filing it fetches.
 *
 * Trust model (per AGENT_DESIGN.md §5):
 *   - This module knows how to parse SEC JSON/HTML.
 *   - It does NOT decide what to do with the result.
 *   - It does NOT call any LLM.
 *   - It does NOT write to Appwrite.
 *
 * SEC requires a descriptive User-Agent on every request. We send one.
 * Rate limit: SEC asks for ≤10 req/sec. Our loop is far below that.
 */
import fs from "node:fs";
import path from "node:path";

const USER_AGENT = process.env.MERIDIAN_SEC_UA || "MERIDIAN research roahan111@gmail.com";
const TICKER_MAP_URL = "https://www.sec.gov/files/company_tickers.json";
const TICKER_MAP_CACHE = path.resolve(".edgar-tickers.json");
const TICKER_MAP_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7d

const FORMS_OF_INTEREST = ["10-Q", "10-K", "8-K"] as const;

export type EdgarFiling = {
  ticker: string;
  cik: string;            // zero-padded 10 digits
  form_type: string;
  filed_at: string;       // ISO date
  source_url: string;     // index page
  primary_doc_url: string;
  raw_excerpt: string;    // first N chars of plaintext, UNTRUSTED
};

async function fetchSec(url: string): Promise<Response> {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json,text/html" } });
  if (!res.ok) throw new Error(`SEC ${url} → ${res.status}`);
  return res;
}

/** Ticker → zero-padded 10-digit CIK. Cached locally for 7 days. */
async function tickerToCik(ticker: string): Promise<string> {
  let map: Record<string, { cik_str: number; ticker: string }>;
  const fresh =
    fs.existsSync(TICKER_MAP_CACHE) &&
    Date.now() - fs.statSync(TICKER_MAP_CACHE).mtimeMs < TICKER_MAP_TTL_MS;

  if (fresh) {
    map = JSON.parse(fs.readFileSync(TICKER_MAP_CACHE, "utf8"));
  } else {
    const res = await fetchSec(TICKER_MAP_URL);
    map = (await res.json()) as typeof map;
    fs.writeFileSync(TICKER_MAP_CACHE, JSON.stringify(map));
  }

  const hit = Object.values(map).find((e) => e.ticker.toUpperCase() === ticker.toUpperCase());
  if (!hit) throw new Error(`No CIK for ticker ${ticker}`);
  return String(hit.cik_str).padStart(10, "0");
}

/** Most recent filing matching FORMS_OF_INTEREST. */
async function latestFiling(cik: string): Promise<{ form: string; filedAt: string; accession: string; primaryDoc: string }> {
  const res = await fetchSec(`https://data.sec.gov/submissions/CIK${cik}.json`);
  const data = (await res.json()) as {
    filings: { recent: { form: string[]; filingDate: string[]; accessionNumber: string[]; primaryDocument: string[] } };
  };
  const r = data.filings.recent;
  for (let i = 0; i < r.form.length; i++) {
    if ((FORMS_OF_INTEREST as readonly string[]).includes(r.form[i])) {
      return {
        form: r.form[i],
        filedAt: r.filingDate[i],
        accession: r.accessionNumber[i],
        primaryDoc: r.primaryDocument[i],
      };
    }
  }
  throw new Error(`No 10-Q/10-K/8-K in recent filings for CIK ${cik}`);
}

/** Strip HTML/tags down to plaintext. Crude but enough for an excerpt. */
function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Fetch the most recent material filing for a ticker. Returns structured
 * data plus a plaintext excerpt. The excerpt is UNTRUSTED — never feed it to
 * a tool-using LLM, only to a summarizer with no tool access.
 */
export async function fetchLatestFiling(ticker: string, excerptChars = 12000): Promise<EdgarFiling> {
  const cik = await tickerToCik(ticker);
  const { form, filedAt, accession, primaryDoc } = await latestFiling(cik);
  const accNoDashes = accession.replace(/-/g, "");
  const baseUrl = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accNoDashes}`;
  const docUrl = `${baseUrl}/${primaryDoc}`;
  const indexUrl = `${baseUrl}/${accession}-index.htm`;

  const docRes = await fetch(docUrl, { headers: { "User-Agent": USER_AGENT } });
  if (!docRes.ok) throw new Error(`SEC doc ${docUrl} → ${docRes.status}`);
  const html = await docRes.text();
  const text = stripHtml(html);

  return {
    ticker,
    cik,
    form_type: form,
    filed_at: filedAt,
    source_url: indexUrl,
    primary_doc_url: docUrl,
    raw_excerpt: text.slice(0, excerptChars),
  };
}
