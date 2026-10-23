/**
 * MERIDIAN — storage retention for the Appwrite Free plan (2 GB cap).
 *
 * The daily quant sweep writes ~38 quant_reports rows per name, ~6,500 a day
 * across both desks, which would fill the plan's storage in a few months.
 * This trims them on a rolling window:
 *
 *   - every agent's row is kept for MERIDIAN_RETAIN_QUANT_DETAIL_D days (14)
 *   - the three head rows per cycle (the Quant screen's list and history) are
 *     kept for MERIDIAN_RETAIN_QUANT_HEAD_D days (90)
 *
 * Dry run by default: prints what would go. Pass --apply to delete.
 *
 * Run: npm run agents:retention [-- --apply]
 */
import { db, DB, Query, flushQuota } from "./appwrite";

const APPLY = process.argv.includes("--apply");
const DETAIL_D = Number(process.env.MERIDIAN_RETAIN_QUANT_DETAIL_D || 14);
const HEAD_D = Number(process.env.MERIDIAN_RETAIN_QUANT_HEAD_D || 90);
// Mirrors QUANT_HEAD_AGENTS in src/lib/appwrite/queries.ts.
const HEADS = ["market-data-reader", "fundamentals-screener", "ensemble-combiner"];

const ago = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();

async function trim(label: string, queries: string[]): Promise<number> {
  const { total } = await db.listDocuments(DB, "quant_reports", [...queries, Query.limit(1)]);
  console.log(`[retention] quant_reports ${label}: ${total} row(s) ${APPLY ? "deleting" : "would go"}`);
  if (APPLY && total) await db.deleteDocuments(DB, "quant_reports", queries);
  return total;
}

async function main() {
  const detail = await trim(`non-head rows older than ${DETAIL_D}d`, [
    // notEqual takes one value; AND one per head agent.
    Query.lessThan("run_at", ago(DETAIL_D)), ...HEADS.map((a) => Query.notEqual("agent", a)),
  ]);
  const head = await trim(`head rows older than ${HEAD_D}d`, [
    Query.lessThan("run_at", ago(HEAD_D)), Query.equal("agent", HEADS),
  ]);
  if (!APPLY && detail + head) console.log("[retention] dry run: pass --apply to delete");
}

main().then(async () => {
  await flushQuota();
  process.exit(0);
}, (e) => {
  console.error(e);
  process.exit(1);
});
