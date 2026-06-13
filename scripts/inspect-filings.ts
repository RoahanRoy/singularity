/** Quick inspect: dump filings for the listed tickers. */
import { db, DB, Query } from "./agents/appwrite";

const TICKERS = (process.argv.slice(2).length ? process.argv.slice(2) : ["AVGO", "GLD", "TSM"]).map((t) => t.toUpperCase());

async function main() {
  for (const t of TICKERS) {
    const res = await db.listDocuments(DB, "filings", [Query.equal("ticker", t), Query.limit(25)]);
    console.log(`\n=== ${t} (${res.documents.length}) ===`);
    for (const d of res.documents as unknown as { $id: string; form_type: string; filed_at: string; source_url: string; status: string; market?: string; $createdAt: string }[]) {
      console.log(`  ${d.$id}  ${d.form_type.padEnd(8)} filed ${d.filed_at?.slice(0, 10)}  ingested ${d.$createdAt?.slice(0, 16)}  status=${d.status}  market=${d.market ?? "—"}`);
      console.log(`    src: ${d.source_url?.slice(0, 110)}`);
    }
  }
  const pos = await db.listDocuments(DB, "positions", [Query.limit(200)]);
  const held = new Set((pos.documents as unknown as { ticker: string }[]).map((p) => p.ticker.toUpperCase()));
  console.log(`\nheld book (${held.size}): ${[...held].sort().join(", ")}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
