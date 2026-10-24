/**
 * Reads and writes of the operator's valuation assumptions
 * (`valuation_assumptions`): per desk, the equity risk premium, terminal
 * growth and the dividend-model growth cap (valuation.ts), append-only, the
 * latest `set_at` applying. Like budget-store.ts it takes a `Databases`
 * instance, so the agent loop and any server route share it.
 */
import { ID, Query, type Databases } from "node-appwrite";
import { COLLECTIONS, type Market, type ValuationAssumptionsRow } from "@/lib/appwrite/schema";
import type { ChosenAssumptions } from "./valuation";

export type AssumptionsRow = Pick<ValuationAssumptionsRow, "market" | "erp" | "terminal_growth" | "max_stable_growth" | "set_at" | "set_by" | "note">;

const fraction = (x: unknown, lo: number, hi: number) => typeof x === "number" && Number.isFinite(x) && x >= lo && x < hi;

/** Why the values can't be stored, or null when they can. */
export function invalidAssumptions(c: ChosenAssumptions): string | null {
  if (!(fraction(c.erp, 0, 0.2) && c.erp > 0)) return `ERP ${c.erp} is not a fraction in (0, 0.2)`;
  if (!fraction(c.terminalGrowth, 0, 0.15)) return `terminal growth ${c.terminalGrowth} is not a fraction in [0, 0.15)`;
  if (!fraction(c.maxStableGrowth, 0, 0.2)) return `dividend growth cap ${c.maxStableGrowth} is not a fraction in [0, 0.2)`;
  return null;
}

export const chosenOf = (r: AssumptionsRow): ChosenAssumptions => ({
  erp: r.erp, terminalGrowth: r.terminal_growth, maxStableGrowth: r.max_stable_growth,
});

/** The desk's current assumptions, or null before the operator has set them. */
export async function getAssumptions(db: Databases, dbId: string, market: Market): Promise<AssumptionsRow | null> {
  const res = await db.listDocuments(dbId, COLLECTIONS.valuation_assumptions, [
    Query.equal("market", market),
    Query.orderDesc("set_at"),
    Query.limit(1),
  ]);
  const row = res.documents[0] as unknown as AssumptionsRow | undefined;
  return row && !invalidAssumptions(chosenOf(row)) ? row : null;
}

/** Record new assumptions for the desk. Appends; earlier rows stay as history. */
export async function appendAssumptions(
  db: Databases,
  dbId: string,
  market: Market,
  chosen: ChosenAssumptions,
  setBy: string,
  note?: string,
): Promise<AssumptionsRow> {
  const bad = invalidAssumptions(chosen);
  if (bad) throw new Error(bad);
  const row: AssumptionsRow = {
    market, erp: chosen.erp, terminal_growth: chosen.terminalGrowth, max_stable_growth: chosen.maxStableGrowth,
    set_at: new Date().toISOString(), set_by: setBy, note: note ?? null,
  };
  await db.createDocument(dbId, COLLECTIONS.valuation_assumptions, ID.unique(), row);
  return row;
}
