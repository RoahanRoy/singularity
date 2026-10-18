/**
 * The names a desk covers: everything on the book plus the sector universe.
 * Shared by the filings ingest and the daily quant sweep so both build their
 * base over the same list.
 */
import { db, DB, Query } from "./appwrite";
import { SECTOR_UNIVERSE, INDIA_SECTOR_UNIVERSE } from "./universe";

export type Market = "US" | "IN";

/** Distinct tickers on a desk's book. "MF:" rows are mutual funds pulled from Horizon — they file and trade nothing. */
export async function heldTickers(market: Market): Promise<string[]> {
  const rows: string[] = [];
  let cursor: string | undefined;
  while (true) {
    const queries = [Query.equal("market", market), Query.limit(100)];
    if (cursor) queries.push(Query.cursorAfter(cursor));
    const page = await db.listDocuments(DB, "positions", queries);
    for (const d of page.documents) {
      const t = String(d.ticker ?? "").trim().toUpperCase();
      if (t && !t.startsWith("MF:")) rows.push(t);
    }
    if (page.documents.length < 100) break;
    cursor = page.documents[page.documents.length - 1].$id;
  }
  return Array.from(new Set(rows));
}

/** The desk's sector universe, de-duplicated. */
export function universeTickers(market: Market): string[] {
  const u = market === "IN" ? INDIA_SECTOR_UNIVERSE : SECTOR_UNIVERSE;
  return Array.from(new Set(Object.values(u).flat().map((t) => t.toUpperCase())));
}

/** Held names first, then the rest of the universe. */
export async function coverageTickers(market: Market): Promise<{ all: string[]; held: Set<string> }> {
  const held = await heldTickers(market);
  return { all: Array.from(new Set([...held, ...universeTickers(market)])), held: new Set(held) };
}
