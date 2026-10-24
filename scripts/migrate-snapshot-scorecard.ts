/**
 * Additive schema migration — the recorded book-vs-index track.
 *
 * Adds two optional double attributes to `fund_snapshots`, written by each
 * Horizon pull (src/lib/fund/scorecard.ts):
 *   - book_index:  the flow-free running book level (starts at 100),
 *   - index_level: the desk's index (S&P 500 / Nifty 50) at the same pull.
 *
 * Idempotent and non-destructive: creates the attributes only if missing.
 * Existing rows keep both null; the track starts at the next pull.
 *
 * Run with: tsx scripts/migrate-snapshot-scorecard.ts
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
  console.log(`Migrating database "${DB}" — fund_snapshots.book_index, index_level\n`);
  const ex = await getExisting("fund_snapshots");
  if (!ex) {
    console.error("  ! collection fund_snapshots not found — run restore-schema.mjs first");
    process.exit(1);
  }
  for (const key of ["book_index", "index_level"]) {
    if (ex.attributes.some((a) => a.key === key)) {
      console.log(`  = fund_snapshots.${key} exists`);
    } else {
      await db.createFloatAttribute(DB, "fund_snapshots", key, false);
      console.log(`  + fund_snapshots.${key}`);
    }
  }
  console.log("\nDone. (Re-run any time; it only creates what's missing.)");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
