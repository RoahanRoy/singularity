/**
 * The fund's book of record: the mandate's undeployed cash plus the desk's
 * paper positions, marked at live quotes. This — not the operator's Horizon
 * holdings, which are an advisory book the agents can't trade — is what NAV,
 * sizing, position weights, limits and the circuit breaker count.
 *
 * Fund rows are the `positions` rows with no brokerage account id and no
 * horizon_source (the rest are legacy advisory rows, now in advisory_positions). Pure read: no writes, no alerts. Throws if the book or the
 * mandate can't be read, so a caller that gates on it fails closed.
 *
 * Marks: a name with a live quote is marked at it. A name without one carries
 * its stored market value (its last mark) and counts toward `unpriced_pct`.
 * Day P&L marks shares held at the open from the prior close and shares bought
 * this session from their fill price; paper buys move cash into stock, so
 * start-of-day equity = equity − day P&L.
 */
import { db, DB, Query } from "./appwrite";
import { getQuoteDetail } from "./quotes";
import { exchangeDate } from "./market-hours";
import { getMandate } from "../../src/lib/fund/mandate";
import { isFundPosition, type FundMandate } from "../../src/lib/appwrite/schema";

type Market = "US" | "IN";

const QUOTE_CONCURRENCY = 8;

export type FundRow = {
  $id: string;
  ticker: string;
  qty: number;
  avg_cost: number;
  market_value: number;
  ibkr_account_id?: string | null;
  kite_account_id?: string | null;
  horizon_source?: string | null;
};

/** A positions row on the fund's book (not a legacy Horizon or brokerage row). */
export const isFundRow = isFundPosition;

export type FundName = {
  ticker: string;
  qty: number;
  /** Live quote, or null when unpriced (then `mv` is the stored last mark). */
  price: number | null;
  mv: number;
};

export type FundBook = {
  market: Market;
  /** Exchange-local session date the marks belong to. */
  session: string;
  mandate: FundMandate | null;
  cash: number;
  /** Market value of the positions. */
  mv: number;
  /** cash + mv: the fund's NAV. */
  equity: number;
  sod_equity: number;
  day_pnl: number;
  /** Negative = loss. */
  day_pnl_pct: number;
  /** Below mandate capital base; null with no mandate. */
  drawdown_pct: number | null;
  /** Share of position value carried at a stored mark (no live quote). */
  unpriced_pct: number;
  names: FundName[];
};

type TradeRow = {
  ticker: string;
  side: string;
  qty: number;
  price: number;
  venue?: string | null;
  status?: string | null;
  filled_at?: string | null;
};

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

/** The fund rows for a desk, unmarked. */
export async function fundRows(market: Market): Promise<FundRow[]> {
  const res = await db.listDocuments(DB, "positions", [
    Query.equal("market", market),
    Query.isNull("horizon_source"),
    Query.isNull("ibkr_account_id"),
    Query.isNull("kite_account_id"),
    Query.limit(200),
  ]);
  return (res.documents as unknown as FundRow[]).filter(isFundRow);
}

/** Mark the desk's fund book at live quotes. */
export async function markFundBook(market: Market, now: Date = new Date()): Promise<FundBook> {
  const session = exchangeDate(market, now);
  const [rows, tradeRes, mandate] = await Promise.all([
    fundRows(market),
    db.listDocuments(DB, "trades", [
      Query.equal("market", market),
      Query.orderDesc("$createdAt"),
      Query.limit(200),
    ]),
    getMandate(db, DB, market),
  ]);
  const book = rows.filter((p) => p.qty > 0);

  // Paper shares bought this session, per ticker — their day P&L runs from the
  // fill price, not the prior close.
  const today = new Map<string, { qty: number; cost: number }>();
  for (const t of tradeRes.documents as unknown as TradeRow[]) {
    if (t.side !== "buy" || t.status !== "filled" || !String(t.venue ?? "").startsWith("paper-")) continue;
    if (!t.filled_at || exchangeDate(market, new Date(t.filled_at)) !== session) continue;
    const k = t.ticker.toUpperCase();
    const agg = today.get(k) ?? { qty: 0, cost: 0 };
    agg.qty += t.qty;
    agg.cost += t.qty * t.price;
    today.set(k, agg);
  }

  const quotes = await mapPool(book, QUOTE_CONCURRENCY, (p) => getQuoteDetail(p.ticker, market));

  let mv = 0;
  let dayPnl = 0;
  let unpriced = 0;
  const names: FundName[] = book.map((p, i) => {
    const q = quotes[i];
    if (!q || q.prevClose == null) {
      // No live mark: carry the stored value and contribute no P&L.
      const stored = Math.abs(p.market_value ?? 0);
      mv += stored;
      unpriced += stored;
      return { ticker: p.ticker, qty: p.qty, price: null, mv: stored };
    }
    const fills = today.get(p.ticker.toUpperCase());
    const boughtToday = Math.min(fills?.qty ?? 0, p.qty);
    const costToday = fills && fills.qty > 0 ? fills.cost * (boughtToday / fills.qty) : 0;
    const heldAtOpen = p.qty - boughtToday;
    const value = p.qty * q.price;
    mv += value;
    dayPnl += heldAtOpen * (q.price - q.prevClose) + (boughtToday * q.price - costToday);
    return { ticker: p.ticker, qty: p.qty, price: q.price, mv: value };
  });

  const cash = mandate?.cash ?? 0;
  const equity = cash + mv;
  const sod = equity - dayPnl;
  const base = mandate?.capital_base ?? 0;

  return {
    market,
    session,
    mandate,
    cash: Number(cash.toFixed(2)),
    mv: Number(mv.toFixed(2)),
    equity: Number(equity.toFixed(2)),
    sod_equity: Number(sod.toFixed(2)),
    day_pnl: Number(dayPnl.toFixed(2)),
    day_pnl_pct: sod > 0 ? Number(((dayPnl / sod) * 100).toFixed(3)) : 0,
    drawdown_pct: mandate && base > 0 ? Number((Math.max(0, (base - equity) / base) * 100).toFixed(3)) : null,
    unpriced_pct: mv > 0 ? Number(((unpriced / mv) * 100).toFixed(1)) : 0,
    names,
  };
}
