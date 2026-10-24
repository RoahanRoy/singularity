/**
 * Verdict flips on covered names (src/lib/fund/flips.ts): a name held, or
 * with a memo, whose fresh sweep verdict calls it the other way from the
 * verdict its last memo was written on is researched again.
 *
 * Each candidate costs two reads (its newest memo, and the verdict before it),
 * so a name is checked once per fresh verdict: the result is cached in the
 * session state under ticker@run_at, and the next sweep's verdict is a new key.
 * A flip picked this session isn't picked again that session even when its
 * chain stopped short of a memo.
 */
import { db, DB, Query, type Market } from "./appwrite";
import { readState, writeState } from "./state-store";
import { exchangeDate } from "./market-hours";
import { STORED_MAX_AGE_H } from "./quant-nodes";
import { freshReports } from "./ideas";
import { flipOf, type Flip } from "../../src/lib/fund/flips";
import { edgeOf, freshVerdicts, verdictOf, type Verdict } from "../../src/lib/fund/rebalance";
import type { QuantReport } from "../../src/lib/appwrite/schema";

/** When the newest memo on the name was written, or null when there is none. */
async function lastMemoAt(ticker: string): Promise<string | null> {
  const res = await db.listDocuments(DB, "memos", [
    Query.equal("ticker", ticker), Query.orderDesc("$createdAt"), Query.select(["$id", "$createdAt"]), Query.limit(1),
  ]);
  return (res.documents[0]?.$createdAt as string | undefined) ?? null;
}

/** The newest verdict on the name at or before `at`: what the memo was written on. */
async function verdictAt(market: Market, ticker: string, at: string): Promise<Verdict | null> {
  const res = await db.listDocuments(DB, "quant_reports", [
    Query.equal("agent", "ensemble-combiner"), Query.equal("market", market), Query.equal("ticker", ticker),
    Query.lessThanEqual("run_at", at), Query.orderDesc("run_at"),
    Query.select(["$id", "ticker", "score", "payload_json", "run_at"]), Query.limit(1),
  ]);
  const r = res.documents[0] as unknown as QuantReport | undefined;
  return r ? verdictOf(r) : null;
}

type FlipState = { session: string; checked: string[] };
const stateFile = (market: Market) => `.agents-flips-${market}.json`;

/**
 * The first covered name whose verdict has flipped since its last memo, held
 * names first, then by edge. Recorded as checked before it is returned. Null
 * when none has.
 */
export async function nextFlip(market: Market, universe: readonly string[], held: readonly string[], now: Date = new Date()): Promise<Flip | null> {
  if (!(STORED_MAX_AGE_H > 0)) return null;
  const heldSet = new Set(held.map((t) => t.toUpperCase()));
  const covered = new Set([...heldSet, ...universe.map((t) => t.toUpperCase())]);
  const verdicts = (await freshReports(market, now)).flatMap((r) => verdictOf(r) ?? []);
  const fresh = [...freshVerdicts(verdicts, now.getTime(), STORED_MAX_AGE_H * 3_600_000).values()]
    .filter((v) => v.direction !== "neutral" && covered.has(v.ticker.toUpperCase()))
    .sort((a, b) =>
      Number(heldSet.has(b.ticker.toUpperCase())) - Number(heldSet.has(a.ticker.toUpperCase())) ||
      Math.abs(edgeOf(b)) - Math.abs(edgeOf(a)) || a.ticker.localeCompare(b.ticker));
  if (!fresh.length) return null;

  const session = exchangeDate(market, now);
  const prior = await readState<FlipState>(stateFile(market));
  const checked = new Set(prior?.session === session ? prior.checked : []);
  const before = checked.size;
  const save = () => writeState(stateFile(market), { session, checked: [...checked] } satisfies FlipState);
  try {
    for (const v of fresh) {
      const k = `${v.ticker.toUpperCase()}@${v.runAt}`;
      if (checked.has(k)) continue;
      checked.add(k);
      const memoAt = await lastMemoAt(v.ticker);
      if (!memoAt) continue;
      const flip = flipOf(await verdictAt(market, v.ticker, memoAt), v, memoAt);
      if (flip) return flip;
    }
    return null;
  } finally {
    if (checked.size > before) await save();
  }
}
