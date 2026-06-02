/**
 * One-shot India (Kite) book enrichment from free Yahoo Finance history, so the
 * Portfolio screen's India desk shows real numbers (factor betas, NAV series /
 * KPIs, stress scenarios) instead of empty / zero panels.
 *
 * The implementation lives in src/lib/india/enrich.ts and is shared with the
 * weekly Vercel cron route (/api/cron/enrich-india). This wrapper just supplies
 * the script's node-appwrite admin client and prints a progress trace.
 *
 * Run:  npx tsx --env-file=.env.local scripts/enrich-india.ts
 */
import { db, DB } from "./agents/appwrite";
import { runIndiaEnrichment } from "../src/lib/india/enrich";

async function main() {
  console.log(`Enriching India book in "${DB}" from Yahoo Finance…\n`);
  const summary = await runIndiaEnrichment(db, DB, (m) => console.log(m));
  console.log("\nDone:", JSON.stringify(summary, null, 2));
  console.log("Refresh the Portfolio screen on the India desk.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
