/**
 * Fund mandate — the "build a portfolio from scratch" backbone.
 *
 * A mandate is how the fund manages capital with *no brokerage attached*: the
 * operator names a capital base and a risk posture per desk, and the desk loop
 * deploys that capital into names as convictions clear. The mandate carries the
 * undeployed `cash` balance (debited as paper buys fill) and the posture-derived
 * caps that steer sizing and pace.
 *
 * This module is deliberately free of `server-only` and takes a `Databases`
 * instance as a parameter, so it is shared by the Next onboarding API (admin
 * client) and the laptop agent loop (scripts/agents client) alike — one source
 * of truth for mandate reads/writes and the posture→caps mapping.
 */
import { ID, Query, type Databases } from "node-appwrite";
import { COLLECTIONS, type FundMandate, type Market, type RiskPosture } from "@/lib/appwrite/schema";

export const CURRENCY_FOR: Record<Market, string> = { US: "USD", IN: "INR" };

/**
 * Posture → guardrails. These are the *defaults* written at onboarding; the
 * operator can later tune the stored values without changing the posture label.
 *  - max_names: how concentrated the book runs.
 *  - max_name_weight_pct / max_gross_pct: sizing ceilings (percent of NAV).
 *  - deploy_cap_pct_per_cycle: how fast capital is put to work (pacing), as a
 *    percent of capital_base deployable in any single research cycle.
 */
export const POSTURE_CAPS: Record<RiskPosture, {
  max_names: number;
  max_name_weight_pct: number;
  max_gross_pct: number;
  deploy_cap_pct_per_cycle: number;
}> = {
  conservative: { max_names: 25, max_name_weight_pct: 6,  max_gross_pct: 90,  deploy_cap_pct_per_cycle: 3 },
  balanced:     { max_names: 20, max_name_weight_pct: 9,  max_gross_pct: 100, deploy_cap_pct_per_cycle: 5 },
  aggressive:   { max_names: 15, max_name_weight_pct: 14, max_gross_pct: 120, deploy_cap_pct_per_cycle: 8 },
};

export function isRiskPosture(v: unknown): v is RiskPosture {
  return v === "conservative" || v === "balanced" || v === "aggressive";
}

/** The active mandate for a desk, or null if the fund hasn't been onboarded. */
export async function getMandate(
  db: Databases,
  dbId: string,
  market: Market,
): Promise<FundMandate | null> {
  const res = await db.listDocuments(dbId, COLLECTIONS.fund_mandate, [
    Query.equal("market", market),
    Query.limit(1),
  ]);
  return (res.documents[0] as unknown as FundMandate) ?? null;
}

export type OnboardInput = {
  market: Market;
  capital_base: number;
  risk_posture: RiskPosture;
  note?: string;
};

/**
 * Create the desk's mandate, or update posture/note on an existing one.
 *
 * Onboarding a *new* desk seeds `cash = capital_base` (nothing deployed yet).
 * Re-onboarding an existing desk updates the posture-derived caps and the
 * capital base but preserves the already-deployed cash position — it never
 * silently resets the book. Resetting to a clean slate is a separate, explicit
 * operator action (see resetMandateCash) so we can't wipe deployed capital by
 * accident.
 */
export async function upsertMandate(
  db: Databases,
  dbId: string,
  input: OnboardInput,
): Promise<{ mandate: FundMandate; created: boolean }> {
  const caps = POSTURE_CAPS[input.risk_posture];
  const existing = await getMandate(db, dbId, input.market);
  const base = {
    market: input.market,
    currency: CURRENCY_FOR[input.market],
    capital_base: input.capital_base,
    risk_posture: input.risk_posture,
    ...caps,
    status: "active" as const,
    note: input.note ?? null,
  };

  if (existing) {
    const doc = await db.updateDocument(dbId, COLLECTIONS.fund_mandate, existing.$id, base);
    return { mandate: doc as unknown as FundMandate, created: false };
  }
  const doc = await db.createDocument(dbId, COLLECTIONS.fund_mandate, ID.unique(), {
    ...base,
    cash: input.capital_base, // nothing deployed yet
    seeded_at: new Date().toISOString(),
  });
  return { mandate: doc as unknown as FundMandate, created: true };
}

/**
 * How much cash the desk may deploy on this cycle: the lesser of the undeployed
 * balance and the per-cycle pacing cap (a percent of the capital base). Returns
 * 0 when there's no mandate, so a mandate-less desk is unaffected by pacing.
 */
export function deployableThisCycle(m: FundMandate | null): number {
  if (!m || m.status !== "active") return 0;
  const paceCap = m.capital_base * (m.deploy_cap_pct_per_cycle / 100);
  return Math.max(0, Math.min(m.cash, paceCap));
}

/** Debit deployed capital from the mandate's undeployed cash (floored at 0). */
export async function debitCash(
  db: Databases,
  dbId: string,
  mandate: FundMandate,
  amount: number,
): Promise<number> {
  const next = Math.max(0, Number((mandate.cash - amount).toFixed(2)));
  await db.updateDocument(dbId, COLLECTIONS.fund_mandate, mandate.$id, { cash: next });
  return next;
}
