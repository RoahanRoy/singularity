/**
 * Trading circuit breaker — a deterministic, fail-closed halt on paper fills.
 *
 * The risk officer gates each trade against the risk budget, but nothing
 * watched what the book as a whole was doing: a run of bad fills on a falling
 * tape would keep executing as long as each one cleared. This is that missing
 * floor. It sits in front of every fill (fillPaperTrade is the single
 * chokepoint for both the auto-execute and operator-approved paths) and halts
 * new buys when:
 *
 *   1. Day loss   — the fund book's P&L since the prior close, as a % of
 *                   start-of-day equity, is beyond the one-in-a-hundred day the
 *                   risk budget allows: z99 · (index vol + target TE) / √252,
 *                   with index vol measured over the past year
 *                   (lib/fund/risk-budget.ts).
 *   2. Lag        — the fund's flow-free return since its first daily mark
 *                   (fund_snapshots, book="fund") trails the index's by more
 *                   than the target's one-in-a-hundred band over those
 *                   sessions: z99 · target · √(sessions / 252).
 *   3. Can't mark — any held name has no live quote this session, or the book,
 *                   budget or index history can't be read at all. We refuse
 *                   to trade blind rather than assume all is well.
 *
 * The only operator number is the target tracking error (risk_budgets); no
 * desk has a budget, no desk fills.
 *
 * Like budgetController: no LLM anywhere in this path, and nothing an agent
 * says can loosen it. Research keeps running while halted — blocked trades
 * land on the memo as "review" so a human decides once the halt clears.
 *
 * Latching: a day-loss or lag trip holds for the rest of the exchange-local
 * session, even if marks recover (no flapping back into a falling market). It
 * clears on the next session date or a desk restart; a restart re-measures, so
 * a book still beyond the limit trips again immediately. "Can't mark" does not
 * latch — it re-checks on the next fill.
 *
 * Equity is the fund book (fund-book.ts): mandate cash + paper positions at
 * live marks. The advisory book (Horizon, IBKR, legacy Kite) is excluded — the
 * agents can't trade it.
 */
import { db, DB, ID, Query, emit, writeAudit } from "./appwrite";
import { exchangeDate } from "./market-hours";
import { markFundBook } from "./fund-book";
import { fetchHistory } from "./market-data";
import { loadBudget } from "./risk-budget";
import { DESK_INDEX } from "../../src/lib/market/indices";
import { dayLossLimit, lagLimit, lagSince, type LagPoint } from "../../src/lib/fund/risk-budget";
import { annualizedVol, TRADING_DAYS } from "../../src/lib/quant/risk";
import { simpleReturns } from "../../src/lib/quant/stats";

type Market = "US" | "IN";

/** Re-measure at most this often while clear — a sweep can fill many memos. */
const CACHE_MS = 60_000;

export type BreakerReading = {
  market: Market;
  /** Exchange-local session date the reading belongs to. */
  session: string;
  equity: number;
  sod_equity: number;
  day_pnl: number;
  /** Negative = loss. */
  day_pnl_pct: number;
  unpriced_pct: number;
  names: number;
  /** The operator's target tracking error (fraction) and the index's measured vol. */
  target_te: number;
  index_vol: number;
  /** The day loss that halts, % of start-of-day equity (positive). */
  day_loss_limit_pct: number;
  /** Flow-free log return vs the index since the first fund mark, %; null before one. */
  lag_pct: number | null;
  lag_sessions: number;
  /** The lag that halts over those sessions, % (positive). */
  lag_limit_pct: number;
};

export type BreakerVerdict = {
  halted: boolean;
  reason: string | null;
  reading: BreakerReading | null;
};

const pct2 = (x: number) => Number((x * 100).toFixed(3));

/**
 * Mark the desk's fund book (fund-book.ts) as a breaker reading, with the
 * limits its risk budget implies. Pure read — no writes, no alerts. Throws if
 * the book, budget, index history or fund marks can't be read (the caller
 * treats that as a halt).
 */
export async function measureBook(market: Market, now: Date = new Date()): Promise<BreakerReading> {
  const [b, budget, index, snaps] = await Promise.all([
    markFundBook(market, now),
    loadBudget(market),
    fetchHistory(DESK_INDEX[market].symbol),
    db.listDocuments(DB, "fund_snapshots", [
      Query.equal("market", market),
      Query.equal("book", "fund"),
      Query.orderAsc("captured_at"),
      Query.select(["captured_at", "book_index", "index_level"]),
      Query.limit(5000),
    ]),
  ]);
  if (!budget) throw new Error(`no ${market} risk budget set`);
  const closes = (index?.bars ?? []).slice(-(TRADING_DAYS + 1)).map((x) => x.adjClose);
  if (closes.length < TRADING_DAYS + 1) throw new Error(`under a year of ${DESK_INDEX[market].symbol} history`);
  const indexVol = annualizedVol(simpleReturns(closes));
  const lag = lagSince(snaps.documents as unknown as LagPoint[]);
  const sessions = lag?.sessions ?? 0;
  return {
    market,
    session: b.session,
    equity: b.equity,
    sod_equity: b.sod_equity,
    day_pnl: b.day_pnl,
    day_pnl_pct: b.day_pnl_pct,
    unpriced_pct: b.unpriced_pct,
    names: b.names.length,
    target_te: budget.target_te,
    index_vol: indexVol,
    day_loss_limit_pct: pct2(dayLossLimit(budget.target_te, indexVol)),
    lag_pct: lag ? pct2(lag.lag) : null,
    lag_sessions: sessions,
    lag_limit_pct: pct2(lagLimit(budget.target_te, sessions)),
  };
}

/** Which limit (if any) a reading breaches. `latch` = holds for the session. */
function judge(r: BreakerReading): { reason: string; latch: boolean } | null {
  if (r.unpriced_pct > 0) {
    return { reason: `can't mark ${r.unpriced_pct.toFixed(1)}% of the book (no live quotes) — refusing to trade blind`, latch: false };
  }
  if (-r.day_pnl_pct > r.day_loss_limit_pct) {
    return { reason: `day loss ${r.day_pnl_pct.toFixed(2)}% (${r.day_pnl.toFixed(0)}) breaches the −${r.day_loss_limit_pct.toFixed(2)}% the ${(r.target_te * 100).toFixed(1)}% risk budget allows`, latch: true };
  }
  if (r.lag_pct != null && -r.lag_pct > r.lag_limit_pct) {
    return { reason: `fund trails the index by ${(-r.lag_pct).toFixed(2)}% over ${r.lag_sessions} sessions, beyond the ${r.lag_limit_pct.toFixed(2)}% the ${(r.target_te * 100).toFixed(1)}% risk budget allows`, latch: true };
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
