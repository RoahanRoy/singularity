/**
 * Build and store the construction plan now (scripts/agents/construct.ts).
 * The desk loops do this on their own with the risk report; this is the
 * by-hand run.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/construction-plan.ts [US|IN] [fund|advisory] [--dry]
 * With no market or book, both. --dry prints the plan without storing it.
 */
import { buildPlan, reportPlan } from "./agents/construct";
import type { PlanBook } from "../src/lib/fund/plan";

type Market = "US" | "IN";

const pct = (x: number | null) => (x == null ? "n/a" : `${(x * 100).toFixed(2)}%`);

async function main() {
  const args = process.argv.slice(2).map((a) => a.toLowerCase());
  const dry = args.includes("--dry");
  const markets = (["US", "IN"] as const).filter((m) => !args.some((a) => a === "us" || a === "in") || args.includes(m.toLowerCase()));
  const books = (["fund", "advisory"] as const).filter((b) => !args.some((a) => a === "fund" || a === "advisory") || args.includes(b));
  for (const market of markets as Market[]) {
    for (const book of books as PlanBook[]) {
      const run = dry ? await buildPlan(market, book) : await reportPlan(market, book);
      if (run.status === "skipped") {
        console.log(`${market} ${book}: skipped (${run.reason})`);
        continue;
      }
      const { plan, before, after, session, core } = run.built;
      console.log(`${market} ${book} · ${session} · NAV ${plan.nav.toFixed(0)} · target TE ${pct(plan.targetTe)} · ${plan.binding}${dry ? " · dry run" : ""}`);
      console.log(`  TE ${pct(before.tracking_error)} → ${pct(after.tracking_error)} · beta ${before.beta.toFixed(2)} → ${after.beta.toFixed(2)} · VaR95 ${pct(before.var95.parametric)} → ${pct(after.var95.parametric)} · α ${pct(plan.alpha)}`);
      for (const l of plan.lines.filter((x) => x.shares !== 0)) {
        console.log(`  ${l.shares > 0 ? "buy " : "sell"} ${Math.abs(l.shares)} ${l.ticker} @ ${l.price.toFixed(2)} (${pct(l.from)} → ${pct(l.toRounded)})${l.role === "core" ? " · core" : ""}`);
      }
      if (!plan.lines.some((x) => x.shares !== 0)) console.log(`  no trades (core ${core})`);
      if (plan.fixed.length) console.log(`  held as is: ${plan.fixed.length} (${pct(plan.fixed.reduce((s, f) => s + f.weight, 0))} of NAV)`);
      if (plan.skipped.length) console.log(`  skipped: ${plan.skipped.map((s) => `${s.ticker} (${s.reason})`).join(", ")}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
