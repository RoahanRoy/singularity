/**
 * Backfill `market="US"` on legacy filings/memos and seed a starter pack of
 * Indian (NSE/BSE) corporate filings so the India desk's Research Engine has
 * real rows to render.
 *
 * Idempotent:
 *   - the backfill skips rows that already have a market tag,
 *   - the IN seed dedupes on (ticker, source_url) so re-runs don't double up.
 *
 * Run: npx tsx scripts/seed-india-filings.ts
 */
import { db, DB, Query, ID } from "./agents/appwrite";

async function backfillMarket(coll: "filings" | "memos") {
  let cursor: string | undefined;
  let patched = 0, scanned = 0;
  while (true) {
    const queries = [Query.limit(100)];
    if (cursor) queries.push(Query.cursorAfter(cursor));
    const page = await db.listDocuments(DB, coll, queries);
    if (page.documents.length === 0) break;
    for (const row of page.documents) {
      scanned++;
      if (!row.market) {
        await db.updateDocument(DB, coll, row.$id, { market: "US" });
        patched++;
      }
    }
    if (page.documents.length < 100) break;
    cursor = page.documents[page.documents.length - 1].$id;
  }
  console.log(`  ${coll}: scanned=${scanned} backfilled=${patched}`);
}

type Seed = {
  ticker: string;
  form_type: string;
  filed_at: string;
  source_url: string;
  status: "queued" | "parsing" | "indexed";
};

// Real NSE/BSE filing landing URLs for prominent listed names. Mix of recent
// disclosures so the Research Engine has heterogeneous form types on the IN
// desk. Dates are recent and within the simulated "now"; status mirrors the
// US desk distribution (most indexed, a couple still parsing).
const IN_FILINGS: Seed[] = [
  {
    ticker: "HDFCBANK",
    form_type: "Q-Results",
    filed_at: "2026-04-19T11:30:00.000Z",
    source_url:
      "https://www.bseindia.com/stock-share-price/hdfc-bank-ltd/HDFCBANK/500180/corp-announcements/",
    status: "indexed",
  },
  {
    ticker: "TCS",
    form_type: "Q-Results",
    filed_at: "2026-04-10T10:45:00.000Z",
    source_url:
      "https://www.nseindia.com/companies-listing/corporate-filings-announcements?symbol=TCS",
    status: "indexed",
  },
  {
    ticker: "RELIANCE",
    form_type: "Bd-Meeting",
    filed_at: "2026-04-22T13:15:00.000Z",
    source_url:
      "https://www.bseindia.com/stock-share-price/reliance-industries-ltd/RELIANCE/500325/corp-announcements/",
    status: "indexed",
  },
  {
    ticker: "INFY",
    form_type: "Press-Rel",
    filed_at: "2026-04-18T09:50:00.000Z",
    source_url:
      "https://www.nseindia.com/companies-listing/corporate-filings-announcements?symbol=INFY",
    status: "indexed",
  },
  {
    ticker: "ICICIBANK",
    form_type: "PIT-Discl",
    filed_at: "2026-04-25T08:20:00.000Z",
    source_url:
      "https://www.bseindia.com/stock-share-price/icici-bank-ltd/ICICIBANK/532174/corp-announcements/",
    status: "parsing",
  },
  {
    ticker: "ITC",
    form_type: "Shareholding",
    filed_at: "2026-04-15T14:05:00.000Z",
    source_url:
      "https://www.bseindia.com/stock-share-price/itc-ltd/ITC/500875/corp-announcements/",
    status: "indexed",
  },
  {
    ticker: "BAJFINANCE",
    form_type: "AGM-Notice",
    filed_at: "2026-04-12T07:30:00.000Z",
    source_url:
      "https://www.nseindia.com/companies-listing/corporate-filings-announcements?symbol=BAJFINANCE",
    status: "indexed",
  },
  {
    ticker: "SUNPHARMA",
    form_type: "Press-Rel",
    filed_at: "2026-04-28T06:40:00.000Z",
    source_url:
      "https://www.bseindia.com/stock-share-price/sun-pharmaceutical-industries-ltd/SUNPHARMA/524715/corp-announcements/",
    status: "parsing",
  },
];

async function seedINFilings() {
  const existing = await db.listDocuments(DB, "filings", [
    Query.equal("market", "IN"),
    Query.limit(200),
  ]);
  const have = new Set(
    (existing.documents as unknown as { ticker: string; source_url: string }[]).map(
      (d) => `${d.ticker}::${d.source_url}`,
    ),
  );
  let added = 0;
  for (const s of IN_FILINGS) {
    const key = `${s.ticker}::${s.source_url}`;
    if (have.has(key)) continue;
    await db.createDocument(DB, "filings", ID.unique(), {
      ticker: s.ticker,
      form_type: s.form_type,
      filed_at: s.filed_at,
      source_url: s.source_url,
      status: s.status,
      vector_id: null,
      market: "IN",
    });
    added++;
  }
  console.log(`  filings(IN): + ${added} (existing ${existing.total})`);
}

async function main() {
  console.log(`Database "${DB}" — IN desk seed + legacy market backfill\n`);
  console.log("backfill market=US on legacy rows:");
  await backfillMarket("filings");
  await backfillMarket("memos");
  console.log("\nseed India filings:");
  await seedINFilings();
  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
