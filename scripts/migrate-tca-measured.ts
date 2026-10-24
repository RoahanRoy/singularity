/**
 * Additive schema migration — TCA measured in code.
 *
 * TCA is now computed from the arrival quote the PM sized against and the
 * fill (scripts/agents/nodes.ts). `venue_score` was an LLM's composite with no
 * measured meaning, so the code writes null; this makes the attribute
 * optional. Nothing is deleted and existing rows keep their values.
 *
 * Idempotent: does nothing once the attribute is already optional.
 *
 * Run with: tsx scripts/migrate-tca-measured.ts
 */
import { db, DB } from "./agents/appwrite";

type Attr = { key: string; required?: boolean };

async function main() {
  console.log(`Migrating database "${DB}" — tca.venue_score optional\n`);
  const col = (await db.getCollection(DB, "tca")) as unknown as { attributes: Attr[] };
  const attr = col.attributes.find((a) => a.key === "venue_score");
  if (!attr) {
    console.error("  ! tca.venue_score not found — run restore-schema.mjs first");
    process.exit(1);
  }
  if (!attr.required) {
    console.log("  = tca.venue_score is already optional");
  } else {
    await db.updateFloatAttribute(DB, "tca", "venue_score", false, null as unknown as number);
    console.log("  ~ tca.venue_score → optional");
  }
  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
