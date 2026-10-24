/**
 * The fund's daily NAV mark: one `fund_snapshots` row (book="fund") per desk
 * per exchange session, from the fund book at live marks (fund-book.ts).
 *
 * The first mark of a session creates the row; later marks that session update
 * it, so the row ends the day at its last mark. Beside the NAV it carries the
 * flow-free book level — chained from the prior session's by the day's P&L
 * over start-of-day equity, so cash moving into stock (or a top-up) is not
 * performance — and the desk's index level, for the scorecard (scorecard.ts).
 *
 * Marks only once the session has traded: before the open a quote is still
 * the prior session's. No mandate, no fund, no mark.
 */
import { db, DB, ID, Query } from "./appwrite";
import { markFundBook } from "./fund-book";
import { exchangeDate, marketState } from "./market-hours";
import { nextBookIndex } from "../../src/lib/fund/scorecard";
import { indexLevel } from "../../src/lib/market/indices";

type Market = "US" | "IN";

type SnapRow = { $id: string; captured_at: string; book_index?: number | null };

export type FundNavMark =
  | { status: "marked"; session: string; nav: number; day_pnl: number; book_index: number }
  | { status: "skipped"; reason: string };

export async function markFundNav(market: Market, now: Date = new Date()): Promise<FundNavMark> {
  const state = marketState(market, now);
  if (!state.open && state.label !== "after-hours") return { status: "skipped", reason: `session not traded (${state.label})` };

  const book = await markFundBook(market, now);
  if (!book.mandate) return { status: "skipped", reason: `no ${market} fund mandate` };

  const recent = await db.listDocuments(DB, "fund_snapshots", [
    Query.equal("market", market),
    Query.equal("book", "fund"),
    Query.orderDesc("captured_at"),
    Query.limit(2),
  ]);
  const [latest, before] = recent.documents as unknown as SnapRow[];
  const sameSession = latest && exchangeDate(market, new Date(latest.captured_at)) === book.session;
  const prior = sameSession ? before : latest;

  const r = book.sod_equity > 0 ? book.day_pnl / book.sod_equity : null;
  const level = await indexLevel(market);
  const row = {
    nav_usd: book.equity,
    pnl_daily: book.day_pnl,
    captured_at: now.toISOString(),
    market,
    book: "fund",
    book_index: Number(nextBookIndex(prior?.book_index, r).toFixed(6)),
    // Yahoo not answering leaves an earlier mark's index level in place.
    ...(level == null ? {} : { index_level: Number(level.toFixed(4)) }),
  };
  if (sameSession) await db.updateDocument(DB, "fund_snapshots", latest.$id, row);
  else await db.createDocument(DB, "fund_snapshots", ID.unique(), row);
  return { status: "marked", session: book.session, nav: row.nav_usd, day_pnl: row.pnl_daily, book_index: row.book_index };
}
