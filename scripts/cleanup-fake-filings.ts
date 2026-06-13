/**
 * Prune filings + memos for tickers that aren't currently on the book.
 *
 * Policy (from operator): the Ingest Queue should only show names the
 * portfolio actually holds. Stale rows — left behind when a position
 * disappeared, or written by the tech-loop's FULL_UNIVERSE fallback before
 * any holdings existed — get deleted.
 *
 * Held tickers are read live from the `positions` collection (both desks).
 * Anything whose ticker isn't in that set goes. Dry-run by default;
 * pass `--yes` to apply.
 *
 * Run: npx tsx scripts/cleanup-fake-filings.ts [--yes]
 */
import { db, DB, Query } from "./agents/appwrite";

const APPLY = process.argv.includes("--yes");

type Doc = { $id: string; ticker?: string; form_type?: string; source_url?: string; filed_at?: string; title?: string; market?: string | null };

async function listAll(coll: string): Promise<Doc[]> {
  const out: Doc[] = [];
  let cursor: string | undefined;
  for (;;) {
    const q = [Query.limit(100)];
    if (cursor) q.push(Query.cursorAfter(cursor));
    const res = await db.listDocuments(DB, coll, q);
    out.push(...(res.documents as unknown as Doc[]));
    if (res.documents.length < 100) break;
    cursor = res.documents[res.documents.length - 1].$id;
  }
  return out;
}

async function heldTickers(): Promise<Set<string>> {
  const rows = await listAll("positions");
  return new Set(rows.map((r) => String(r.ticker ?? "").toUpperCase()).filter(Boolean));
}

async function main() {
  const held = await heldTickers();
  console.log(`held tickers on book: ${held.size}`);

  const filings = await listAll("filings");
  const memos = await listAll("memos");

  const toDelete: { coll: "filings" | "memos"; doc: Doc; reason: string }[] = [];

  for (const f of filings) {
    const ticker = String(f.ticker ?? "").toUpperCase();
    if (!ticker) {
      toDelete.push({ coll: "filings", doc: f, reason: "no ticker" });
      continue;
    }
    if (!held.has(ticker)) toDelete.push({ coll: "filings", doc: f, reason: "ticker off-book" });
  }

  // Memos with a ticker get the same treatment. Untickered memos (cross-cutting
  // notes) are left alone.
  for (const m of memos) {
    const ticker = String(m.ticker ?? "").toUpperCase();
    if (!ticker) continue;
    if (!held.has(ticker)) toDelete.push({ coll: "memos", doc: m, reason: "ticker off-book" });
  }

  console.log(`\nplan (${APPLY ? "APPLY" : "dry-run"}):`);
  for (const t of toDelete) {
    const tk = t.doc.ticker ?? "—";
    const ft = t.doc.form_type ?? t.doc.title ?? "";
    console.log(`  ${t.coll.padEnd(7)} ${tk.padEnd(12)} ${ft.padEnd(18)} — ${t.reason}  [${t.doc.$id}]`);
  }
  console.log(`\ntotal: ${toDelete.length}`);

  if (!APPLY) {
    console.log("\nno changes made. Re-run with --yes to delete.");
    return;
  }

  let ok = 0;
  for (const t of toDelete) {
    try {
      await db.deleteDocument(DB, t.coll, t.doc.$id);
      ok++;
    } catch (err) {
      console.warn(`  failed ${t.coll}/${t.doc.$id}: ${(err as Error).message}`);
    }
  }
  console.log(`deleted ${ok} / ${toDelete.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
