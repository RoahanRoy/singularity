/**
 * Additive schema migration — persist a staged trade's execution payload.
 *
 * Adds an optional `pending_exec_json` string attribute to `memos`. When the
 * chain sizes and clears a trade but AUTO_APPROVE is off, the broker holds the
 * fill and stores the sized decision here, so operator approval can execute the
 * fill without re-running the LLM analysis chain.
 *
 * Idempotent and non-destructive: creates the attribute only if missing. The
 * "executed" memo status needs no migration — status is a free-form string.
 *
 * Run with: tsx scripts/migrate-memo-pending.ts
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
  console.log(`Migrating database "${DB}" — memos.pending_exec_json\n`);
  const ex = await getExisting("memos");
  if (!ex) {
    console.error("  ! collection memos not found — run restore-schema.mjs first");
    process.exit(1);
  }
  if (ex.attributes.some((a) => a.key === "pending_exec_json")) {
    console.log("  = memos.pending_exec_json exists");
  } else {
    await db.createStringAttribute(DB, "memos", "pending_exec_json", 2048, false);
    console.log("  + memos.pending_exec_json");
  }
  console.log("\nDone. (Re-run any time; it only creates what's missing.)");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
