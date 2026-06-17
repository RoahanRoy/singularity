/**
 * MERIDIAN — held-book filings keep-alive.
 *
 * Walks the `positions` collection (both US and IN books) and tops up the
 * `filings` collection with the latest disclosure for each held ticker, so the
 * Research Engine's Ingest Queue always has rows for whatever's actually on
 * the book. No LLM, no analyst chain — pure HTTP fetch + Appwrite upsert.
 *
 * Dedup: a filing is identified by (ticker, source_url). Re-runs are no-ops
 * unless a new filing has appeared on the exchange.
 *
 * US: SEC EDGAR via the existing fetchLatestFiling() reader (10-K/10-Q/8-K).
 * IN: NSE corporate-announcements via fetchLatestIndiaFiling() (see india.ts).
 *     NSE bot-walls/rate-limits, so a fetch failure skips the ticker (no
 *     synthetic placeholder row) — same contract as the US path.
 *
 * Run: npm run agents:ingest          # loop, default 30m between sweeps
 *      MERIDIAN_INGEST_ONCE=1 npm run agents:ingest   # single sweep
 *
 * Env knobs:
 *   MERIDIAN_INGEST_ONCE              run a single sweep and exit
 *   MERIDIAN_INGEST_INTERVAL_MS       sleep between sweeps (default 1_800_000)
 *   MERIDIAN_INGEST_ERROR_BACKOFF_MS  sleep after a failed sweep (default 60_000)
 */
import { db, DB, Query, ID } from "./appwrite";
import { fetchLatestFiling } from "./edgar";
import { fetchLatestIndiaFiling } from "./india";

const RUN_ONCE = process.env.MERIDIAN_INGEST_ONCE === "1";
const INTERVAL_MS = Number(process.env.MERIDIAN_INGEST_INTERVAL_MS || 30 * 60_000);
const ERROR_BACKOFF_MS = Number(process.env.MERIDIAN_INGEST_ERROR_BACKOFF_MS || 60_000);

let stopping = false;
function requestStop(sig: string) {
  if (stopping) process.exit(0);
  stopping = true;
  console.log(`\n[ingest] ${sig} received — finishing current sweep, then stopping…`);
}
process.on("SIGTERM", () => requestStop("SIGTERM"));
process.on("SIGINT", () => requestStop("SIGINT"));

function sleep(ms: number): Promise<void> {
  // No unref() here — between sweep iterations the only pending handle is this
  // timer, so unref'd would let Node exit silently before the sleep resolves.
  return new Promise((resolve) => {
    const done = () => { clearTimeout(t); clearInterval(iv); resolve(); };
    const t = setTimeout(done, ms);
    const iv = setInterval(() => { if (stopping) done(); }, 250);
  });
}

type Market = "US" | "IN";

async function heldTickers(market: Market): Promise<string[]> {
  const rows: string[] = [];
  let cursor: string | undefined;
  while (true) {
    const queries = [Query.equal("market", market), Query.limit(100)];
    if (cursor) queries.push(Query.cursorAfter(cursor));
    const page = await db.listDocuments(DB, "positions", queries);
    for (const d of page.documents) {
      const t = String(d.ticker ?? "").trim().toUpperCase();
      if (t) rows.push(t);
    }
    if (page.documents.length < 100) break;
    cursor = page.documents[page.documents.length - 1].$id;
  }
  return Array.from(new Set(rows));
}

/** Skip if a filings row with this (ticker, source_url) already exists. */
async function filingExists(ticker: string, sourceUrl: string): Promise<boolean> {
  const hit = await db.listDocuments(DB, "filings", [
    Query.equal("ticker", ticker),
    Query.equal("source_url", sourceUrl),
    Query.limit(1),
  ]);
  return hit.total > 0;
}

async function ingestUS(ticker: string): Promise<"new" | "dup" | "skip"> {
  let f;
  try {
    f = await fetchLatestFiling(ticker, 1); // 1 char — we only need the metadata
  } catch (err) {
    console.warn(`[ingest US] ${ticker} → ${(err as Error).message}`);
    return "skip";
  }
  if (await filingExists(f.ticker.toUpperCase(), f.source_url)) return "dup";
  const filedIso = /^\d{4}-\d{2}-\d{2}$/.test(f.filed_at)
    ? new Date(f.filed_at + "T00:00:00.000Z").toISOString()
    : new Date(f.filed_at).toISOString();
  await db.createDocument(DB, "filings", ID.unique(), {
    ticker: f.ticker.toUpperCase(),
    form_type: f.form_type,
    filed_at: filedIso,
    source_url: f.source_url,
    status: "indexed",
    vector_id: null,
    market: "US",
  });
  return "new";
}

async function ingestIN(ticker: string): Promise<"new" | "dup" | "skip"> {
  // Fetch the latest real NSE corporate announcement (pure HTTP, see india.ts).
  // NSE bot-walls/rate-limits, so a failure is expected and non-fatal — we skip
  // rather than write a synthetic placeholder, mirroring ingestUS.
  let f;
  try {
    f = await fetchLatestIndiaFiling(ticker, 1); // 1 char — we only need metadata
  } catch (err) {
    console.warn(`[ingest IN] ${ticker} → ${(err as Error).message}`);
    return "skip";
  }
  if (await filingExists(f.ticker.toUpperCase(), f.source_url)) return "dup";
  const filedIso = /^\d{4}-\d{2}-\d{2}$/.test(f.filed_at)
    ? new Date(f.filed_at + "T00:00:00.000Z").toISOString()
    : new Date(f.filed_at).toISOString();
  await db.createDocument(DB, "filings", ID.unique(), {
    ticker: f.ticker.toUpperCase(),
    form_type: f.form_type,
    filed_at: filedIso,
    source_url: f.source_url,
    status: "indexed",
    vector_id: null,
    market: "IN",
  });
  return "new";
}

async function sweep(): Promise<void> {
  const [us, india] = await Promise.all([heldTickers("US"), heldTickers("IN")]);
  console.log(`[ingest] sweep — US held=${us.length} · IN held=${india.length}`);

  let added = 0, dup = 0, skipped = 0;
  for (const t of us) {
    if (stopping) return;
    const r = await ingestUS(t);
    if (r === "new") added++;
    else if (r === "dup") dup++;
    else skipped++;
    await sleep(250); // be polite to SEC (~4 req/s ceiling, well under their 10/s)
  }
  for (const t of india) {
    if (stopping) return;
    const r = await ingestIN(t);
    if (r === "new") added++;
    else if (r === "dup") dup++;
    else skipped++;
  }
  console.log(`[ingest] sweep done — added=${added} dup=${dup} skipped=${skipped}`);
}

async function main() {
  if (RUN_ONCE) {
    await sweep();
    return;
  }
  console.log(`[ingest] continuous mode — ${INTERVAL_MS}ms between sweeps`);
  while (!stopping) {
    try {
      await sweep();
    } catch (err) {
      console.error(`[ingest] sweep failed: ${(err as Error).message}`);
      if (!stopping) await sleep(ERROR_BACKOFF_MS);
      continue;
    }
    if (stopping) break;
    await sleep(INTERVAL_MS);
  }
  console.log(`[ingest] stopped.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
