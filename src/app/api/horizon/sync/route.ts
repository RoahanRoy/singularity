import { requireOperator } from "@/lib/appwrite/server";
import { horizonConfigured } from "@/lib/horizon/client";
import { syncHorizon } from "@/lib/horizon/sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Horizon resolves fund NAVs on a cold cache before it answers.
export const maxDuration = 60;

/**
 * Re-pull the real book from Horizon onto both desks, now. Backs the "Sync
 * now" button. The desk loops reach the same sync through /api/kite/sync and
 * /api/ibkr/sync, which delegate to it (throttled) while Horizon is configured.
 */
export async function POST(req: Request) {
  const denied = await requireOperator(req, { allowMachine: true });
  if (denied) return denied;
  if (!horizonConfigured()) {
    return Response.json({ error: "HORIZON_URL / HORIZON_EXPORT_TOKEN are not set" }, { status: 503 });
  }
  try {
    const result = await syncHorizon();
    return Response.json({ result }, { status: result.status === "synced" ? 200 : 502 });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}
