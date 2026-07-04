/**
 * One-shot US (IBKR) book enrichment from free Yahoo Finance history, so the
 * Portfolio screen's US desk shows real numbers (factor betas, NAV series /
 * KPIs, stress scenarios) instead of empty / zero panels.
 *
 * The implementation lives in src/lib/us/enrich.ts (config) over the shared
 * src/lib/market/enrich-core.ts, and is shared with the weekly Vercel cron
 * route (/api/cron/enrich-us). This wrapper supplies the node-appwrite admin
 * client and prints a progress trace.
 *
 * Run:  npx tsx --env-file=.env.local scripts/enrich-us.ts
 */
import { db, DB } from "./agents/appwrite";
import { runUsEnrichment } from "../src/lib/us/enrich";

async function main() {
  console.log(`Enriching US book in "${DB}" from Yahoo Finance…\n`);
  const summary = await runUsEnrichment(db, DB, (m) => console.log(m));
  console.log("\nDone:", JSON.stringify(summary, null, 2));
  console.log("Refresh the Portfolio screen on the US desk.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
