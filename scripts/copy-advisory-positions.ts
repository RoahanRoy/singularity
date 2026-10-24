/**
 * Additive data migration — split the advisory book out of `positions`.
 *
 * The operator's real holdings (rows with horizon_source or a brokerage account
 * id) now live in `advisory_positions`; `positions` is the fund's own book.
 * This copies the legacy advisory rows across so the advisory book, its factor
 * exposures and the Horizon scorecard chain carry on from the last pull.
 *
 * Nothing is deleted or overwritten: `positions` is only read, and a market
 * that already has advisory rows is skipped. The legacy rows stay in
 * `positions` (readers ignore them) until the operator removes them.
 *
 * Run with: npx tsx --env-file=.env.local scripts/copy-advisory-positions.ts
 */
import { db, DB, ID, Query } from "./agents/appwrite";
import { isFundPosition, type Position } from "../src/lib/appwrite/schema";

const FIELDS = [
  "ticker", "qty", "avg_cost", "market_value", "unrealized_pnl", "weight",
  "factor_exposures_json", "market", "ibkr_account_id", "horizon_source", "label",
] as const;

async function listAll(col: string): Promise<Position[]> {
  const out: Position[] = [];
  let cursor: string | undefined;
  while (true) {
    const q = [Query.limit(100)];
    if (cursor) q.push(Query.cursorAfter(cursor));
    const page = await db.listDocuments(DB, col, q);
    out.push(...(page.documents as unknown as Position[]));
    if (page.documents.length < 100) break;
    cursor = page.documents[page.documents.length - 1].$id;
  }
  return out;
}

async function main() {
  const [legacy, advisory] = await Promise.all([listAll("positions"), listAll("advisory_positions")]);
  const rows = legacy.filter((p) => !isFundPosition(p));
  const haveMarket = new Set(advisory.map((p) => p.market ?? "US"));
  console.log(`positions: ${legacy.length} rows, ${rows.length} advisory · advisory_positions: ${advisory.length} rows\n`);

  let copied = 0;
  for (const market of ["US", "IN"] as const) {
    const mine = rows.filter((p) => (p.market ?? "US") === market);
    if (haveMarket.has(market)) {
      console.log(`  = ${market}: advisory_positions already has rows — skipped`);
      continue;
    }
    for (const p of mine) {
      const doc: Record<string, unknown> = {};
      for (const k of FIELDS) doc[k] = (p as Record<string, unknown>)[k] ?? null;
      doc.market = market;
      // A legacy Kite row has no column here; it reads as its broker.
      if (!doc.horizon_source && !doc.ibkr_account_id && p.kite_account_id) doc.horizon_source = "Kite";
      await db.createDocument(DB, "advisory_positions", ID.unique(), doc);
      copied++;
    }
    console.log(`  + ${market}: copied ${mine.length}`);
  }
  console.log(`\nDone — ${copied} rows copied. positions untouched.`);
}

main().catch((err) => {
  console.error("Copy failed:", err);
  process.exit(1);
});
