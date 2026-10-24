/**
 * The desk's idea queue: the strongest long verdicts from the daily quant
 * sweep on names outside the book (src/lib/fund/ideas.ts), researched once.
 *
 * A name the desk has written a memo on is covered — later filings and news on
 * it reach the desk as updates through the event queue (events.ts), not as an
 * idea again. A name picked this session isn't picked twice that session even
 * when its chain stopped short of a memo (a failed screen, an unreadable memo);
 * tomorrow's sweep gives it a fresh verdict and it may come back.
 *
 * Verdicts count while they are as young as the chain's own hand-off from the
 * stored sweep (MERIDIAN_QUANT_STORED_MAX_AGE_H), so an idea is only researched
 * on the same facts the analyst will be shown.
 */
import { db, DB, Query, type Market } from "./appwrite";
import { readState, writeState } from "./state-store";
import { exchangeDate } from "./market-hours";
import { STORED_MAX_AGE_H } from "./quant-nodes";
import { rankIdeas, upsideOf, type Idea } from "../../src/lib/fund/ideas";
import { verdictOf } from "../../src/lib/fund/rebalance";
import type { QuantReport } from "../../src/lib/appwrite/schema";

const PAGE = 100;

/** Every ensemble verdict on the desk inside the freshness window. */
async function freshReports(market: Market, now: Date): Promise<QuantReport[]> {
  const since = new Date(now.getTime() - STORED_MAX_AGE_H * 3_600_000).toISOString();
  const out: QuantReport[] = [];
  let cursor: string | undefined;
  while (true) {
    const q = [
      Query.equal("agent", "ensemble-combiner"), Query.equal("market", market), Query.greaterThan("run_at", since),
      Query.select(["$id", "ticker", "score", "payload_json", "run_at"]), Query.limit(PAGE),
    ];
    if (cursor) q.push(Query.cursorAfter(cursor));
    const page = await db.listDocuments(DB, "quant_reports", q);
    out.push(...(page.documents as unknown as QuantReport[]));
    if (page.documents.length < PAGE) return out;
    cursor = page.documents[page.documents.length - 1].$id;
  }
}

/** Today's ranked ideas for the desk, strongest first, covered or not (src/lib/fund/ideas.ts). */
export async function loadIdeas(market: Market, universe: readonly string[], held: readonly string[], now: Date = new Date()): Promise<Idea[]> {
  if (!(STORED_MAX_AGE_H > 0)) return [];
  const verdicts = (await freshReports(market, now)).flatMap((r) => {
    const v = verdictOf(r);
    if (!v) return [];
    let data: unknown = null;
    try { data = r.payload_json ? (JSON.parse(r.payload_json) as { data?: unknown }).data : null; } catch { /* no upside */ }
    return [{ ...v, upsidePct: upsideOf(data) }];
  });
  return rankIdeas({ verdicts, universe, held, now: now.getTime(), maxAgeMs: STORED_MAX_AGE_H * 3_600_000 }).ideas;
}

/** True when the desk has written a memo on the name. */
export async function hasMemo(ticker: string): Promise<boolean> {
  const res = await db.listDocuments(DB, "memos", [Query.equal("ticker", ticker), Query.select(["$id"]), Query.limit(1)]);
  return res.documents.length > 0;
}

/** Names picked this session, and names found covered (memos aren't deleted, so that holds all session). */
type IdeaState = { session: string; picked: string[]; covered?: string[] };
const stateFile = (market: Market) => `.agents-ideas-${market}.json`;

export type IdeaPick = { idea: Idea; rank: number; of: number; covered: number };

/**
 * The strongest idea the desk hasn't researched and hasn't picked this
 * session, recorded as picked before it is returned. Null when none is left.
 */
export async function nextIdea(market: Market, universe: readonly string[], held: readonly string[], now: Date = new Date()): Promise<IdeaPick | null> {
  const ideas = await loadIdeas(market, universe, held, now);
  if (!ideas.length) return null;
  const session = exchangeDate(market, now);
  const prior = await readState<IdeaState>(stateFile(market));
  const today = prior?.session === session;
  const picked = new Set(today ? prior.picked : []);
  const covered = new Set(today ? prior.covered ?? [] : []);
  const save = () => writeState(stateFile(market), { session, picked: [...picked], covered: [...covered] } satisfies IdeaState);
  for (let i = 0; i < ideas.length; i++) {
    const idea = ideas[i];
    if (picked.has(idea.ticker) || covered.has(idea.ticker)) continue;
    if (await hasMemo(idea.ticker)) { covered.add(idea.ticker); continue; }
    picked.add(idea.ticker);
    await save();
    return { idea, rank: i + 1, of: ideas.length, covered: ideas.filter((x) => covered.has(x.ticker)).length };
  }
  await save();
  return null;
}
