/**
 * Set or show the desk's valuation assumptions (src/lib/quant/assumption-store.ts):
 * the equity risk premium over the long risk-free rate (cost of equity =
 * rf + β × ERP), the perpetual growth after the DCF's forecast years, and the
 * most a dividend may grow forever in the dividend model. Setting appends a
 * row; earlier rows stay as the record of what applied when. The quant stage
 * doesn't run on a desk without them.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/set-valuation-assumptions.ts                       show both desks
 *   npx tsx --env-file=.env.local scripts/set-valuation-assumptions.ts US 4.5 2.5 4 ["note"]  ERP, terminal growth, dividend cap in %
 */
import { db, DB } from "./agents/appwrite";
import { appendAssumptions, getAssumptions, type AssumptionsRow } from "../src/lib/quant/assumption-store";

const pct = (x: number) => `${(x * 100).toFixed(2)}%`;

function describe(r: AssumptionsRow) {
  console.log(`${r.market}: ERP ${pct(r.erp)} · terminal growth ${pct(r.terminal_growth)} · dividend growth cap ${pct(r.max_stable_growth)}`);
  console.log(`  set ${r.set_at} by ${r.set_by}${r.note ? ` · ${r.note}` : ""}`);
}

async function main() {
  const [m, erp, g, cap, ...rest] = process.argv.slice(2);
  if (!m) {
    for (const market of ["US", "IN"] as const) {
      const r = await getAssumptions(db, DB, market);
      if (r) describe(r);
      else console.log(`${market}: no valuation assumptions set; the quant stage is skipped on this desk`);
    }
    return;
  }
  const market = m.toUpperCase();
  if (market !== "US" && market !== "IN") throw new Error(`market ${m} is not US or IN`);
  const nums = [erp, g, cap].map((x) => Number(x) / 100);
  if (nums.some((x) => !Number.isFinite(x))) throw new Error("give ERP, terminal growth and dividend growth cap, each in %");
  const [e, tg, mg] = nums;
  describe(await appendAssumptions(db, DB, market, { erp: e, terminalGrowth: tg, maxStableGrowth: mg }, "operator", rest.join(" ") || undefined));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
