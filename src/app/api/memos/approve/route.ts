import { createAdminClient, DATABASE_ID } from "@/lib/appwrite/server";
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
 *
 * POST { memoId: string, action: "approve" | "reject" }
 */
type Body = { memoId?: string; action?: string };

type MemoRow = { status?: string; pending_exec_json?: string | null };

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const memoId = body.memoId?.trim();
  const action = body.action;
  if (!memoId) return Response.json({ error: "memoId is required" }, { status: 400 });
  if (action !== "approve" && action !== "reject") {
    return Response.json({ error: `unknown action: ${action}` }, { status: 400 });
  }

  const { databases } = createAdminClient();

  let memo: MemoRow;
  try {
    memo = (await databases.getDocument(DATABASE_ID, COLLECTIONS.memos, memoId)) as unknown as MemoRow;
  } catch {
    return Response.json({ error: `memo not found: ${memoId}` }, { status: 404 });
  }

  // Only a staged memo can be actioned. Guard against double-approval races and
  // approving something that never held a trade.
  if (memo.status !== "review") {
    return Response.json(
      { error: `memo is "${memo.status}", not "review" — nothing to ${action}` },
      { status: 409 },
    );
  }
  if (action === "approve" && !memo.pending_exec_json) {
    return Response.json(
      { error: "memo has no staged trade to execute (flagged for review only)" },
      { status: 409 },
    );
  }

  const patch =
    action === "approve"
      ? { status: "approved" } // keep pending_exec_json; the loop sweep consumes it
      : { status: "rejected", pending_exec_json: null };

  const updated = (await databases.updateDocument(
    DATABASE_ID,
    COLLECTIONS.memos,
    memoId,
    patch,
  )) as unknown as MemoRow;

  return Response.json({ ok: true, memoId, status: updated.status });
}
