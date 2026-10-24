/**
 * The desk's portfolio risk report: today's weights over measured history
 * (src/lib/quant/portfolio-risk.ts), for the fund book and the advisory book,
 * written to `risk_reports` — one row per desk, book and exchange session.
 *
 * The first report of a session creates the row; later ones that session
 * update it. Inputs:
 *   fund      fund-book.ts at live marks; NAV = mandate cash + positions.
 *   advisory  advisory_positions at their last sync marks; NAV = their value
 *             (the operator's cash isn't on file).
 * Daily history and the desk index come from market-data.ts (Yahoo, cached).
 *
 * Method choices, not decision numbers: a one-year window (TRADING_DAYS
 * returns), a 20-session average daily volume, and the 2020 and 2022
 * replays the rebuild plan names. No mandate, no fund report; no index
 * history, no report.
 */
import { db, DB, ID, Query } from "./appwrite";
import { markFundBook } from "./fund-book";
import { exchangeDate } from "./market-hours";
import { fetchHistory, ySym } from "./market-data";
import { DESK_INDEX } from "../../src/lib/market/indices";
import { TRADING_DAYS } from "../../src/lib/quant/risk";
import { portfolioRisk, type PortfolioRisk, type RiskHolding } from "../../src/lib/quant/portfolio-risk";
import type { Bar } from "../../src/lib/quant/types";

type Market = "US" | "IN";
export type RiskBook = "fund" | "advisory";

const ADV_WINDOW = 20;
const STRESS_YEARS = [2020, 2022];
const HISTORY_CONCURRENCY = 6;
const REPORT_JSON_MAX = 65_535;

export type Holding = { ticker: string; qty: number; price: number };

async function mapPool<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

async function bookHoldings(market: Market, book: RiskBook, now: Date): Promise<{ nav: number; holdings: Holding[]; marks: string } | { skip: string }> {
  if (book === "fund") {
    const b = await markFundBook(market, now);
    if (!b.mandate) return { skip: `no ${market} fund mandate` };
    return {
      nav: b.equity,
      holdings: b.names.filter((n) => n.qty > 0).map((n) => ({ ticker: n.ticker, qty: n.qty, price: n.price ?? n.mv / n.qty })),
      marks: b.unpriced_pct > 0 ? `live quotes (${b.unpriced_pct}% at a stored mark)` : "live quotes",
    };
  }
  const res = await db.listDocuments(DB, "advisory_positions", [Query.equal("market", market), Query.limit(500)]);
  const rows = (res.documents as unknown as { ticker: string; qty: number; market_value: number }[]).filter((p) => p.qty > 0 && p.market_value > 0);
  if (!rows.length) return { skip: `no ${market} advisory holdings` };
  return {
    nav: rows.reduce((s, p) => s + p.market_value, 0),
    holdings: rows.map((p) => ({ ticker: p.ticker, qty: p.qty, price: p.market_value / p.qty })),
    marks: "last holdings sync",
  };
}

/** Holdings with their daily history, and the desk index's; null without the index. */
export async function withHistory(market: Market, holdings: readonly Holding[]): Promise<{ index: Bar[]; holdings: RiskHolding[] } | null> {
  const [index, histories] = await Promise.all([
    fetchHistory(DESK_INDEX[market].symbol),
    mapPool([...holdings], HISTORY_CONCURRENCY, (h) => fetchHistory(ySym(h.ticker, market))),
  ]);
  if (!index) return null;
  return { index: index.bars, holdings: holdings.map((h, i) => ({ ...h, bars: histories[i]?.bars ?? [] })) };
}

/** The desk's risk report for a book: a one-year window, 20-session ADV, the 2020 and 2022 replays. */
export function measure(nav: number, holdings: readonly RiskHolding[], index: readonly Bar[]): PortfolioRisk | null {
  return portfolioRisk({ nav, holdings, index, window: TRADING_DAYS, advWindow: ADV_WINDOW, stressYears: STRESS_YEARS });
}

const r6 = (x: number) => (Number.isFinite(x) ? Number(x.toFixed(6)) : null);

/** The report as stored: numbers rounded, non-finite as null. */
function compact(r: PortfolioRisk): unknown {
  return JSON.parse(JSON.stringify(r, (_k, v) => (typeof v === "number" ? r6(v) : v)));
}

export type RiskRun =
  | { status: "reported"; market: Market; book: RiskBook; session: string; report: PortfolioRisk }
  | { status: "skipped"; market: Market; book: RiskBook; reason: string };

export async function reportRisk(market: Market, book: RiskBook, now: Date = new Date()): Promise<RiskRun> {
  const inputs = await bookHoldings(market, book, now);
  if ("skip" in inputs) return { status: "skipped", market, book, reason: inputs.skip };

  const hist = await withHistory(market, inputs.holdings);
  if (!hist) return { status: "skipped", market, book, reason: `no ${DESK_INDEX[market].symbol} history` };
  const report = measure(inputs.nav, hist.holdings, hist.index);
  if (!report) return { status: "skipped", market, book, reason: `NAV ${inputs.nav} or under ${TRADING_DAYS + 1} index sessions` };

  const session = exchangeDate(market, now);
  let json = JSON.stringify({ ...(compact(report) as object), marks: inputs.marks, index: DESK_INDEX[market].name });
  if (json.length > REPORT_JSON_MAX) {
    // Per-name stress returns are the first thing to give; the book's replay stays.
    json = JSON.stringify({ ...(compact({ ...report, names: report.names.map((n) => ({ ...n, stress: {} })) }) as object), marks: inputs.marks, index: DESK_INDEX[market].name });
    if (json.length > REPORT_JSON_MAX) throw new Error(`risk report is ${json.length} chars, over ${REPORT_JSON_MAX}`);
  }
  const row = {
    market,
    book,
    session,
    captured_at: now.toISOString(),
    nav: Number(report.nav.toFixed(2)),
    vol_annual: r6(report.vol_annual),
    var95: r6(report.var95.parametric),
    es95: r6(report.es95.parametric),
    var99: r6(report.var99.parametric),
    beta: r6(report.beta),
    tracking_error: r6(report.tracking_error),
    unmeasured_weight: r6(report.unmeasured_weight),
    report_json: json,
  };
  const prior = await db.listDocuments(DB, "risk_reports", [
    Query.equal("market", market),
    Query.equal("book", book),
    Query.orderDesc("captured_at"),
    Query.limit(1),
  ]);
  const latest = prior.documents[0] as unknown as { $id: string; session: string } | undefined;
  if (latest?.session === session) await db.updateDocument(DB, "risk_reports", latest.$id, row);
  else await db.createDocument(DB, "risk_reports", ID.unique(), row);
  return { status: "reported", market, book, session, report };
}
