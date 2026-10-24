/**
 * Onboard a from-scratch paper fund for a desk — the terminal path to the same
 * mandate and risk budget the /api/fund/onboard route writes. No brokerage
 * needed: name a capital base and the target tracking error against the desk
 * index that every trading limit derives from (src/lib/fund/risk-budget.ts),
 * and the desk loop starts deploying it.
 *
 * Seeding a *new* desk sets cash = capital_base. Re-running for an existing desk
 * updates the capital base but preserves already-deployed cash (never resets
 * the book). A target appends a risk_budgets row; leave it out to keep the
 * desk's current budget (a desk with none needs one).
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/onboard-fund.ts <US|IN> <capital> [targetTePct] [note]
 * Examples:
 *   npx tsx --env-file=.env.local scripts/onboard-fund.ts US 1000000 6
 *   npx tsx --env-file=.env.local scripts/onboard-fund.ts IN 50000000 6 "diwali book"
 */
import { db, DB } from "./agents/appwrite";
import { upsertMandate, deployableCash } from "../src/lib/fund/mandate";
import { appendRiskBudget, getRiskBudget } from "../src/lib/fund/budget-store";
import { lagLimit, Z99 } from "../src/lib/fund/risk-budget";
import { TRADING_DAYS } from "../src/lib/quant/risk";
import type { Market } from "../src/lib/appwrite/schema";

function usage(msg: string): never {
  console.error(`Error: ${msg}\n`);
  console.error("Usage: onboard-fund.ts <US|IN> <capital> [targetTePct] [note]");
  process.exit(1);
}

const pct = (x: number) => `${(x * 100).toFixed(2)}%`;

async function main() {
  const [marketArg, capArg, targetArg, ...noteParts] = process.argv.slice(2);
  const market = (marketArg || "").toUpperCase() as Market;
  if (market !== "US" && market !== "IN") usage(`market must be US or IN, got "${marketArg}"`);
  const capital = Number(capArg);
  if (!Number.isFinite(capital) || capital <= 0) usage(`capital must be a positive number, got "${capArg}"`);
  const target = targetArg === undefined ? null : Number(targetArg) / 100;
  if (target !== null && !(target > 0 && target < 1)) usage(`target tracking error must be a percentage in (0, 100), got "${targetArg}"`);
  const note = noteParts.join(" ").trim() || undefined;

  const current = await getRiskBudget(db, DB, market);
  if (target === null && !current) usage(`the ${market} desk has no risk budget yet; give a target tracking error`);

  console.log(`Onboarding ${market} fund — ${capital.toLocaleString()} ${market === "US" ? "USD" : "INR"}\n`);
  const { mandate, created } = await upsertMandate(db, DB, { market, capital_base: capital, note });
  const budget = target === null ? current! : await appendRiskBudget(db, DB, market, target, "operator", note);

  console.log(`${created ? "Created" : "Updated"} mandate ${mandate.$id}`);
  console.log(`  cash undeployed: ${deployableCash(mandate).toLocaleString()} ${mandate.currency}`);
  console.log(`  target tracking error ${pct(budget.target_te)} (${target === null ? `set ${budget.set_at}` : "set now"})`);
  console.log(`  lag halt after a month ${pct(lagLimit(budget.target_te, 21))}, after a year ${pct(lagLimit(budget.target_te, TRADING_DAYS))}`);
  console.log(`  day-loss halt: ${Z99.toFixed(3)} × (index vol + ${pct(budget.target_te)}) / √${TRADING_DAYS}, index vol measured each session`);
  console.log(`\nStart the desk loop and it will deploy this capital as convictions clear.`);
}

main().catch((err) => { console.error(err); process.exit(1); }).finally(() => process.exit(0));
