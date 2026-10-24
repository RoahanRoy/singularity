/**
 * Set or show the desk's risk budget: the target annual tracking error
 * against the desk index that every trading limit is derived from
 * (src/lib/fund/risk-budget.ts). Setting appends a row; earlier rows stay as
 * the record of what applied when.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/set-risk-budget.ts                 show both desks
 *   npx tsx --env-file=.env.local scripts/set-risk-budget.ts US 6 ["note"]   target 6% TE on the US desk
 */
import { loadBudget, setBudget } from "./agents/risk-budget";
import { lagLimit, Z99 } from "../src/lib/fund/risk-budget";
import { TRADING_DAYS } from "../src/lib/quant/risk";

type Market = "US" | "IN";

const pct = (x: number) => `${(x * 100).toFixed(2)}%`;

function describe(market: Market, t: number) {
  console.log(`${market}: target tracking error ${pct(t)}`);
  console.log(`  lag halt after a month ${pct(lagLimit(t, 21))}, after a year ${pct(lagLimit(t, TRADING_DAYS))}`);
  console.log(`  day-loss halt: ${Z99.toFixed(3)} × (index vol + ${pct(t)}) / √${TRADING_DAYS}, index vol measured each session`);
}

async function main() {
  const [m, target, ...rest] = process.argv.slice(2);
  if (!m) {
    for (const market of ["US", "IN"] as const) {
      const b = await loadBudget(market);
      if (!b) console.log(`${market}: no risk budget set; the desk stages every trade`);
      else {
        describe(market, b.target_te);
        console.log(`  set ${b.set_at} by ${b.set_by}${b.note ? ` · ${b.note}` : ""}`);
      }
    }
    return;
  }
  const market = m.toUpperCase();
  if (market !== "US" && market !== "IN") throw new Error(`market ${m} is not US or IN`);
  const t = Number(target) / 100;
  if (!(t > 0 && t < 1)) throw new Error(`target ${target} is not a percentage in (0, 100)`);
  const row = await setBudget(market, t, "operator", rest.join(" ") || undefined);
  describe(market, row.target_te);
  console.log(`  set ${row.set_at}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
