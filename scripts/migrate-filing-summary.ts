/**
 * Additive schema migration — persist the filing summary.
 *
 * Adds a single optional `summary` string attribute to the `filings`
 * collection so the parser can store the LLM summary once and reuse it,
 * instead of re-summarizing the same disclosure every cycle.
 *
 * Idempotent and non-destructive: it only creates the attribute if missing,
 * never drops or overwrites anything. Existing rows read back as summary=null.
 *
 * Run with: tsx scripts/migrate-filing-summary.ts
 */
import { db, DB } from "./agents/appwrite";

type Existing = { attributes: { key: string; status?: string }[] };

async function getExisting(col: string): Promise<Existing | null> {
  try {
    const c = (await db.getCollection(DB, col)) as unknown as Existing;
    return { attributes: c.attributes ?? [] };
  } catch (err) {
    // Only a genuine 404 means "collection missing"; anything else (paused
    // project, bad key, network) must surface — don't mislabel it as not found.
    const e = err as { code?: number; type?: string; message?: string };
    if (e.code === 404 || e.type === "collection_not_found") return null;
    throw err;
  }
}

async function main() {
  console.log(`Migrating database "${DB}" — filings.summary\n`);
  const ex = await getExisting("filings");
  if (!ex) {
    console.error("  ! collection filings not found — run restore-schema.mjs first");
    process.exit(1);
  }
  if (ex.attributes.some((a) => a.key === "summary")) {
    console.log("  = filings.summary exists");
  } else {
    // 8192 chars — comfortably fits a filing summary; optional so legacy rows
    // (and ingest-held's metadata-only rows) stay valid with summary=null.
    await db.createStringAttribute(DB, "filings", "summary", 8192, false);
    console.log("  + filings.summary");
  }
  console.log("\nDone. (Re-run any time; it only creates what's missing.)");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
