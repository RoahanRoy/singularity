import { ID, Query } from "node-appwrite";
import { createAdminClient, DATABASE_ID, requireOperator } from "@/lib/appwrite/server";
import { COLLECTIONS, type ConstructionPlan, type ConstructionPlanPayload } from "@/lib/appwrite/schema";
import {
  CORE_APPROVAL_COLLECTION,
  coreApprovalId,
  parseCoreApproval,
  type CoreApproval,
} from "@/lib/fund/core-approval";
import type { Market } from "@/lib/meridian/format";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The operator's approval of the fund's index-core rebalance.
 *
 * GET ?market=US|IN → { approval } (the desk's latest, any status, or null).
 * POST { market, action: "approve", planId } approves the core line of the
 * desk's latest fund plan, which must be the plan the operator was looking at.
 * POST { market, action: "undo" } withdraws an approval no run has filled.
 * A desk run fills it (scripts/agents/core.ts); serverless has no quotes or
 * broker. Every decision is written to the audit log.
 */
type Body = { market?: string; action?: string; planId?: string };

const isMarket = (m: unknown): m is Market => m === "US" || m === "IN";

async function readApproval(market: Market): Promise<CoreApproval | null> {
  const { databases } = createAdminClient();
  try {
    const doc = await databases.getDocument(DATABASE_ID, CORE_APPROVAL_COLLECTION, coreApprovalId(market));
    return parseCoreApproval((doc as unknown as { value_json?: string }).value_json);
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  const denied = await requireOperator(req);
  if (denied) return denied;
  const market = new URL(req.url).searchParams.get("market");
  if (!isMarket(market)) return Response.json({ error: "market must be US or IN" }, { status: 400 });
  return Response.json({ approval: await readApproval(market) });
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
  const { market, action } = body;
  if (!isMarket(market)) return Response.json({ error: "market must be US or IN" }, { status: 400 });
  if (action !== "approve" && action !== "undo") return Response.json({ error: `unknown action: ${action}` }, { status: 400 });

  const { databases } = createAdminClient();
  const current = await readApproval(market);
  let next: CoreApproval;

  if (action === "undo") {
    if (current?.status !== "approved") {
      return Response.json({ error: "no open core approval to undo" }, { status: 409 });
    }
    next = { ...current, status: "withdrawn", done_at: new Date().toISOString(), detail: "withdrawn by the operator" };
  } else {
    const res = await databases.listDocuments(DATABASE_ID, COLLECTIONS.construction_plans, [
      Query.equal("market", market),
      Query.equal("book", "fund"),
      Query.orderDesc("captured_at"),
      Query.limit(1),
    ]);
    const plan = res.documents[0] as unknown as ConstructionPlan | undefined;
    if (!plan) return Response.json({ error: `no ${market} fund plan stored` }, { status: 409 });
    if (plan.$id !== body.planId) {
      return Response.json({ error: "the plan changed since you loaded it: reload and check the trade again" }, { status: 409 });
    }
    let payload: ConstructionPlanPayload;
    try {
      payload = JSON.parse(plan.plan_json) as ConstructionPlanPayload;
    } catch {
      return Response.json({ error: "the stored plan can't be read" }, { status: 409 });
    }
    const line = (payload.lines ?? []).find((l) => l.role === "core" && l.shares != null && l.shares !== 0);
    if (!line || line.shares == null) return Response.json({ error: "the plan has no core trade to approve" }, { status: 409 });
    next = {
      status: "approved",
      ticker: line.ticker,
      side: line.shares > 0 ? "buy" : "sell",
      max_shares: Math.abs(line.shares),
      plan_id: plan.$id,
      plan_session: plan.session,
      approved_at: new Date().toISOString(),
    };
  }

  await databases.upsertDocument(DATABASE_ID, CORE_APPROVAL_COLLECTION, coreApprovalId(market), {
    value_json: JSON.stringify(next),
  });

  try {
    await databases.createDocument(DATABASE_ID, COLLECTIONS.audit_log, ID.unique(), {
      actor: "operator",
      action: action === "approve" ? "operator_approve" : "operator_undo",
      target: next.ticker,
      decision: "allow",
      detail:
        action === "approve"
          ? `Approved the ${market} core rebalance: ${next.side} up to ${next.max_shares} ${next.ticker} (plan ${next.plan_session}), filled at the next desk run`
          : `Withdrew the ${market} core rebalance approval (${next.side} ${next.max_shares} ${next.ticker})`,
      occurred_at: new Date().toISOString(),
    });
  } catch {
    // The decision stands; a missed audit row is only a gap in the record.
  }

  return Response.json({ approval: next });
}
