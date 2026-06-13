/**
 * Remove seed/fake filings (and the seed memo) for tickers NOT in the book.
 *
 * Anything on the book stays — even if it was seed-shaped — so the Research
 * Engine keeps a backdrop for held names until the agents repopulate.
 *
 * Targets:
 *   1. US filings whose `source_url` isn't an http(s) URL (seed.ts batch).
 *   2. IN filings dated 2026-04 with one of the seed-canned form_types
 *      (Q-Results / Bd-Meeting / Press-Rel / PIT-Discl / Shareholding /
 *      AGM-Notice) sourced from nse/bse landing pages — i.e. the
 *      seed-india-filings.ts batch.
 *   3. The seed memo "TSM — Q4 print, demand softness signal".
 *
 * Dry-run by default. Pass `--yes` to actually delete.
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

const SEED_IN_FORMS = new Set(["Q-Results", "Bd-Meeting", "Press-Rel", "PIT-Discl", "Shareholding", "AGM-Notice"]);

function isUsFakeFiling(f: Doc): boolean {
  const url = f.source_url ?? "";
  return !/^https?:\/\//i.test(url);
}

function isInSeedFiling(f: Doc): boolean {
  const form = f.form_type ?? "";
  const url = f.source_url ?? "";
  const filed = f.filed_at ?? "";
  return (
    SEED_IN_FORMS.has(form) &&
    /(nseindia|bseindia)\.com/i.test(url) &&
    filed.startsWith("2026-04")
  );
}

async function main() {
  const held = await heldTickers();
  console.log(`held tickers on book: ${held.size}`);

  const filings = await listAll("filings");
  const memos = await listAll("memos");

  const toDelete: { coll: "filings" | "memos"; doc: Doc; reason: string }[] = [];

  for (const f of filings) {
    const ticker = String(f.ticker ?? "").toUpperCase();
    if (held.has(ticker)) continue;
    if (isUsFakeFiling(f)) toDelete.push({ coll: "filings", doc: f, reason: "US seed (non-URL source)" });
    else if (isInSeedFiling(f)) toDelete.push({ coll: "filings", doc: f, reason: "IN seed (April-26 canned)" });
  }

  for (const m of memos) {
    const ticker = String(m.ticker ?? "").toUpperCase();
    if (held.has(ticker)) continue;
    if (m.title === "TSM — Q4 print, demand softness signal") {
      toDelete.push({ coll: "memos", doc: m, reason: "TSM seed memo" });
    }
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
