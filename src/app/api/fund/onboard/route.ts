import { createAdminClient, DATABASE_ID, requireOperator } from "@/lib/appwrite/server";
import type { Market } from "@/lib/appwrite/schema";
import { getMandate, upsertMandate } from "@/lib/fund/mandate";
import { appendRiskBudget, getRiskBudget } from "@/lib/fund/budget-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Build-a-portfolio-from-scratch onboarding.
 *
 * GET  -> current mandates and risk budgets for both desks (null where unset).
 * POST -> create or update a desk's mandate. Onboarding a new desk seeds
 *         cash = capital_base (nothing deployed yet); re-onboarding updates the
 *         capital base and preserves cash unless the operator sends an explicit
 *         `cash` override to reconcile the book (clamped to base). A
 *         `target_te_pct` appends a risk budget (the target tracking error vs
 *         the desk index every limit derives from); a desk without one needs it.
 *
 * POST { market: "US"|"IN", capital_base: number, target_te_pct?: number,
 *        cash?: number, note?: string }
 */
type Body = { market?: string; capital_base?: unknown; target_te_pct?: unknown; note?: string; cash?: unknown };

function isMarket(v: unknown): v is Market {
  return v === "US" || v === "IN";
}

export async function GET(req: Request) {
  const denied = await requireOperator(req);
  if (denied) return denied;
  const { databases } = createAdminClient();
  const [us, inn, usBudget, inBudget] = await Promise.all([
    getMandate(databases, DATABASE_ID, "US"),
    getMandate(databases, DATABASE_ID, "IN"),
    getRiskBudget(databases, DATABASE_ID, "US"),
    getRiskBudget(databases, DATABASE_ID, "IN"),
  ]);
  return Response.json({ ok: true, mandates: { US: us, IN: inn }, budgets: { US: usBudget, IN: inBudget } });
}

export async function POST(req: Request) {
  const denied = await requireOperator(req);
  if (denied) return denied;
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const market = body.market;
  const capital = Number(body.capital_base);

  if (!isMarket(market)) {
    return Response.json({ error: `market must be "US" or "IN", got ${JSON.stringify(body.market)}` }, { status: 400 });
  }
  if (!Number.isFinite(capital) || capital <= 0) {
    return Response.json({ error: `capital_base must be a positive number, got ${JSON.stringify(body.capital_base)}` }, { status: 400 });
  }

  // Optional undeployed-cash override (honored only when updating an existing
  // mandate; upsertMandate clamps it to [0, capital_base]). Reject clearly if it
  // exceeds the base so the operator sees why rather than a silent clamp.
  let cash: number | undefined;
  if (body.cash !== undefined && body.cash !== null && body.cash !== "") {
    cash = Number(body.cash);
    if (!Number.isFinite(cash) || cash < 0) {
      return Response.json({ error: `cash must be a non-negative number, got ${JSON.stringify(body.cash)}` }, { status: 400 });
    }
    if (cash > capital) {
      return Response.json({ error: `cash (${cash}) can't exceed capital_base (${capital})` }, { status: 400 });
    }
  }

  let target: number | null = null;
  if (body.target_te_pct !== undefined && body.target_te_pct !== null && body.target_te_pct !== "") {
    target = Number(body.target_te_pct) / 100;
    if (!(target > 0 && target < 1)) {
      return Response.json({ error: `target_te_pct must be a percentage in (0, 100), got ${JSON.stringify(body.target_te_pct)}` }, { status: 400 });
    }
  }

  const { databases } = createAdminClient();
  const current = await getRiskBudget(databases, DATABASE_ID, market);
  if (target === null && !current) {
    return Response.json({ error: `the ${market} desk has no risk budget yet; send target_te_pct` }, { status: 400 });
  }
  const note = typeof body.note === "string" ? body.note.slice(0, 512) : undefined;
  const { mandate, created } = await upsertMandate(databases, DATABASE_ID, {
    market,
    capital_base: capital,
    note,
    cash,
  });
  // Unchanged target, no new row: the budget's history records changes only.
  const budget = target === null || target === current?.target_te
    ? current
    : await appendRiskBudget(databases, DATABASE_ID, market, target, "operator", note);

  return Response.json({ ok: true, created, mandate, budget });
}
