import { syncAccount, syncAllAccounts } from "@/lib/ibkr/sync";
import { requireOperator } from "@/lib/appwrite/server";
import { horizonConfigured } from "@/lib/horizon/client";
import { HORIZON_LOOP_MAX_AGE_MS, syncHorizon } from "@/lib/horizon/sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Room for the Horizon pull this route delegates to when Horizon is configured.
export const maxDuration = 60;

/**
 * Re-pull positions for one account (POST { accountId }) or all accounts
 * (no body). Backs the "Sync now" button and the US agent loop. `accountId`
 * here is the Appwrite document id (matches the sync function's argument).
 */
export async function POST(req: Request) {
  const denied = await requireOperator(req, { allowMachine: true });
  if (denied) return denied;
  // Horizon carries these holdings when configured; a direct IBKR pull
  // would put them on the book twice. The desk loop still calls this route
  // every cycle, so it refreshes the book from Horizon instead.
  if (horizonConfigured()) {
    const result = await syncHorizon({ maxAgeMs: HORIZON_LOOP_MAX_AGE_MS });
    const ok = result.status === "synced" || result.status === "fresh";
    return Response.json({ source: "horizon", result }, { status: ok ? 200 : 502 });
  }

  let accountId: string | undefined;
  try {
    const body = (await req.json()) as { accountId?: string };
    accountId = body.accountId;
  } catch {
    // no body → sync all
  }

  try {
    if (accountId) {
      const result = await syncAccount(accountId);
      return Response.json({ result });
    }
    const results = await syncAllAccounts();
    return Response.json({ results });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}
