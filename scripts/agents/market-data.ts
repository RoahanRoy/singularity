/**
 * Market-data reader: every number the quant agents use comes through here.
 *
 * Pure HTTP, like edgar.ts and india.ts. No LLM, no Appwrite, no decisions.
 * It fetches public market data, maps vendor payloads onto the normalized
 * shapes in src/lib/quant/types.ts (so the math never sees vendor field names
 * or sign conventions) and caches them on disk. Vendor text (business
 * summaries, headlines) is returned as untrusted data and never interpreted.
 *
 * Sources, all public and key-less:
 *   Yahoo Finance  daily and intraday bars, statement time series, quoteSummary
 *                  (profile, analysts, estimates, insiders, short interest), news
 *   Google News    RSS headlines
 *   NSE            insider (PIT) disclosures, through india.ts's cookie handshake
 *   CBOE           delayed option chains (US listings only)
 *   Ken French     daily Fama-French 5 factors + momentum (US)
 *   FRED           Treasury and interbank rates, macro series
 *
 * Failure is routine (rate limits, bot walls, thin coverage), so nothing here
 * throws: each export resolves to null, logs why, and serves a recent disk
 * copy when a reload fails.
 *
 * Requests carry a plain browser User-Agent. Nothing here identifies the
 * operator; the contact-address UA in edgar.ts is for sec.gov only.
 */
import fs from "node:fs";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import { nseJson } from "./india";
import type { Bar, FinField, FinRow, Fundamentals, Market, PriceHistory, Sourced } from "../../src/lib/quant/types";
import type { EarningsQuarter, EpsTrend, Headline, InsiderInput, RatingChange, ShortInterestInput } from "../../src/lib/quant/sentiment";
import { parseOccSymbol, type OptionQuote } from "../../src/lib/quant/stochastic";
import type { FactorRow, FactorSeries, MacroInput } from "../../src/lib/quant/factors";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const BROWSER: Record<string, string> = { "User-Agent": "Mozilla/5.0" };

const log = (m: string) => console.warn(`[market-data] ${m}`);
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / DAY_MS;

// ── Vendor JSON accessors ───────────────────────────────────────────────────

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
/** Yahoo numbers arrive bare or wrapped as { raw, fmt }. */
const num = (v: unknown): number | null => {
  const x = typeof v === "number" ? v : obj(v)?.raw;
  return typeof x === "number" && Number.isFinite(x) ? x : null;
};
/** NSE sends numbers as strings, sometimes with thousands separators. */
const numLoose = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string" || !v.trim()) return null;
  const x = Number(v.replace(/,/g, ""));
  return Number.isFinite(x) ? x : null;
};
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const epochDay = (seconds: number | null): string | null => (seconds == null ? null : isoDay(seconds * 1000));

// ── Request limiter and fetch helper ────────────────────────────────────────

const MAX_CONCURRENT = Math.max(1, Number(process.env.MERIDIAN_MD_CONCURRENCY) || 4);
let active = 0;
const waiting: (() => void)[] = [];

/** At most MAX_CONCURRENT requests in flight; a finished request hands its slot straight to the next waiter. */
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (active < MAX_CONCURRENT) active++;
  else await new Promise<void>((resolve) => waiting.push(resolve));
  try {
    return await fn();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else active--;
  }
}

type Got<T> = { status: number; headers: Headers | null; body: T | null };
type GetOpts = { headers?: Record<string, string>; timeoutMs?: number; retries?: number; redirect?: RequestRedirect };

const redact = (url: string) => url.replace(/crumb=[^&]*/, "crumb=…");
const backoff = (attempt: number) => 800 * 2 ** attempt + Math.random() * 400;

/**
 * GET with a timeout, retrying network errors, 429s and 5xx with exponential
 * backoff. `body` is null unless the response was 2xx and `read` succeeded;
 * status 0 means no response arrived at all.
 */
async function get<T>(url: string, read: (res: Response) => Promise<T>, opts: GetOpts = {}): Promise<Got<T>> {
  const { headers = BROWSER, timeoutMs = 15_000, retries = 2, redirect } = opts;
  for (let attempt = 0; ; attempt++) {
    let out: Got<T>;
    try {
      out = await slot(async () => {
        const res = await fetch(url, { headers, redirect, signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) {
          await res.body?.cancel().catch(() => undefined);
          return { status: res.status, headers: res.headers, body: null };
        }
        try {
          return { status: res.status, headers: res.headers, body: await read(res) };
        } catch (e) {
          log(`unreadable response from ${redact(url)}: ${errMsg(e)}`);
          return { status: res.status, headers: res.headers, body: null };
        }
      });
    } catch (e) {
      if (attempt < retries) {
        await sleep(backoff(attempt));
        continue;
      }
      log(`GET ${redact(url)} failed: ${errMsg(e)}`);
      return { status: 0, headers: null, body: null };
    }
    if ((out.status === 429 || out.status >= 500) && attempt < retries) {
      await sleep(backoff(attempt));
      continue;
    }
    return out;
  }
}

const json = (res: Response) => res.json() as Promise<unknown>;

// ── Disk + memory cache ─────────────────────────────────────────────────────

const CACHE_DIR = path.resolve(process.env.MERIDIAN_QUANT_CACHE || ".quant-cache");
/** How long a failed load is remembered before the next attempt. */
const MISS_TTL_MS = 10 * 60_000;

const memo = new Map<string, { value: unknown; expires: number }>();
const loading = new Map<string, Promise<unknown>>();
let diskWarned = false;

const safeKey = (s: string) => s.replace(/[^A-Za-z0-9._=-]/g, "_");

function readDisk(file: string): { at: number; value: unknown } | null {
  try {
    const e = JSON.parse(fs.readFileSync(file, "utf8")) as { at?: unknown; value?: unknown };
    return typeof e.at === "number" && e.value != null ? { at: e.at, value: e.value } : null;
  } catch {
    return null;
  }
}

function writeDisk(file: string, value: unknown): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ at: Date.now(), value }));
    fs.renameSync(tmp, file);
  } catch (e) {
    if (!diskWarned) log(`cache write failed (${errMsg(e)}); continuing on the memory cache`);
    diskWarned = true;
  }
}

/**
 * Read-through cache. A fresh copy (memory, then disk) is served as is;
 * otherwise `load` runs once however many callers are waiting on it. When the
 * load fails, a disk copy younger than `staleMs` is served instead (and the
 * fallback logged); a miss is remembered for ten minutes so a sweep doesn't
 * hammer a source that is down.
 */
async function cached<T>(kind: string, key: string, ttlMs: number, staleMs: number, load: () => Promise<T | null>): Promise<T | null> {
  const file = path.join(CACHE_DIR, kind, `${safeKey(key)}.json`);
  const now = Date.now();
  const hit = memo.get(file);
  if (hit && now < hit.expires) return hit.value as T | null;
  const pending = loading.get(file);
  if (pending) return pending as Promise<T | null>;
  const p = (async (): Promise<T | null> => {
    const disk = readDisk(file);
    if (disk && now - disk.at < ttlMs) {
      memo.set(file, { value: disk.value, expires: disk.at + ttlMs });
      return disk.value as T;
    }
    let value: T | null = null;
    try {
      value = await load();
    } catch (e) {
      log(`${kind} ${key}: ${errMsg(e)}`);
    }
    if (value != null) {
      memo.set(file, { value, expires: Date.now() + ttlMs });
      writeDisk(file, value);
      return value;
    }
    if (disk && now - disk.at < staleMs) {
      log(`${kind} ${key}: reload failed; serving the copy from ${new Date(disk.at).toISOString()}`);
      memo.set(file, { value: disk.value, expires: Date.now() + MISS_TTL_MS });
      return disk.value as T;
    }
    memo.set(file, { value: null, expires: Date.now() + MISS_TTL_MS });
    return null;
  })().finally(() => loading.delete(file));
  loading.set(file, p);
  return p;
}

// ── Symbols ─────────────────────────────────────────────────────────────────

/**
 * Desk ticker → Yahoo symbol. NSE names take ".NS"; US class shares use a dash
 * (BRK.B → BRK-B). Indices (^…), FX and futures (…=X, …=F) and symbols that
 * already carry an exchange suffix pass through.
 */
export function ySym(ticker: string, market: Market): string {
  const t = ticker.trim().toUpperCase();
  if (t.startsWith("^") || t.includes("=") || /\.(NS|BO)$/.test(t)) return t;
  return market === "IN" ? `${t}.NS` : t.replace(/\./g, "-");
}

const YAHOO_CHART = "https://query1.finance.yahoo.com/v8/finance/chart/";

// ── Prices ──────────────────────────────────────────────────────────────────

type ChartQuote = { open?: unknown[]; high?: unknown[]; low?: unknown[]; close?: unknown[]; volume?: unknown[] };

/**
 * A Yahoo v8 chart payload as bars, oldest first. Daily bars keep the last bar
 * for each exchange date (Yahoo sometimes appends the live quote as a second
 * bar for today); intraday bars keep the last bar per timestamp.
 */
export function parseChart(payload: unknown, daily = true): { currency: string | null; bars: Bar[] } | null {
  const c = obj(arr(obj(obj(payload)?.chart)?.result)[0]);
  const ts = arr(c?.timestamp);
  if (!c || !ts.length) return null;
  const ind = obj(c.indicators);
  const q = (obj(arr(ind?.quote)[0]) ?? {}) as ChartQuote;
  const adj = arr(obj(arr(ind?.adjclose)[0])?.adjclose);
  const meta = obj(c.meta);
  const offset = num(meta?.gmtoffset) ?? 0;
  const at = (xs: unknown[] | undefined, i: number) => num(xs?.[i]);
  const bars: Bar[] = [];
  for (let i = 0; i < ts.length; i++) {
    const t = num(ts[i]);
    const close = at(q.close, i);
    if (t == null || close == null || close <= 0) continue;
    const a = at(adj, i);
    const bar: Bar = {
      t,
      date: isoDay((t + offset) * 1000),
      open: at(q.open, i) ?? close,
      high: at(q.high, i) ?? close,
      low: at(q.low, i) ?? close,
      close,
      adjClose: a != null && a > 0 ? a : close,
      volume: at(q.volume, i) ?? 0,
    };
    const prev = bars[bars.length - 1];
    if (prev && (daily ? prev.date === bar.date : prev.t === bar.t)) bars[bars.length - 1] = bar;
    else if (!prev || bar.t > prev.t) bars.push(bar);
  }
  return bars.length ? { currency: str(meta?.currency), bars } : null;
}

/** Daily split- and dividend-adjusted history for a Yahoo symbol (see `ySym`). Cached 2 hours. */
export async function fetchHistory(symbol: string, range = "10y"): Promise<PriceHistory | null> {
  return cached("history", `${symbol}_${range}`, 2 * HOUR_MS, DAY_MS, async () => {
    const r = await get(`${YAHOO_CHART}${encodeURIComponent(symbol)}?interval=1d&range=${range}&includeAdjustedClose=true`, json);
    const parsed = r.body == null ? null : parseChart(r.body, true);
    if (!parsed) {
      log(`no daily history for ${symbol} (HTTP ${r.status})`);
      return null;
    }
    return { symbol, currency: parsed.currency, bars: parsed.bars };
  });
}

/** Today's 5-minute bars (for session VWAP). Cached 10 minutes. */
export async function fetchIntraday(symbol: string): Promise<Bar[] | null> {
  return cached("intraday", symbol, 10 * 60_000, 0, async () => {
    const r = await get(`${YAHOO_CHART}${encodeURIComponent(symbol)}?interval=5m&range=1d`, json);
    return (r.body == null ? null : parseChart(r.body, false))?.bars ?? null;
  });
}

/** Spot FX: units of `to` per unit of `from` (USDINR → ~83). */
export async function fetchFxRate(from: string, to: string): Promise<Sourced | null> {
  const a = from.toUpperCase(), b = to.toUpperCase();
  if (a === b) return { value: 1, source: "same currency" };
  const h = await fetchHistory(`${a}${b}=X`, "1mo");
  const last = h?.bars[h.bars.length - 1];
  return last ? { value: last.close, source: `Yahoo ${a}${b}=X close ${last.date}` } : null;
}

// ── Financial statements ────────────────────────────────────────────────────

/**
 * Yahoo statement series → FinField, in order of preference (a later entry for
 * the same field only fills dates the earlier one left empty). `flow` items are
 * also requested as trailing twelve months; `negate` turns a cash outflow into
 * the positive spend types.ts expects.
 */
const FIN: { type: string; field: FinField; flow: boolean; negate?: true }[] = [
  { type: "TotalRevenue", field: "revenue", flow: true },
  { type: "CostOfRevenue", field: "costOfRevenue", flow: true },
  { type: "GrossProfit", field: "grossProfit", flow: true },
  { type: "SellingGeneralAndAdministration", field: "sga", flow: true },
  { type: "ResearchAndDevelopment", field: "rnd", flow: true },
  { type: "OperatingIncome", field: "operatingIncome", flow: true },
  { type: "EBIT", field: "ebit", flow: true },
  { type: "EBITDA", field: "ebitda", flow: true },
  { type: "NormalizedEBITDA", field: "ebitda", flow: true },
  { type: "ReconciledDepreciation", field: "da", flow: true },
  { type: "DepreciationAndAmortization", field: "da", flow: true },
  { type: "InterestExpense", field: "interestExpense", flow: true },
  { type: "InterestIncome", field: "interestIncome", flow: true },
  { type: "NetInterestIncome", field: "netInterestIncome", flow: true },
  { type: "PretaxIncome", field: "pretaxIncome", flow: true },
  { type: "TaxProvision", field: "taxProvision", flow: true },
  { type: "TaxRateForCalcs", field: "taxRate", flow: true },
  { type: "NetIncome", field: "netIncome", flow: true },
  { type: "NetIncomeCommonStockholders", field: "netIncome", flow: true },
  { type: "DilutedEPS", field: "dilutedEps", flow: true },
  { type: "DilutedAverageShares", field: "dilutedShares", flow: true },
  { type: "OrdinarySharesNumber", field: "sharesOutstanding", flow: false },
  { type: "ShareIssued", field: "sharesOutstanding", flow: false },
  { type: "TotalAssets", field: "totalAssets", flow: false },
  { type: "CurrentAssets", field: "currentAssets", flow: false },
  { type: "CurrentLiabilities", field: "currentLiabilities", flow: false },
  { type: "Inventory", field: "inventory", flow: false },
  { type: "AccountsReceivable", field: "receivables", flow: false },
  { type: "Receivables", field: "receivables", flow: false },
  { type: "AccountsPayable", field: "payables", flow: false },
  { type: "Payables", field: "payables", flow: false },
  { type: "CashAndCashEquivalents", field: "cash", flow: false },
  { type: "CashCashEquivalentsAndShortTermInvestments", field: "cashAndSti", flow: false },
  { type: "TotalDebt", field: "totalDebt", flow: false },
  { type: "LongTermDebt", field: "longTermDebt", flow: false },
  { type: "TotalLiabilitiesNetMinorityInterest", field: "totalLiabilities", flow: false },
  { type: "StockholdersEquity", field: "equity", flow: false },
  { type: "CommonStockEquity", field: "equity", flow: false },
  { type: "RetainedEarnings", field: "retainedEarnings", flow: false },
  { type: "NetPPE", field: "netPpe", flow: false },
  { type: "WorkingCapital", field: "workingCapital", flow: false },
  { type: "InvestedCapital", field: "investedCapital", flow: false },
  { type: "TangibleBookValue", field: "tangibleBook", flow: false },
  { type: "OperatingCashFlow", field: "cfo", flow: true },
  { type: "CapitalExpenditure", field: "capex", flow: true, negate: true },
  { type: "FreeCashFlow", field: "fcf", flow: true },
  { type: "CashDividendsPaid", field: "dividendsPaid", flow: true, negate: true },
  { type: "CommonStockDividendPaid", field: "dividendsPaid", flow: true, negate: true },
  { type: "RepurchaseOfCapitalStock", field: "buybacks", flow: true, negate: true },
  { type: "ChangeInWorkingCapital", field: "changeInWc", flow: true },
];

const FIN_TYPES = FIN.flatMap((s) => [`annual${s.type}`, `quarterly${s.type}`, ...(s.flow ? [`trailing${s.type}`] : [])]);
/** A statement row with fewer line items than this is a vendor stub, not a filing. */
const MIN_ROW_FIELDS = 5;

/** Yahoo fundamentals-timeseries results → normalized statements (null with no usable annual rows). */
export function parseTimeseries(results: readonly unknown[]): Fundamentals | null {
  const rank = new Map(FIN.map((s, i) => [s.type, i]));
  const periods = { annual: new Map<string, FinRow>(), quarterly: new Map<string, FinRow>(), trailing: new Map<string, FinRow>() };
  const best = new Map<string, number>();
  const currencies = new Map<string, number>();
  for (const r of results) {
    const o = obj(r);
    const type = str(arr(obj(o?.meta)?.type)[0]);
    const m = type ? /^(annual|quarterly|trailing)(.+)$/.exec(type) : null;
    const i = m ? rank.get(m[2]) : undefined;
    if (!o || !type || !m || i == null) continue;
    const spec = FIN[i];
    const period = m[1] as keyof typeof periods;
    for (const it of arr(o[type])) {
      const item = obj(it);
      const date = str(item?.asOfDate);
      const v = num(item?.reportedValue);
      if (!item || !date || v == null) continue;
      if (spec.field === "revenue") {
        const ccy = str(item.currencyCode);
        if (ccy) currencies.set(ccy, (currencies.get(ccy) ?? 0) + 1);
      }
      const k = `${period}|${date}|${spec.field}`;
      const held = best.get(k);
      if (held != null && held <= i) continue;
      best.set(k, i);
      const row = periods[period].get(date) ?? { asOf: date };
      row[spec.field] = spec.negate ? (v === 0 ? 0 : -v) : v;
      periods[period].set(date, row);
    }
  }
  const rows = (m: Map<string, FinRow>) =>
    [...m.values()].filter((r) => Object.keys(r).length - 1 >= MIN_ROW_FIELDS).sort((a, b) => a.asOf.localeCompare(b.asOf));
  const annual = rows(periods.annual);
  if (!annual.length) return null;
  const quarterly = rows(periods.quarterly);
  // TTM: the trailing values at the newest date, unless the last annual filing is newer.
  const trailingDates = [...periods.trailing.keys()].sort();
  const newest = trailingDates[trailingDates.length - 1];
  const ttmRow = newest ? periods.trailing.get(newest) ?? null : null;
  const ttm = ttmRow && ttmRow.asOf >= annual[annual.length - 1].asOf ? ttmRow : null;
  const currency = [...currencies.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return { currency, annual, quarterly, ttm };
}

/** Annual, quarterly and TTM statements since 2017. Cached a day; a failed reload serves a copy up to 3 days old. */
export async function fetchFundamentals(symbol: string): Promise<Fundamentals | null> {
  return cached("fundamentals", symbol, DAY_MS, 3 * DAY_MS, async () => {
    const sym = encodeURIComponent(symbol);
    const period2 = Math.floor(Date.now() / 1000) + 86_400;
    const chunks: string[][] = [];
    for (let i = 0; i < FIN_TYPES.length; i += 40) chunks.push(FIN_TYPES.slice(i, i + 40));
    const parts = await Promise.all(
      chunks.map(async (types) => {
        const url = `https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${sym}?symbol=${sym}&type=${types.join(",")}&period1=1500000000&period2=${period2}`;
        const r = await get(url, json);
        return r.body == null ? null : arr(obj(obj(r.body)?.timeseries)?.result);
      }),
    );
    // All or nothing: a statement set with a missing chunk would silently drop line items.
    if (parts.some((p) => p == null)) {
      log(`fundamentals for ${symbol}: a request failed`);
      return null;
    }
    const f = parseTimeseries(parts.flat());
    if (!f) log(`fundamentals for ${symbol}: no annual statements`);
    return f;
  });
}

// ── Yahoo quoteSummary (profile, analysts, estimates, insiders) ─────────────

type YahooSession = { cookie: string; crumb: string; at: number };
let yahooSession: YahooSession | null = null;
let yahooPending: Promise<YahooSession | null> | null = null;
let yahooDownUntil = 0;

const setCookies = (h: Headers | null): string[] =>
  h ? ((h as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? (h.get("set-cookie") ? [h.get("set-cookie") as string] : [])) : [];

/** quoteSummary wants a consent cookie plus the crumb minted for it. Cached 30 minutes; a failure backs off 5. */
function yahooAuth(refresh = false): Promise<YahooSession | null> {
  if (!refresh && yahooSession && Date.now() - yahooSession.at < 30 * 60_000) return Promise.resolve(yahooSession);
  if (yahooPending) return yahooPending;
  if (Date.now() < yahooDownUntil) return Promise.resolve(null);
  yahooPending = (async () => {
    const first = await get("https://fc.yahoo.com/", async (res) => void (await res.body?.cancel()), { redirect: "manual", retries: 1 });
    const cookie = setCookies(first.headers).map((c) => c.split(";")[0]).filter(Boolean).join("; ");
    if (!cookie) {
      log(`Yahoo handshake returned no cookie (HTTP ${first.status})`);
      yahooDownUntil = Date.now() + 5 * 60_000;
      return null;
    }
    const r = await get("https://query1.finance.yahoo.com/v1/test/getcrumb", (res) => res.text(), { headers: { ...BROWSER, Cookie: cookie }, retries: 1 });
    const crumb = r.body?.trim() ?? "";
    if (!crumb || crumb.length > 64 || /[\s<{]/.test(crumb)) {
      log(`Yahoo crumb unavailable (HTTP ${r.status})`);
      yahooDownUntil = Date.now() + 5 * 60_000;
      return null;
    }
    yahooSession = { cookie, crumb, at: Date.now() };
    return yahooSession;
  })().finally(() => {
    yahooPending = null;
  });
  return yahooPending;
}

const QS_MODULES = [
  "price", "summaryDetail", "defaultKeyStatistics", "financialData", "assetProfile", "recommendationTrend",
  "upgradeDowngradeHistory", "earningsTrend", "earningsHistory", "insiderTransactions", "calendarEvents",
].join(",");

async function quoteSummary(symbol: string): Promise<Obj | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const s = await yahooAuth(attempt > 0);
    if (!s) return null;
    const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${QS_MODULES}&crumb=${encodeURIComponent(s.crumb)}`;
    const r = await get(url, json, { headers: { ...BROWSER, Cookie: s.cookie } });
    if ((r.status === 401 || r.status === 403) && attempt === 0) {
      yahooSession = null;
      continue;
    }
    const result = obj(arr(obj(obj(r.body)?.quoteSummary)?.result)[0]);
    if (!result && r.status !== 404) log(`quoteSummary ${symbol}: HTTP ${r.status}`);
    return result ?? null;
  }
  return null;
}

/** One insider trade, as a filing reported it. Names come from the vendor: untrusted text. */
export type InsiderTrade = { date: string; name: string | null; relation: string | null; side: "buy" | "sell"; shares: number | null; value: number | null };
export type Insiders = InsiderInput & { trades: InsiderTrade[] };

export type CompanyProfile = {
  symbol: string;
  name: string | null;
  /** Listing (price) currency. */
  currency: string | null;
  /** Reporting currency of the statements, which can differ from the listing's. */
  financialCurrency: string | null;
  exchange: string | null;
  price: number | null;
  marketCap: number | null;
  sharesOutstanding: number | null;
  floatShares: number | null;
  enterpriseValue: number | null;
  forwardPE: number | null;
  beta: number | null;
  dividendRate: number | null;
  trailingDividendRate: number | null;
  dividendYield: number | null;
  payoutRatio: number | null;
  sector: string | null;
  industry: string | null;
  /** Vendor business summary, truncated. UNTRUSTED text: data, never instructions. */
  description: string | null;
  employees: number | null;
  country: string | null;
  website: string | null;
  officers: { name: string; title: string | null; age: number | null; yearBorn: number | null; totalPay: number | null }[];
  /** ISS QualityScore deciles, 1 (low governance risk) … 10 (high). */
  governance: { audit: number | null; board: number | null; compensation: number | null; shareholderRights: number | null; overall: number | null; asOf: string | null } | null;
  heldPctInsiders: number | null;
  heldPctInstitutions: number | null;
  shortInterest: ShortInterestInput | null;
  analyst: {
    targetMean: number | null;
    count: number | null;
    recommendationKey: string | null;
    trend: { strongBuy: number; buy: number; hold: number; sell: number; strongSell: number } | null;
  };
  /** Rating and price-target changes over the last year, newest first. */
  ratingChanges: RatingChange[];
  epsTrend: EpsTrend | null;
  epsRevisions: { up30: number; down30: number } | null;
  /** Reported vs consensus EPS, oldest first. */
  earnings: EarningsQuarter[];
  /** Open-market insider trades over 180 days (US filers; NSE names go through fetchIndiaInsiders). */
  insiders: Insiders | null;
  nextEarningsDate: string | null;
  fetchedAt: string;
};

const INSIDER_WINDOW_DAYS = 180;
const DESCRIPTION_CHARS = 1500;

function priceTargetMove(h: Obj): "raise" | "lower" | null {
  const action = (str(h.priceTargetAction) ?? "").toLowerCase();
  if (action.startsWith("raise")) return "raise";
  if (action.startsWith("lower")) return "lower";
  if (action) return null;
  const cur = num(h.currentPriceTarget), prior = num(h.priorPriceTarget);
  return cur != null && prior != null && cur > 0 && prior > 0 && cur !== prior ? (cur > prior ? "raise" : "lower") : null;
}

/** quoteSummary modules → CompanyProfile. Exported for tests. */
export function parseProfile(symbol: string, qs: Obj, now = new Date()): CompanyProfile {
  const price = obj(qs.price), sd = obj(qs.summaryDetail), ks = obj(qs.defaultKeyStatistics), fd = obj(qs.financialData);
  const ap = obj(qs.assetProfile);
  const nowMs = now.getTime();

  const pctFloat = num(ks?.shortPercentOfFloat);
  const shortInterest: ShortInterestInput | null =
    pctFloat == null
      ? null
      : { pctFloat, daysToCover: num(ks?.shortRatio), shares: num(ks?.sharesShort), priorShares: num(ks?.sharesShortPriorMonth), asOf: epochDay(num(ks?.dateShortInterest)) };

  const ratingChanges: RatingChange[] = arr(obj(qs.upgradeDowngradeHistory)?.history)
    .flatMap((x) => {
      const h = obj(x);
      const t = num(h?.epochGradeDate);
      if (!h || t == null || nowMs - t * 1000 > 365 * DAY_MS) return [];
      return [{
        date: isoDay(t * 1000),
        firm: str(h.firm) ?? "unknown",
        action: (str(h.action) ?? "").toLowerCase(),
        from: str(h.fromGrade) ?? undefined,
        to: str(h.toGrade) ?? undefined,
        priceTarget: priceTargetMove(h),
      }];
    })
    .sort((a, b) => b.date.localeCompare(a.date));

  const trends = arr(obj(qs.earningsTrend)?.trend).map(obj);
  const year = trends.find((t) => t?.period === "0y") ?? trends.find((t) => t?.period === "+1y");
  const et = obj(year?.epsTrend), rv = obj(year?.epsRevisions);
  const epsCurrent = num(et?.current);
  const epsTrend: EpsTrend | null = epsCurrent == null ? null : { current: epsCurrent, d30: num(et?.["30daysAgo"]) ?? undefined, d90: num(et?.["90daysAgo"]) ?? undefined };
  const up30 = num(rv?.upLast30days), down30 = num(rv?.downLast30days);

  const earnings: EarningsQuarter[] = arr(obj(qs.earningsHistory)?.history)
    .flatMap((x) => {
      const h = obj(x);
      const actual = num(h?.epsActual), estimate = num(h?.epsEstimate);
      const date = str(obj(h?.quarter)?.fmt) ?? epochDay(num(h?.quarter));
      return actual != null && estimate != null && date ? [{ date, actual, estimate }] : [];
    })
    .sort((a, b) => a.date.localeCompare(b.date));

  // Open-market trades only: grants, option exercises and gifts say nothing about conviction.
  const txModule = obj(qs.insiderTransactions);
  let insiders: Insiders | null = null;
  if (txModule) {
    const trades: InsiderTrade[] = [];
    for (const x of arr(txModule.transactions)) {
      const t = obj(x);
      const when = num(t?.startDate);
      const what = str(t?.transactionText) ?? "";
      if (!t || when == null || nowMs - when * 1000 > INSIDER_WINDOW_DAYS * DAY_MS) continue;
      const side = /^Purchase at price/i.test(what) ? "buy" : /^Sale at price/i.test(what) ? "sell" : null;
      if (!side) continue;
      trades.push({ date: isoDay(when * 1000), name: str(t.filerName), relation: str(t.filerRelation), side, shares: num(t.shares), value: num(t.value) });
    }
    trades.sort((a, b) => b.date.localeCompare(a.date));
    const buys = trades.filter((t) => t.side === "buy"), sells = trades.filter((t) => t.side === "sell");
    const netShares = buys.reduce((a, t) => a + (t.shares ?? 0), 0) - sells.reduce((a, t) => a + (t.shares ?? 0), 0);
    insiders = { buys: buys.length, sells: sells.length, netShares, period: `${INSIDER_WINDOW_DAYS}d`, source: "Yahoo insiderTransactions (open-market only)", trades: trades.slice(0, 15) };
  }

  const rec = obj(arr(obj(qs.recommendationTrend)?.trend)[0]);
  const count = (k: string) => num(rec?.[k]) ?? 0;
  const gov = [num(ap?.auditRisk), num(ap?.boardRisk), num(ap?.compensationRisk), num(ap?.shareHolderRightsRisk), num(ap?.overallRisk)];
  const description = str(ap?.longBusinessSummary);

  return {
    symbol,
    name: str(price?.longName) ?? str(price?.shortName),
    currency: str(price?.currency),
    financialCurrency: str(fd?.financialCurrency),
    exchange: str(price?.exchangeName),
    price: num(price?.regularMarketPrice) ?? num(fd?.currentPrice),
    marketCap: num(price?.marketCap) ?? num(sd?.marketCap),
    sharesOutstanding: num(ks?.sharesOutstanding),
    floatShares: num(ks?.floatShares),
    enterpriseValue: num(ks?.enterpriseValue),
    forwardPE: num(ks?.forwardPE) ?? num(sd?.forwardPE),
    beta: num(sd?.beta) ?? num(ks?.beta),
    dividendRate: num(sd?.dividendRate),
    trailingDividendRate: num(sd?.trailingAnnualDividendRate),
    dividendYield: num(sd?.dividendYield),
    payoutRatio: num(sd?.payoutRatio),
    sector: str(ap?.sector),
    industry: str(ap?.industry),
    description: description ? description.slice(0, DESCRIPTION_CHARS) : null,
    employees: num(ap?.fullTimeEmployees),
    country: str(ap?.country),
    website: str(ap?.website),
    officers: arr(ap?.companyOfficers)
      .map(obj)
      .flatMap((o) => {
        const name = str(o?.name);
        return o && name ? [{ name, title: str(o.title), age: num(o.age), yearBorn: num(o.yearBorn), totalPay: num(o.totalPay) }] : [];
      })
      .slice(0, 8),
    governance: gov.some((g) => g != null)
      ? { audit: gov[0], board: gov[1], compensation: gov[2], shareholderRights: gov[3], overall: gov[4], asOf: epochDay(num(ap?.governanceEpochDate)) }
      : null,
    heldPctInsiders: num(ks?.heldPercentInsiders),
    heldPctInstitutions: num(ks?.heldPercentInstitutions),
    shortInterest,
    analyst: {
      targetMean: num(fd?.targetMeanPrice),
      count: num(fd?.numberOfAnalystOpinions),
      recommendationKey: str(fd?.recommendationKey),
      trend: rec ? { strongBuy: count("strongBuy"), buy: count("buy"), hold: count("hold"), sell: count("sell"), strongSell: count("strongSell") } : null,
    },
    ratingChanges,
    epsTrend,
    epsRevisions: up30 != null && down30 != null ? { up30, down30 } : null,
    earnings,
    insiders,
    nextEarningsDate: epochDay(num(arr(obj(obj(qs.calendarEvents)?.earnings)?.earningsDate)[0])),
    fetchedAt: now.toISOString(),
  };
}

/** Company profile, analyst estimates, insiders and short interest. Cached 12 hours; stale copies up to 3 days. */
export async function fetchProfile(symbol: string): Promise<CompanyProfile | null> {
  return cached("profile", symbol, 12 * HOUR_MS, 3 * DAY_MS, async () => {
    const qs = await quoteSummary(symbol);
    return qs ? parseProfile(symbol, qs) : null;
  });
}

// ── News ────────────────────────────────────────────────────────────────────

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] !== "#") return ENTITIES[e.toLowerCase()] ?? m;
      const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : m;
    })
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** RSS 2.0 items (Google News): title without its " - Publisher" suffix, publisher, publish time. */
export function parseRss(xml: string): Headline[] {
  const out: Headline[] = [];
  const tag = (block: string, name: string) => {
    const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(block);
    return m ? decodeXml(m[1]) : null;
  };
  for (const m of xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)) {
    const block = m[1];
    let title = tag(block, "title");
    const when = Date.parse(tag(block, "pubDate") ?? "");
    const publisher = tag(block, "source") ?? undefined;
    if (!title || !Number.isFinite(when)) continue;
    if (publisher && title.endsWith(` - ${publisher}`)) title = title.slice(0, -(publisher.length + 3)).trim();
    out.push({ title, publishedAt: new Date(when).toISOString(), publisher });
  }
  return out;
}

/** "Apple Inc." → "Apple", "JPMorgan Chase & Co." → "JPMorgan Chase", "Reliance Industries Limited" → "Reliance Industries". */
export function shortCompanyName(name: string): string {
  let s = name.trim().replace(/^the\s+/i, "");
  const suffix = /(?:[,\s]+(?:inc\.?|incorporated|corporation|corp\.?|company|co\.?|ltd\.?|limited|plc|n\.v\.|s\.a\.|ag|se|holdings?)|\s*&)$/i;
  while (suffix.test(s)) s = s.replace(suffix, "").trim();
  return s || name.trim();
}

const normTitle = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 90);

// Machine-written 13F holdings notices ("Apple Inc. $AAPL Shares Acquired by X
// LLC", "X Sells 47,638 Shares of HDFC Bank $HDB"): a fund's filing, not news
// about the company. Each carries a cashtag or a share count, which keeps real
// stake news ("Reliance acquires stake in …") out of the net.
const HOLDINGS_VERB = [
  /\b(shares|stock|stake|position|holdings)\b.{0,40}\b(acquired|purchased|sold|bought|raised|lowered|cut|trimmed|boosted|increased|decreased|reduced|grown|lessened)\s+by\b/i,
  /\b(acquires|buys|sells|purchases|takes|makes|invests|initiates|opens|establishes|has)\b.{0,50}\b(stake|position|holdings|shares)\s+(of|in)\b/i,
  /\b(raises|lowers|cuts|trims|boosts|increases|decreases|reduces|grows|lessens|lifts)\s+(its\s+|their\s+)?(stake|position|holdings)\b/i,
];
const HOLDINGS_MARK = [/\$[A-Z]{1,6}\b/, /\b\d[\d,]*\s+shares\b/i];
// Quote, chart, forecast and token pages that search engines index as news; UK holding notices.
const PAGE_NOISE =
  /interactive (stock|price) chart|price history and historical data|stock price, news, quote and history|share price today (&|and) chart|quotes,? (&|and) charts|(stock|share) price prediction|stock forecast (&|and) analyst predictions|tokenized stock|holding\(s\) in company/i;
// The company as a broker opining on someone else's stock ("JPMorgan Issues Forecast for Mondelez (NASDAQ:MDLZ)").
const BROKER_TALK = /\b(rating|price target|upgrades?|upgraded|downgrades?|downgraded|reiterated|forecast|expectations|coverage|covered by|analysts? says?|overweight|underweight|outperform)\b/i;
const EXCHANGE_TAG = /\((?:NYSE|NASDAQ|NYSEARCA|NYSEAMERICAN|AMEX|OTC|NSE|BSE):\s*([A-Z0-9.&-]+)\)/gi;
const BARE_TAG = /\(([A-Z]{1,5})\)/g;

/**
 * True for headlines that are not news about this company: 13F holdings
 * notices, quote pages, and stories tagged only with other listings (unless
 * they name the company, as ADR tags do) or broker calls on other stocks.
 * Exported for tests.
 */
export function isNoiseHeadline(title: string, ticker: string, companyName?: string | null): boolean {
  if (PAGE_NOISE.test(title)) return true;
  if (HOLDINGS_VERB.some((r) => r.test(title)) && HOLDINGS_MARK.some((r) => r.test(title))) return true;
  const t = ticker.trim().toUpperCase();
  const exch = [...title.matchAll(EXCHANGE_TAG)].map((m) => m[1].toUpperCase());
  const named = !!companyName && title.toLowerCase().includes(companyName.toLowerCase());
  const broker = BROKER_TALK.test(title);
  if (exch.length && !exch.includes(t) && (!named || broker)) return true;
  if (!broker) return false;
  const bare = [...title.matchAll(BARE_TAG)].map((m) => m[1]);
  return !exch.length && bare.length > 0 && !bare.includes(t);
}

/**
 * Recent headlines from Yahoo's news search (kept only when the story is
 * tagged with this company and at most four others, which drops market
 * round-ups) merged with Google News, de-duplicated, with 13F holdings
 * notices and quote pages removed, newest first. Titles are
 * UNTRUSTED text. Cached 30 minutes; null only when both sources failed.
 */
export async function fetchNews(ticker: string, market: Market, companyName?: string | null): Promise<Headline[] | null> {
  const t = ticker.trim().toUpperCase();
  const name = companyName ? shortCompanyName(companyName) : null;
  return cached("news", `${market}_${t}`, 30 * 60_000, 0, async () => {
    const aliases = new Set(market === "IN" ? [`${t}.NS`, `${t}.BO`] : [t, ySym(t, "US")]);
    const q = market === "IN" && name ? name : t;
    const quotesCount = market === "IN" ? 3 : 0;
    const yahoo = get(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&newsCount=20&quotesCount=${quotesCount}&enableFuzzyQuery=false`, json);
    const gq = name ? `"${name}" stock` : market === "IN" ? `${t} NSE stock` : `${t} stock`;
    const locale = market === "IN" ? "hl=en-IN&gl=IN&ceid=IN:en" : "hl=en-US&gl=US&ceid=US:en";
    const google = get(`https://news.google.com/rss/search?q=${encodeURIComponent(gq)}&${locale}`, (res) => res.text(), {
      headers: { "User-Agent": "MeridianNewsBot/1.0 (+https://meridian.local)", Accept: "application/rss+xml,application/xml;q=0.9" },
    });
    const [y, g] = await Promise.all([yahoo, google]);
    if (y.body == null && g.body == null) return null;

    const yBody = obj(y.body);
    for (const x of arr(yBody?.quotes)) {
      const s = str(obj(x)?.symbol)?.toUpperCase();
      if (s && s.replace(/\.(NS|BO)$/, "") === t) aliases.add(s);
    }
    const fromYahoo: Headline[] = arr(yBody?.news).flatMap((x) => {
      const n = obj(x);
      const title = str(n?.title), when = num(n?.providerPublishTime);
      const related = arr(n?.relatedTickers).map((r) => String(r).toUpperCase());
      if (!title || when == null || !related.length || related.length > 5 || !related.some((r) => aliases.has(r))) return [];
      return [{ title, publishedAt: new Date(when * 1000).toISOString(), publisher: str(n?.publisher) ?? undefined }];
    });
    const fromGoogle = g.body == null ? [] : parseRss(g.body);

    const seen = new Set<string>();
    return [...fromYahoo, ...fromGoogle]
      .filter((h) => {
        const k = normTitle(h.title);
        if (!k || seen.has(k) || isNoiseHeadline(h.title, t, name)) return false;
        seen.add(k);
        return true;
      })
      .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
      .slice(0, 40);
  });
}

// ── NSE insider (PIT) disclosures ───────────────────────────────────────────

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** NSE's "27-Mar-2026" (optionally followed by a time) → "2026-03-27". */
export function parseDmy(s: unknown): string | null {
  const m = /^\s*(\d{1,2})-([A-Za-z]{3})-(\d{4})/.exec(typeof s === "string" ? s : "");
  if (!m) return null;
  const month = MONTHS.indexOf(m[2].toLowerCase()), day = Number(m[1]);
  if (month < 0 || day < 1 || day > 31) return null;
  return `${m[3]}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** NSE PIT rows → open-market buys and sells over the window. Exported for tests. */
export function parseNsePit(rows: readonly unknown[], now = new Date(), windowDays = INSIDER_WINDOW_DAYS): Insiders {
  const today = isoDay(now.getTime());
  const trades: InsiderTrade[] = [];
  for (const x of rows) {
    const r = obj(x);
    const mode = str(r?.acqMode) ?? "";
    if (!r || !/^market/i.test(mode)) continue;
    const date = parseDmy(r.acqfromDt) ?? parseDmy(r.intimDt);
    if (!date || date > today || daysBetween(date, today) > windowDays) continue;
    const tt = (str(r.tdpTransactionType) ?? "").toLowerCase();
    const side = tt === "buy" ? "buy" : tt === "sell" ? "sell" : /purchase/i.test(mode) ? "buy" : /sale/i.test(mode) ? "sell" : null;
    if (!side) continue;
    trades.push({ date, name: str(r.acqName), relation: str(r.personCategory), side, shares: numLoose(r.secAcq), value: numLoose(r.secVal) });
  }
  trades.sort((a, b) => b.date.localeCompare(a.date));
  const buys = trades.filter((t) => t.side === "buy"), sells = trades.filter((t) => t.side === "sell");
  return {
    buys: buys.length,
    sells: sells.length,
    netShares: buys.reduce((a, t) => a + (t.shares ?? 0), 0) - sells.reduce((a, t) => a + (t.shares ?? 0), 0),
    period: `${windowDays}d`,
    source: "NSE PIT (open-market only)",
    trades: trades.slice(0, 15),
  };
}

const PIT_REFERER = "/companies-listing/corporate-filings-insider-trading";
const pad2 = (n: number) => String(n).padStart(2, "0");
/** NSE's query dates are DD-MM-YYYY. */
const nseDate = (ms: number) => {
  const d = new Date(ms);
  return `${pad2(d.getUTCDate())}-${pad2(d.getUTCMonth() + 1)}-${d.getUTCFullYear()}`;
};
const pitRows = (body: unknown) => (Array.isArray(body) ? body : arr(obj(body)?.data));
let pitQuietLogged = false;

/**
 * Market-wide PIT disclosures over the last week. NSE's feed has gone quiet
 * for months at a time; a symbol's empty window then means "no data", not "no
 * insider trades", and must not score as neutral. Cached 12 hours.
 */
async function pitFeedLive(): Promise<boolean> {
  const health = await cached("nse-pit", "_feed-health", 12 * HOUR_MS, 0, async () => {
    const now = Date.now();
    try {
      const body = await nseJson<unknown>(`/api/corporates-pit?index=equities&from_date=${nseDate(now - 7 * DAY_MS)}&to_date=${nseDate(now)}`, PIT_REFERER);
      return { rows: pitRows(body).length };
    } catch (e) {
      log(`NSE PIT feed check: ${errMsg(e)}`);
      return null;
    }
  });
  return (health?.rows ?? 0) > 0;
}

/**
 * Open-market insider trades for an NSE symbol over 180 days. Null when NSE
 * is unreachable or its feed has published nothing market-wide for a week.
 * Cached 12 hours.
 */
export async function fetchIndiaInsiders(ticker: string): Promise<Insiders | null> {
  const symbol = ticker.trim().toUpperCase();
  if (!(await pitFeedLive())) {
    if (!pitQuietLogged) log("NSE PIT feed has published no disclosures in 7 days; India insider data unavailable");
    pitQuietLogged = true;
    return null;
  }
  return cached("nse-pit", symbol, 12 * HOUR_MS, DAY_MS, async () => {
    const now = Date.now();
    try {
      const body = await nseJson<unknown>(
        `/api/corporates-pit?index=equities&symbol=${encodeURIComponent(symbol)}&from_date=${nseDate(now - INSIDER_WINDOW_DAYS * DAY_MS)}&to_date=${nseDate(now)}`,
        PIT_REFERER,
      );
      return parseNsePit(pitRows(body), new Date(now));
    } catch (e) {
      log(`NSE PIT ${symbol}: ${errMsg(e)}`);
      return null;
    }
  });
}

// ── Option chains (CBOE delayed quotes) ─────────────────────────────────────

export type OptionChain = { spot: number; asOf: string; iv30: number | null; quotes: OptionQuote[]; source: string };

/** "2026-10-16T15:59:59" read as New York wall-clock time → epoch ms (NaN if malformed). */
export function nyTimeMs(s: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s);
  if (!m) return NaN;
  const asUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  // New York's offset at an instant: what its clock reads minus UTC.
  const offset = (ms: number) => {
    const parts = NY_CLOCK.formatToParts(new Date(ms));
    const g = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second")) - ms;
  };
  // Second pass: the offset at the first guess, which is right across a DST switch.
  return asUtc - offset(asUtc - offset(asUtc));
}
const NY_CLOCK = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", hourCycle: "h23",
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
});

/**
 * CBOE delayed-quotes payload → quotes within 0.5–1.5× spot expiring after the as-of day and within two years.
 * The as-of is the underlying's last trade (New York time), else the file's
 * UTC timestamp, never later than now. CBOE's iv30 is in percent; per-option
 * iv is a decimal.
 */
export function parseCboeChain(payload: unknown, now = new Date()): OptionChain | null {
  const root = obj(payload), d = obj(root?.data);
  const spot = num(d?.current_price) ?? num(d?.close);
  if (!d || spot == null || spot <= 0) return null;
  const lastTrade = nyTimeMs(str(d.last_trade_time) ?? "");
  const fileStamp = Date.parse(`${(str(root?.timestamp) ?? "").replace(" ", "T")}Z`);
  const stamp = Number.isFinite(lastTrade) ? lastTrade : fileStamp;
  const asOf = Number.isFinite(stamp) && stamp <= now.getTime() ? new Date(stamp) : now;
  const today = isoDay(asOf.getTime()), horizon = isoDay(asOf.getTime() + 730 * DAY_MS);
  const quotes: OptionQuote[] = [];
  for (const x of arr(d.options)) {
    const o = obj(x);
    const occ = o ? parseOccSymbol(String(o.option ?? "")) : null;
    // Same-day expiries carry no time value to read a volatility from.
    if (!o || !occ || occ.expiry <= today || occ.expiry > horizon || occ.strike < 0.5 * spot || occ.strike > 1.5 * spot) continue;
    const bid = num(o.bid) ?? 0, ask = num(o.ask) ?? 0, iv = num(o.iv);
    if (bid <= 0 && ask <= 0 && !(iv != null && iv > 0)) continue;
    quotes.push({
      expiry: occ.expiry, type: occ.type, strike: occ.strike, bid, ask,
      iv: iv != null && iv > 0 ? iv : null,
      delta: num(o.delta), openInterest: num(o.open_interest), volume: num(o.volume),
    });
  }
  const iv30 = num(d.iv30);
  return { spot, asOf: asOf.toISOString(), iv30: iv30 != null && iv30 > 0 ? iv30 / 100 : null, quotes, source: "CBOE delayed quotes" };
}

/** US listings only: NSE publishes no single-stock chains here (India uses India VIX as a proxy). Cached 30 minutes. */
export async function fetchOptionChain(ticker: string, market: Market): Promise<OptionChain | null> {
  if (market !== "US") return null;
  const symbol = ticker.trim().toUpperCase();
  return cached("options", symbol, 30 * 60_000, 0, async () => {
    const r = await get(`https://cdn-api.cboe.com/api/global/delayed_quotes/options/${encodeURIComponent(symbol)}.json`, json, { timeoutMs: 25_000 });
    const chain = r.body == null ? null : parseCboeChain(r.body);
    if (!chain?.quotes.length) {
      if (r.status !== 403 && r.status !== 404) log(`no option chain for ${symbol} (HTTP ${r.status})`);
      return null;
    }
    return chain;
  });
}

// ── Factor returns ──────────────────────────────────────────────────────────

/** Daily factor returns and where they came from. India's are index/ETF spreads, flagged `proxy`. */
export type FactorData = { series: FactorSeries; through: string | null; source: string; proxy: boolean };

const FRENCH = "https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/ftp/";
const FACTOR_SINCE = "2012-01-01";

/** The first file in a zip archive, inflated and decoded as Latin-1. Null on anything unexpected. */
export function unzipFirst(buf: Buffer): string | null {
  if (buf.length < 22) return null;
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const cd = buf.readUInt32LE(eocd + 16);
  if (cd + 46 > buf.length || buf.readUInt32LE(cd) !== 0x02014b50) return null;
  const method = buf.readUInt16LE(cd + 10), compSize = buf.readUInt32LE(cd + 20), local = buf.readUInt32LE(cd + 42);
  if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) return null;
  const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
  if (start + compSize > buf.length) return null;
  const data = buf.subarray(start, start + compSize);
  try {
    if (method === 0) return data.toString("latin1");
    return method === 8 ? inflateRawSync(data).toString("latin1") : null;
  } catch {
    return null;
  }
}

const FRENCH_NAMES: Record<string, string> = { "MKT-RF": "MKT", MOM: "MOM" };

/** Ken French daily CSV → date → factor returns as decimals (percent ÷ 100; −99.99 / −999 are missing). */
export function parseFrenchCsv(text: string, since = FACTOR_SINCE): Map<string, FactorRow> {
  const out = new Map<string, FactorRow>();
  let header: string[] | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (!header) {
      if (/^\s*,/.test(line)) header = line.split(",").map((h) => {
        const k = h.trim().toUpperCase();
        return FRENCH_NAMES[k] ?? k;
      });
      continue;
    }
    const m = /^\s*(\d{4})(\d{2})(\d{2})\s*,/.exec(line);
    if (!m) {
      if (out.size && /^\s*,/.test(line)) break; // a second table (annual figures) begins
      continue;
    }
    const date = `${m[1]}-${m[2]}-${m[3]}`;
    if (date < since) continue;
    const cells = line.split(",");
    const row: FactorRow = {};
    for (let j = 1; j < cells.length && j < header.length; j++) {
      const v = Number(cells[j]);
      if (header[j] && Number.isFinite(v) && v > -99.99) row[header[j]] = v / 100;
    }
    out.set(date, row);
  }
  return out;
}

async function zipText(url: string): Promise<string | null> {
  const r = await get(url, (res) => res.arrayBuffer(), { timeoutMs: 45_000 });
  return r.body == null ? null : unzipFirst(Buffer.from(r.body));
}

const asFactorData = new WeakMap<object, FactorData>();

/**
 * Fama-French 5 factors plus momentum, daily since 2012, from Ken French's
 * library (published with a one-to-two-month lag; `through` says how far it
 * reaches). Cached 7 days.
 */
export async function fetchFrenchFactors(): Promise<FactorData | null> {
  const entries = await cached<[string, FactorRow][]>("factors", "french-ff5-mom-daily", 7 * DAY_MS, 10 * DAY_MS, async () => {
    const [ff5, mom] = await Promise.all([
      zipText(`${FRENCH}F-F_Research_Data_5_Factors_2x3_daily_CSV.zip`),
      zipText(`${FRENCH}F-F_Momentum_Factor_daily_CSV.zip`),
    ]);
    const rows = ff5 ? parseFrenchCsv(ff5) : null;
    if (!rows?.size) {
      log("Ken French 5-factor file unavailable");
      return null;
    }
    if (mom) {
      for (const [d, r] of parseFrenchCsv(mom)) {
        const row = rows.get(d);
        if (row && typeof r.MOM === "number") row.MOM = r.MOM;
      }
    } else log("Ken French momentum file unavailable; models with MOM will be skipped");
    return [...rows.entries()];
  });
  if (!entries?.length) return null;
  let data = asFactorData.get(entries);
  if (!data) {
    data = { series: new Map(entries), through: entries[entries.length - 1][0], source: "Kenneth R. French Data Library (daily FF5 + momentum)", proxy: false };
    asFactorData.set(entries, data);
  }
  return data;
}

/** The Yahoo series behind India's factor proxies: each spread is the index or ETF minus the Nifty 50. */
export const INDIA_FACTOR_PROXIES = {
  MKT: "^NSEI",
  SMB: "^NSEMDCP50",
  HML: "NV20IETF.NS",
  MOM: "MOM30IETF.NS",
  LOWVOL: "LOWVOLIETF.NS",
} as const;

const INDIA_SHORT_RATE = "INDIR3TIB01STM";

/**
 * India factor proxies, daily: MKT = Nifty 50 − RF; SMB = Nifty Midcap 50 −
 * Nifty 50; HML, MOM and LOWVOL = the Nifty 50 Value 20, Nifty 200 Momentum 30
 * and Nifty 100 Low Volatility 30 ETFs − Nifty 50. Returns are taken on Nifty
 * trading days where both closes exist, so rows before an ETF listed simply
 * lack that factor. RF is FRED's 3-month interbank rate (monthly), else
 * `rfFallbackAnnual`.
 */
export async function fetchIndiaFactors(rfFallbackAnnual: number): Promise<FactorData | null> {
  const [nifty, ...legs] = await Promise.all(Object.values(INDIA_FACTOR_PROXIES).map((s) => fetchHistory(s)));
  if (!nifty || nifty.bars.length < 2) return null;
  const rfPts = await fetchFred(INDIA_SHORT_RATE);
  const names = ["SMB", "HML", "MOM", "LOWVOL"] as const;
  const closes = legs.map((h) => (h ? new Map(h.bars.map((b) => [b.date, b.adjClose])) : null));
  const missing = names.filter((_, i) => !closes[i]);
  const series = new Map<string, FactorRow>();
  let j = -1;
  for (let i = 1; i < nifty.bars.length; i++) {
    const d0 = nifty.bars[i - 1].date, d = nifty.bars[i].date;
    if (d < FACTOR_SINCE) continue;
    while (rfPts && j + 1 < rfPts.length && rfPts[j + 1].date <= d) j++;
    const rf = (rfPts && j >= 0 ? rfPts[j].value / 100 : rfFallbackAnnual) / 252;
    const rm = nifty.bars[i].adjClose / nifty.bars[i - 1].adjClose - 1;
    const row: FactorRow = { RF: rf, MKT: rm - rf };
    names.forEach((n, k) => {
      const c = closes[k], a = c?.get(d0), b = c?.get(d);
      if (a != null && b != null && a > 0) row[n] = b / a - 1 - rm;
    });
    series.set(d, row);
  }
  if (!series.size) return null;
  const legsText = names.map((n) => `${n} ${INDIA_FACTOR_PROXIES[n]}−^NSEI`).join(", ");
  const rfText = rfPts ? `RF FRED ${INDIA_SHORT_RATE}` : `RF assumed ${(rfFallbackAnnual * 100).toFixed(2)}% (FRED unavailable)`;
  return {
    series,
    through: nifty.bars[nifty.bars.length - 1].date,
    source: `India proxies: MKT ^NSEI−RF, ${legsText}; ${rfText}${missing.length ? `; missing ${missing.join(", ")}` : ""}`,
    proxy: true,
  };
}

// ── Rates and macro series (FRED) ───────────────────────────────────────────

export type SeriesPoint = { date: string; value: number };

/** FRED graph CSV ("observation_date,<ID>", "." for missing) → points, oldest first. */
export function parseFredCsv(csv: string): SeriesPoint[] {
  const out: SeriesPoint[] = [];
  for (const line of csv.split(/\r?\n/)) {
    const [d, v] = line.split(",");
    const date = d?.trim() ?? "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || v == null || v.trim() === "." || v.trim() === "") continue;
    const x = Number(v);
    if (Number.isFinite(x)) out.push({ date, value: x });
  }
  return out;
}

/** A FRED series since 2012 in its native units (rates in percent). Cached 12 hours; stale copies up to 3 days. */
export async function fetchFred(id: string): Promise<SeriesPoint[] | null> {
  return cached("fred", id, 12 * HOUR_MS, 3 * DAY_MS, async () => {
    const r = await get(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(id)}&cosd=${FACTOR_SINCE}`, (res) => res.text(), { timeoutMs: 20_000 });
    const pts = r.body == null ? [] : parseFredCsv(r.body);
    if (!pts.length) log(`FRED ${id}: no data (HTTP ${r.status})`);
    return pts.length ? pts : null;
  });
}

const RF_SERIES: Record<Market, { short: [string, string, number]; long: [string, string, number] }> = {
  // [FRED id, label, days after which the latest print counts as stale]
  US: { short: ["DTB3", "3-month T-bill", 10], long: ["DGS10", "10-year Treasury", 10] },
  IN: { short: [INDIA_SHORT_RATE, "3-month interbank rate", 75], long: ["INDIRLTLT01STM", "10-year government bond", 75] },
};

/** Used only when FRED is unreachable and no MERIDIAN_RF_* override is set; always flagged as an assumption. */
const RF_DEFAULTS: Record<Market, { short: number; long: number }> = { US: { short: 0.04, long: 0.045 }, IN: { short: 0.065, long: 0.07 } };

/**
 * Short and long risk-free rates as decimals. The short rate is the Sharpe
 * and factor-model hurdle; the long rate anchors CAPM's cost of equity.
 * Falls back to MERIDIAN_RF_<MARKET> / MERIDIAN_RF_LONG_<MARKET>, then to
 * defaults, flagged `assumption` either way.
 */
export async function fetchRiskFree(market: Market): Promise<{ short: Sourced; long: Sourced }> {
  const spec = RF_SERIES[market];
  const today = isoDay(Date.now());
  const pick = async ([id, label, staleDays]: [string, string, number], envKey: string, fallback: number): Promise<Sourced> => {
    const pts = await fetchFred(id);
    const last = pts?.[pts.length - 1];
    if (last) {
      const stale = daysBetween(last.date, today) > staleDays ? ", stale" : "";
      return { value: last.value / 100, source: `FRED ${id} (${label}) ${last.date}${stale}` };
    }
    const env = Number(process.env[envKey]);
    if (process.env[envKey] && Number.isFinite(env)) return { value: env, source: `${envKey} (FRED ${id} unavailable)`, assumption: true };
    return { value: fallback, source: `default ${(fallback * 100).toFixed(2)}% (FRED ${id} unavailable)`, assumption: true };
  };
  const [short, long] = await Promise.all([
    pick(spec.short, `MERIDIAN_RF_${market}`, RF_DEFAULTS[market].short),
    pick(spec.long, `MERIDIAN_RF_LONG_${market}`, RF_DEFAULTS[market].long),
  ]);
  return { short, long };
}

export type MacroSeriesSpec = { name: string; source: "fred" | "yahoo"; id: string; transform: "diff" | "logret" };

/**
 * The APT macro factors per desk: rates, curve, credit, oil, the dollar and
 * volatility for the US; the rupee, Brent, India VIX and US yields for India
 * (no daily Indian credit or curve series is published key-less). The macro
 * strategist states its view on these names.
 */
export const MACRO_SERIES: Record<Market, MacroSeriesSpec[]> = {
  US: [
    { name: "10y Treasury yield", source: "fred", id: "DGS10", transform: "diff" },
    { name: "2s10s curve", source: "fred", id: "T10Y2Y", transform: "diff" },
    // Moody's Baa − 10y: FRED's ICE BofA high-yield series only reaches back three years.
    { name: "Baa credit spread", source: "fred", id: "BAA10Y", transform: "diff" },
    { name: "WTI crude", source: "fred", id: "DCOILWTICO", transform: "logret" },
    { name: "Broad dollar", source: "fred", id: "DTWEXBGS", transform: "logret" },
    { name: "VIX", source: "fred", id: "VIXCLS", transform: "diff" },
  ],
  IN: [
    { name: "USD/INR", source: "yahoo", id: "USDINR=X", transform: "logret" },
    { name: "Brent crude", source: "fred", id: "DCOILBRENTEU", transform: "logret" },
    { name: "India VIX", source: "yahoo", id: "^INDIAVIX", transform: "diff" },
    { name: "US 10y Treasury yield", source: "fred", id: "DGS10", transform: "diff" },
  ],
};

/** For each date (ascending), the newest point on or before it, if no more than `maxGapDays` older. */
export function levelsOnOrBefore(points: readonly SeriesPoint[], dates: readonly string[], maxGapDays = 7): (number | null)[] {
  const out: (number | null)[] = [];
  let j = -1;
  for (const d of dates) {
    while (j + 1 < points.length && points[j + 1].date <= d) j++;
    out.push(j >= 0 && daysBetween(points[j].date, d) <= maxGapDays ? points[j].value : null);
  }
  return out;
}

/** Macro levels aligned to the stock's weekly sample dates. Series that fail to load are left out (and logged). */
export async function fetchMacroInputs(market: Market, weeklyDates: readonly string[]): Promise<MacroInput[]> {
  const loaded = await Promise.all(
    MACRO_SERIES[market].map(async (s): Promise<MacroInput | null> => {
      const pts =
        s.source === "fred"
          ? await fetchFred(s.id)
          : ((await fetchHistory(s.id))?.bars.map((b) => ({ date: b.date, value: b.close })) ?? null);
      if (!pts?.length) {
        log(`macro series ${s.id} unavailable; ${s.name} left out`);
        return null;
      }
      return { name: s.name, levels: levelsOnOrBefore(pts, weeklyDates), transform: s.transform };
    }),
  );
  return loaded.filter((x): x is MacroInput => x != null);
}
