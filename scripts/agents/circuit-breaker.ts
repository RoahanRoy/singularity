/**
 * Trading circuit breaker — a deterministic, fail-closed halt on paper fills.
 *
 * The risk overlay gates each trade against position/VaR caps, but nothing
 * watched what the book as a whole was doing: a run of bad fills on a falling
 * tape would keep executing as long as each one cleared the overlay. This is
 * that missing floor. It sits in front of every fill (fillPaperTrade is the
 * single chokepoint for both the auto-execute and operator-approved paths) and
 * halts new buys when:
 *
 *   1. Day loss   — the paper book's P&L since the prior close, as a % of
 *                   start-of-day equity, breaches MERIDIAN_MAX_DAILY_LOSS_PCT.
 *   2. Drawdown   — (mandate desks only) equity has fallen
 *                   MERIDIAN_MAX_DRAWDOWN_PCT below the mandate's capital base.
 *   3. Can't mark — more than MAX_UNPRICED_PCT of the book has no live quote,
 *                   or the book/mandate can't be read at all. We refuse to
 *                   trade blind rather than assume all is well.
 *
 * Like budgetController: no LLM anywhere in this path, and nothing an agent
 * says can loosen it. Research keeps running while halted — blocked trades
 * land on the memo as "review" so a human decides once the halt clears.
 *
 * Latching: a loss/drawdown trip holds for the rest of the exchange-local
 * session, even if marks recover (no flapping back into a falling market). It
 * clears on the next session date or a desk restart; a restart re-measures, so
 * a book still beyond the limit trips again immediately. "Can't mark" does not
 * latch — it re-checks on the next fill.
 *
 * Equity = mandate cash (0 with no mandate) + paper book at live marks. Day P&L
 * marks shares held at the open from the prior close and shares bought today
 * from their fill price. Paper buys are cash-neutral to equity, so start-of-day
 * equity = equity − day P&L. Live brokerage rows (IBKR/Kite) are excluded — the
 * agents can't trade them.
 *
 * Env:
 *   MERIDIAN_MAX_DAILY_LOSS_PCT   default 3   (% of start-of-day equity)
 *   MERIDIAN_MAX_DRAWDOWN_PCT     default 10  (% below mandate capital base)
 */
import { db, DB, ID, Query, emit, writeAudit } from "./appwrite";
import { getQuoteDetail } from "./quotes";
import { exchangeDate } from "./market-hours";
import { getMandate } from "../../src/lib/fund/mandate";

type Market = "US" | "IN";

const envPct = (name: string, def: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : def;
};
const MAX_DAILY_LOSS_PCT = envPct("MERIDIAN_MAX_DAILY_LOSS_PCT", 3);
const MAX_DRAWDOWN_PCT = envPct("MERIDIAN_MAX_DRAWDOWN_PCT", 10);
/** Share of the book (by value) we tolerate without a live mark. */
const MAX_UNPRICED_PCT = 20;
/** Re-measure at most this often while clear — a sweep can fill many memos. */
const CACHE_MS = 60_000;
const QUOTE_CONCURRENCY = 8;

export type BreakerReading = {
  market: Market;
  /** Exchange-local session date the reading belongs to. */
  session: string;
  equity: number;
  sod_equity: number;
  day_pnl: number;
  /** Negative = loss. */
  day_pnl_pct: number;
  /** Below mandate capital base; null with no mandate. */
  drawdown_pct: number | null;
  unpriced_pct: number;
  names: number;
};

export type BreakerVerdict = {
  halted: boolean;
  reason: string | null;
  reading: BreakerReading | null;
};

type PaperRow = {
  ticker: string;
  qty: number;
  market_value?: number | null;
  ibkr_account_id?: string | null;
  kite_account_id?: string | null;
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

/**
 * Mark the desk's paper book. Pure read — no writes, no alerts. Throws if the
 * book or mandate can't be read (the caller treats that as a halt).
 */
export async function measureBook(market: Market, now: Date = new Date()): Promise<BreakerReading> {
  const session = exchangeDate(market, now);
  const [posRes, tradeRes, mandate] = await Promise.all([
    db.listDocuments(DB, "positions", [Query.equal("market", market), Query.limit(200)]),
    db.listDocuments(DB, "trades", [
      Query.equal("market", market),
      Query.orderDesc("$createdAt"),
      Query.limit(200),
    ]),
    getMandate(db, DB, market),
  ]);

  const book = (posRes.documents as unknown as PaperRow[]).filter(
    (p) => !p.ibkr_account_id && !p.kite_account_id && p.qty > 0,
  );

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
  book.forEach((p, i) => {
    const q = quotes[i];
    if (!q || q.prevClose == null) {
      // No live mark: carry the stored value, contribute no P&L, and count it
      // toward the unpriced share that can halt us on its own.
      const stored = Math.abs(p.market_value ?? 0);
      mv += stored;
      unpriced += stored;
      return;
    }
    const fills = today.get(p.ticker.toUpperCase());
    const boughtToday = Math.min(fills?.qty ?? 0, p.qty);
    const costToday = fills && fills.qty > 0 ? fills.cost * (boughtToday / fills.qty) : 0;
    const heldAtOpen = p.qty - boughtToday;
    mv += p.qty * q.price;
    dayPnl += heldAtOpen * (q.price - q.prevClose) + (boughtToday * q.price - costToday);
  });

  const equity = (mandate?.cash ?? 0) + mv;
  const sod = equity - dayPnl;
  const base = mandate?.capital_base ?? 0;

  return {
    market,
    session,
    equity: Number(equity.toFixed(2)),
    sod_equity: Number(sod.toFixed(2)),
    day_pnl: Number(dayPnl.toFixed(2)),
    day_pnl_pct: sod > 0 ? Number(((dayPnl / sod) * 100).toFixed(3)) : 0,
    drawdown_pct: mandate && base > 0 ? Number((Math.max(0, (base - equity) / base) * 100).toFixed(3)) : null,
    unpriced_pct: mv > 0 ? Number(((unpriced / mv) * 100).toFixed(1)) : 0,
    names: book.length,
  };
}

/** Which limit (if any) a reading breaches. `latch` = holds for the session. */
function judge(r: BreakerReading): { reason: string; latch: boolean } | null {
  if (r.unpriced_pct > MAX_UNPRICED_PCT) {
    return { reason: `can't mark ${r.unpriced_pct.toFixed(0)}% of the book (no live quotes) — refusing to trade blind`, latch: false };
  }
  if (r.day_pnl_pct <= -MAX_DAILY_LOSS_PCT) {
    return { reason: `day loss ${r.day_pnl_pct.toFixed(2)}% (${r.day_pnl.toFixed(0)}) breaches the −${MAX_DAILY_LOSS_PCT}% daily limit`, latch: true };
  }
  if (r.drawdown_pct != null && r.drawdown_pct >= MAX_DRAWDOWN_PCT) {
    return { reason: `equity ${r.drawdown_pct.toFixed(2)}% below capital base breaches the ${MAX_DRAWDOWN_PCT}% drawdown limit`, latch: true };
  }
  return null;
}

// Per-process state. Each desk loop is its own process, so this is per desk.
const latched = new Map<Market, { session: string; reason: string }>();
const clearCache = new Map<Market, { at: number; verdict: BreakerVerdict }>();

/**
 * Gate a fill. Deterministic and fail-closed: any error measuring the book
 * halts. On a fresh trip it writes the audit row, a governance block and a
 * live-feed alert (best-effort — the halt never depends on those writes).
 */
export async function checkCircuitBreaker(market: Market, agentId: string): Promise<BreakerVerdict> {
  const session = exchangeDate(market);
  const latch = latched.get(market);
  if (latch && latch.session === session) return { halted: true, reason: latch.reason, reading: null };
  if (latch) latched.delete(market); // new session — re-arm

  const cached = clearCache.get(market);
  if (cached && Date.now() - cached.at < CACHE_MS && cached.verdict.reading?.session === session) {
    return cached.verdict;
  }
  clearCache.delete(market);

  let reading: BreakerReading;
  try {
    reading = await measureBook(market);
  } catch (err) {
    const reason = `can't measure the ${market} book (${(err as Error).message}) — failing closed`;
    console.warn(`[breaker] ${reason}`);
    return { halted: true, reason, reading: null };
  }

  const hit = judge(reading);
  if (!hit) {
    const verdict: BreakerVerdict = { halted: false, reason: null, reading };
    clearCache.set(market, { at: Date.now(), verdict });
    return verdict;
  }
  if (!hit.latch) return { halted: true, reason: hit.reason, reading };

  latched.set(market, { session: reading.session, reason: hit.reason });
  const target = `${market} desk`;
  const detail = `Circuit breaker TRIPPED — new fills halted for session ${reading.session}: ${hit.reason}. ` +
    `Equity ${reading.equity}, start-of-day ${reading.sod_equity}, names ${reading.names}.`;
  console.warn(`[breaker] ${detail}`);
  await writeAudit("circuit-breaker", "halt", target, "block", detail);
  try {
    await db.createDocument(DB, "governance_events", ID.unique(), {
      kind: "block",
      actor: "circuit-breaker",
      target,
      reason: hit.reason.slice(0, 500),
      occurred_at: new Date().toISOString(),
    });
  } catch (err) {
    console.warn(`[breaker] governance write failed:`, (err as Error).message);
  }
  try {
    await emit(agentId, "alert", `CIRCUIT BREAKER — ${market} fills halted: ${hit.reason}`, reading);
  } catch (err) {
    console.warn(`[breaker] alert emit failed:`, (err as Error).message);
  }
  return { halted: true, reason: hit.reason, reading };
}

export const breakerLimits = {
  max_daily_loss_pct: MAX_DAILY_LOSS_PCT,
  max_drawdown_pct: MAX_DRAWDOWN_PCT,
  max_unpriced_pct: MAX_UNPRICED_PCT,
};
