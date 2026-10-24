/**
 * Fund mandate — the "build a portfolio from scratch" backbone.
 *
 * A mandate is how the fund manages capital with *no brokerage attached*: the
 * operator names a capital base per desk, and the desk loop deploys that
 * capital into names as convictions clear. The mandate carries the undeployed
 * `cash` balance (debited as paper buys fill). Sizing and halts are not here:
 * they derive from the desk's risk budget (risk-budget.ts, budget-store.ts).
 *
 * This module is deliberately free of `server-only` and takes a `Databases`
 * instance as a parameter, so it is shared by the Next onboarding API (admin
 * client) and the laptop agent loop (scripts/agents client) alike — one source
 * of truth for mandate reads/writes.
 */
import { ID, Query, type Databases } from "node-appwrite";
import { COLLECTIONS, type FundMandate, type Market } from "@/lib/appwrite/schema";

export const CURRENCY_FOR: Record<Market, string> = { US: "USD", IN: "INR" };

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
  note?: string;
  /**
   * Optional undeployed-cash override. Only honored when *updating* an existing
   * mandate — it lets the operator reconcile the book's cash directly (e.g. after
   * lowering the capital base) instead of editing the database by hand. Clamped
   * to [0, capital_base]. Ignored on a fresh onboard, where cash = capital_base.
   */
  cash?: number;
};

/**
 * Create the desk's mandate, or update the capital base/note on an existing one.
 *
 * Onboarding a *new* desk seeds `cash = capital_base` (nothing deployed yet).
 * Re-onboarding an existing desk updates the capital base but preserves the
 * already-deployed cash position — it never
 * silently resets the book. Resetting to a clean slate is a separate, explicit
 * operator action (see resetMandateCash) so we can't wipe deployed capital by
 * accident.
 */
export async function upsertMandate(
  db: Databases,
  dbId: string,
  input: OnboardInput,
): Promise<{ mandate: FundMandate; created: boolean }> {
  const existing = await getMandate(db, dbId, input.market);
  const base = {
    market: input.market,
    currency: CURRENCY_FOR[input.market],
    capital_base: input.capital_base,
    status: "active" as const,
    note: input.note ?? null,
  };

  if (existing) {
    // Reconcile cash only when explicitly provided; clamp to [0, capital_base]
    // so an override can never strand cash above the (possibly lowered) base.
    const patch: Record<string, unknown> = { ...base };
    if (typeof input.cash === "number" && Number.isFinite(input.cash)) {
      patch.cash = Math.max(0, Math.min(input.capital_base, Number(input.cash.toFixed(2))));
    }
    const doc = await db.updateDocument(dbId, COLLECTIONS.fund_mandate, existing.$id, patch);
    return { mandate: doc as unknown as FundMandate, created: false };
  }
  const doc = await db.createDocument(dbId, COLLECTIONS.fund_mandate, ID.unique(), {
    ...base,
    cash: input.capital_base, // nothing deployed yet
    seeded_at: new Date().toISOString(),
  });
  return { mandate: doc as unknown as FundMandate, created: true };
}

/** The cash the desk can deploy: the mandate's undeployed balance, 0 without an active mandate. */
export function deployableCash(m: FundMandate | null): number {
  return m && m.status === "active" ? Math.max(0, m.cash) : 0;
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
