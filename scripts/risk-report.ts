/**
 * Measure and store the portfolio risk report now (scripts/agents/portfolio-risk.ts).
 * The desk loops do this on their own each session; this is the by-hand run.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/risk-report.ts [US|IN] [fund|advisory]
 * With no arguments, both desks and both books.
 */
import { reportRisk, type RiskBook } from "./agents/portfolio-risk";

type Market = "US" | "IN";

const pct = (x: number) => `${(x * 100).toFixed(2)}%`;

async function main() {
  const args = process.argv.slice(2).map((a) => a.toLowerCase());
  const markets = (["US", "IN"] as const).filter((m) => !args.some((a) => a === "us" || a === "in") || args.includes(m.toLowerCase()));
  const books = (["fund", "advisory"] as const).filter((b) => !args.some((a) => a === "fund" || a === "advisory") || args.includes(b));
  for (const market of markets as Market[]) {
    for (const book of books as RiskBook[]) {
      const run = await reportRisk(market, book);
      if (run.status === "skipped") {
        console.log(`${market} ${book}: skipped (${run.reason})`);
        continue;
      }
      const r = run.report;
      console.log(`${market} ${book} · ${run.session} · NAV ${r.nav.toFixed(0)} · window ${r.window.start}..${r.window.end}`);
      console.log(`  cash ${pct(r.cash_weight)} · measured ${pct(r.measured_weight)} · unmeasured ${pct(r.unmeasured_weight)}${r.unmeasured.length ? ` (${r.unmeasured.map((u) => u.ticker).join(", ")})` : ""}`);
      console.log(`  vol ${pct(r.vol_annual)} · VaR95 ${pct(r.var95.parametric)} / hist ${pct(r.var95.historical)} · ES95 ${pct(r.es95.parametric)} / hist ${pct(r.es95.historical)} · VaR99 ${pct(r.var99.parametric)}`);
      console.log(`  beta ${r.beta.toFixed(2)} · TE ${pct(r.tracking_error)} · index vol ${pct(r.index_vol)} · shrinkage ${r.shrinkage.toFixed(2)}`);
      for (const s of r.stress) console.log(`  ${s.label} ${s.peak}..${s.trough}: index ${pct(s.index_return)}, book ${pct(s.book_return)} (uncovered ${pct(s.uncovered_weight)})`);
      const top = r.names.slice(0, 5).map((n) => `${n.ticker} ${pct(n.risk_share)}`).join(", ");
      if (top) console.log(`  top risk: ${top}`);
      const slow = r.names.filter((n) => n.adv_days != null).sort((a, b) => b.adv_days! - a.adv_days!)[0];
      if (slow) console.log(`  least liquid: ${slow.ticker} ${slow.adv_days!.toPrecision(2)} days of ADV`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
