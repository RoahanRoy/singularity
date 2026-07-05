/**
 * Onboard a from-scratch paper fund for a desk — the terminal path to the same
 * mandate the /api/fund/onboard route writes. No brokerage needed: name a
 * capital base and a risk posture and the desk loop starts deploying it.
 *
 * Seeding a *new* desk sets cash = capital_base. Re-running for an existing desk
 * updates posture/caps/capital base but preserves already-deployed cash (never
 * resets the book). All writes are additive/idempotent.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/onboard-fund.ts <US|IN> <capital> [posture] [note]
 * Examples:
 *   npx tsx --env-file=.env.local scripts/onboard-fund.ts US 1000000 balanced
 *   npx tsx --env-file=.env.local scripts/onboard-fund.ts IN 50000000 aggressive "diwali book"
 */
import { db, DB } from "./agents/appwrite";
import { upsertMandate, isRiskPosture, POSTURE_CAPS, deployableThisCycle } from "../src/lib/fund/mandate";
import type { Market } from "../src/lib/appwrite/schema";

function usage(msg: string): never {
  console.error(`Error: ${msg}\n`);
  console.error("Usage: onboard-fund.ts <US|IN> <capital> [conservative|balanced|aggressive] [note]");
  process.exit(1);
}

async function main() {
  const [marketArg, capArg, postureArg = "balanced", ...noteParts] = process.argv.slice(2);
  const market = (marketArg || "").toUpperCase() as Market;
  if (market !== "US" && market !== "IN") usage(`market must be US or IN, got "${marketArg}"`);
  const capital = Number(capArg);
  if (!Number.isFinite(capital) || capital <= 0) usage(`capital must be a positive number, got "${capArg}"`);
  if (!isRiskPosture(postureArg)) usage(`posture must be conservative|balanced|aggressive, got "${postureArg}"`);
  const note = noteParts.join(" ").trim() || undefined;

  const caps = POSTURE_CAPS[postureArg];
  console.log(`Onboarding ${market} fund — ${capital.toLocaleString()} ${market === "US" ? "USD" : "INR"}, ${postureArg}`);
  console.log(`  caps → max ${caps.max_names} names, ≤${caps.max_name_weight_pct}%/name, ≤${caps.max_gross_pct}% gross, ${caps.deploy_cap_pct_per_cycle}%/cycle pacing\n`);

  const { mandate, created } = await upsertMandate(db, DB, {
    market, capital_base: capital, risk_posture: postureArg, note,
  });

  console.log(`${created ? "Created" : "Updated"} mandate ${mandate.$id}`);
  console.log(`  cash undeployed: ${mandate.cash.toLocaleString()} ${mandate.currency}`);
  console.log(`  deployable next cycle: ${deployableThisCycle(mandate).toLocaleString()} ${mandate.currency}`);
  console.log(`\nStart the desk loop and it will deploy this capital as convictions clear.`);
}

main().catch((err) => { console.error(err); process.exit(1); }).finally(() => process.exit(0));
