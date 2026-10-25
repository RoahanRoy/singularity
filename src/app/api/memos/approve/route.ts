import { ID } from "node-appwrite";
import { createAdminClient, DATABASE_ID, requireOperator } from "@/lib/appwrite/server";
import { COLLECTIONS } from "@/lib/appwrite/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Operator approval for a staged trade.
 *
 * The chain holds a fully-sized, risk-cleared trade as a memo in status
 * "review" with pending_exec_json. This route only flips the memo's status —
 * approve -> "approved" (the laptop desk loop's sweep then executes the fill,
 * since serverless has no broker/quote access), or reject -> "rejected".
 * undo takes an approval back ("approved" -> "review") while the sweep hasn't
 * filled it yet; once executed there is nothing to undo. Every decision is
 * written to the audit log.
 *
 * POST { memoId: string, action: "approve" | "reject" | "undo", reason?: string }
 * (a decline's reason, kept in the audit row)
 */
type Body = { memoId?: string; action?: string; reason?: string };

type MemoRow = { status?: string; ticker?: string | null; pending_exec_json?: string | null };

const FROM: Record<"approve" | "reject" | "undo", string> = { approve: "review", reject: "review", undo: "approved" };

export async function POST(req: Request) {
  const denied = await requireOperator(req);
  if (denied) return denied;
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const memoId = body.memoId?.trim();
  const action = body.action;
  if (!memoId) return Response.json({ error: "memoId is required" }, { status: 400 });
  if (action !== "approve" && action !== "reject" && action !== "undo") {
    return Response.json({ error: `unknown action: ${action}` }, { status: 400 });
  }

  const { databases } = createAdminClient();

  let memo: MemoRow;
  try {
    memo = (await databases.getDocument(DATABASE_ID, COLLECTIONS.memos, memoId)) as unknown as MemoRow;
  } catch {
    return Response.json({ error: `memo not found: ${memoId}` }, { status: 404 });
  }

  // Only a staged memo can be decided, and only an unexecuted approval undone.
  // Guards against double-approval races and approving something that never
  // held a trade.
  if (memo.status !== FROM[action]) {
    return Response.json(
      { error: `memo is "${memo.status}", not "${FROM[action]}" — nothing to ${action}` },
      { status: 409 },
    );
  }
  if (action !== "reject" && !memo.pending_exec_json) {
    return Response.json(
      { error: "memo has no staged trade to execute (flagged for review only)" },
      { status: 409 },
    );
  }

  const patch =
    action === "approve"
      ? { status: "approved" } // keep pending_exec_json; the loop sweep consumes it
      : action === "undo"
        ? { status: "review" }
        : { status: "rejected", pending_exec_json: null };

  const updated = (await databases.updateDocument(
    DATABASE_ID,
    COLLECTIONS.memos,
    memoId,
    patch,
  )) as unknown as MemoRow;

  const qty = (() => {
    try {
      return Number(JSON.parse(memo.pending_exec_json ?? "{}").qty) || null;
    } catch {
      return null;
    }
  })();
  const order = `buy ${qty ?? "?"} ${memo.ticker ?? memoId}`;
  const verb = { approve: "Approved", reject: "Declined", undo: "Undid approval of" }[action];
  const why = typeof body.reason === "string" && body.reason.trim() ? `: ${body.reason.trim().slice(0, 300)}` : "";
  try {
    await databases.createDocument(DATABASE_ID, COLLECTIONS.audit_log, ID.unique(), {
      actor: "operator",
      action: `operator_${action}`,
      target: memo.ticker ?? memoId,
      decision: action === "reject" ? "block" : "allow",
      detail: `${verb} ${order} (memo ${memoId})${why}`,
      occurred_at: new Date().toISOString(),
    });
  } catch {
    // The decision stands; a missed audit row is only a gap in the record.
  }

  return Response.json({ ok: true, memoId, status: updated.status });
}
