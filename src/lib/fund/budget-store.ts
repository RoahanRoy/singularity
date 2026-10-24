/**
 * Reads and writes of the operator's risk budget (`risk_budgets`): one target
 * tracking error per desk, append-only, the latest `set_at` applying. Like
 * mandate.ts it takes a `Databases` instance, so the onboarding API (admin
 * client) and the agent loop (scripts client) share it. The limits derived
 * from it are in risk-budget.ts.
 */
import { ID, Query, type Databases } from "node-appwrite";
import { COLLECTIONS, type Market, type RiskBudget } from "@/lib/appwrite/schema";

export type RiskBudgetRow = Pick<RiskBudget, "market" | "target_te" | "set_at" | "set_by" | "note">;

/** The desk's current risk budget, or null before the operator has set one. */
export async function getRiskBudget(db: Databases, dbId: string, market: Market): Promise<RiskBudgetRow | null> {
  const res = await db.listDocuments(dbId, COLLECTIONS.risk_budgets, [
    Query.equal("market", market),
    Query.orderDesc("set_at"),
    Query.limit(1),
  ]);
  const row = res.documents[0] as unknown as RiskBudgetRow | undefined;
  return row && Number.isFinite(row.target_te) && row.target_te > 0 ? row : null;
}

/** Record a new budget for the desk (a fraction, 0.06 = 6%). Appends; earlier rows stay as history. */
export async function appendRiskBudget(
  db: Databases,
  dbId: string,
  market: Market,
  targetTe: number,
  setBy: string,
  note?: string,
): Promise<RiskBudgetRow> {
  if (!(targetTe > 0 && targetTe < 1)) throw new Error(`target tracking error ${targetTe} is not a fraction in (0, 1)`);
  const row: RiskBudgetRow = { market, target_te: targetTe, set_at: new Date().toISOString(), set_by: setBy, note: note ?? null };
  await db.createDocument(dbId, COLLECTIONS.risk_budgets, ID.unique(), row);
  return row;
}
