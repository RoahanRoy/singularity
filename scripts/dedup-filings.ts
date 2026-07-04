/**
 * Collapse duplicate `filings` rows down to one per disclosure.
 *
 * Before dedup existed, the tech/india loops wrote a fresh filings row every
 * cycle for the same disclosure, so a held name accumulated many rows sharing
 * one (ticker, source_url). This prunes each such group to a single survivor.
 *
 * Survivor rule (keep the most useful, delete the rest):
 *   1. a row that carries a stored `summary` (so the parser keeps reusing it);
 *   2. failing that, the most recently created row.
 *
 * Groups of size 1 are left untouched. Dry-run by default; pass `--yes` to
 * apply. Deletes only exact duplicates — never the last row for a disclosure.
 *
 * Run: npx tsx scripts/dedup-filings.ts [--yes]
 */
import { db, DB, Query } from "./agents/appwrite";

const APPLY = process.argv.includes("--yes");

type Doc = {
  $id: string;
  $createdAt: string;
  ticker?: string;
  form_type?: string;
  source_url?: string;
  summary?: string | null;
};

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

/** Pick the row to keep: summarized first, then newest. */
function chooseSurvivor(rows: Doc[]): Doc {
  const summarized = rows.filter((r) => r.summary && r.summary.length > 0);
  const pool = summarized.length ? summarized : rows;
  return pool.reduce((best, r) => (r.$createdAt > best.$createdAt ? r : best));
}

async function main() {
  const filings = await listAll("filings");
  console.log(`filings rows total: ${filings.length}`);

  // Group by disclosure identity. Rows without a ticker+source_url can't be
  // deduped safely, so they're skipped (left as-is).
  const groups = new Map<string, Doc[]>();
  for (const f of filings) {
    const ticker = String(f.ticker ?? "").toUpperCase();
    const url = String(f.source_url ?? "");
    if (!ticker || !url) continue;
    const key = `${ticker}|${url}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(f);
  }

  const toDelete: { doc: Doc; key: string }[] = [];
  let dupGroups = 0;
  for (const [key, rows] of groups) {
    if (rows.length < 2) continue;
    dupGroups++;
    const keep = chooseSurvivor(rows);
    for (const r of rows) if (r.$id !== keep.$id) toDelete.push({ doc: r, key });
  }

  console.log(`\nduplicate disclosure groups: ${dupGroups}`);
  console.log(`plan (${APPLY ? "APPLY" : "dry-run"}) — delete ${toDelete.length}, keep one per group:`);
  for (const t of toDelete) {
    const tk = (t.doc.ticker ?? "—").padEnd(12);
    const ft = (t.doc.form_type ?? "").padEnd(12);
    console.log(`  del ${tk} ${ft} [${t.doc.$id}]`);
  }

  if (!APPLY) {
    console.log(`\nno changes made. Re-run with --yes to delete ${toDelete.length} duplicate rows.`);
    return;
  }

  let ok = 0;
  for (const t of toDelete) {
    try {
      await db.deleteDocument(DB, "filings", t.doc.$id);
      ok++;
    } catch (err) {
      console.warn(`  failed filings/${t.doc.$id}: ${(err as Error).message}`);
    }
  }
  console.log(`\ndeleted ${ok} / ${toDelete.length} duplicate filings.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
