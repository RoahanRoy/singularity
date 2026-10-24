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
 * Day P&L marks shares held at the open from the prior close, shares bought
 * this session from their fill price and shares sold this session at their
 * fill price; paper fills move cash and stock into each other, so start-of-day
 * equity = equity − day P&L.
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
  // Paper fills this session, per ticker — their day P&L runs from the fill
  // price, not the prior close.
  const today = new Map<string, { bought: number; cost: number; sold: number; proceeds: number }>();
  for (const t of tradeRes.documents as unknown as TradeRow[]) {
    if ((t.side !== "buy" && t.side !== "sell") || t.status !== "filled" || !String(t.venue ?? "").startsWith("paper-")) continue;
    if (!t.filled_at || exchangeDate(market, new Date(t.filled_at)) !== session) continue;
    const k = t.ticker.toUpperCase();
    const agg = today.get(k) ?? { bought: 0, cost: 0, sold: 0, proceeds: 0 };
    if (t.side === "buy") { agg.bought += t.qty; agg.cost += t.qty * t.price; }
    else { agg.sold += t.qty; agg.proceeds += t.qty * t.price; }
    today.set(k, agg);
  }
  // A name sold out this session still carries the day's P&L on what it sold.
  const book = rows.filter((p) => p.qty > 0 || (today.get(p.ticker.toUpperCase())?.sold ?? 0) > 0);

  const quotes = await mapPool(book, QUOTE_CONCURRENCY, (p) => getQuoteDetail(p.ticker, market));

  let mv = 0;
  let dayPnl = 0;
  let unpriced = 0;
  const marked: FundName[] = book.map((p, i) => {
    const q = quotes[i];
    if (!q || q.prevClose == null) {
      // No live mark: carry the stored value and contribute no P&L.
      const stored = p.qty > 0 ? Math.abs(p.market_value ?? 0) : 0;
      mv += stored;
      unpriced += stored;
      return { ticker: p.ticker, qty: p.qty, price: null, mv: stored };
    }
    const f = today.get(p.ticker.toUpperCase()) ?? { bought: 0, cost: 0, sold: 0, proceeds: 0 };
    // Shares at the open = now − bought + sold. A fill history that doesn't
    // reconcile with the row (more bought than it holds) counts what it holds.
    const scale = f.bought > p.qty + f.sold ? (p.qty + f.sold) / f.bought : 1;
    const bought = f.bought * scale;
    const heldAtOpen = p.qty - bought + f.sold;
    const value = p.qty * q.price;
    mv += value;
    dayPnl += value - heldAtOpen * q.prevClose - f.cost * scale + f.proceeds;
    return { ticker: p.ticker, qty: p.qty, price: q.price, mv: value };
  });
  const names = marked.filter((n) => n.qty > 0);

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
