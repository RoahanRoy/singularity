import { horizonConfigured } from "@/lib/horizon/client";
import { HORIZON_LOOP_MAX_AGE_MS, syncHorizon } from "@/lib/horizon/sync";
import { requireOperator } from "@/lib/appwrite/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Horizon resolves fund NAVs on a cold cache before it answers.
export const maxDuration = 60;

/**
 * Re-pull the real book from Horizon onto both desks. Backs the "Sync now"
 * button (always pulls) and the India desk loop, which calls `?loop=1` every
 * cycle and so only re-pulls once the book is HORIZON_LOOP_MAX_AGE_MS old. The
 * US loop reaches the same sync through /api/ibkr/sync, which delegates here
 * while Horizon is configured.
 */
export async function POST(req: Request) {
  const denied = await requireOperator(req, { allowMachine: true });
  if (denied) return denied;
  if (!horizonConfigured()) {
    return Response.json({ error: "HORIZON_URL / HORIZON_EXPORT_TOKEN are not set" }, { status: 503 });
  }
  const loop = new URL(req.url).searchParams.has("loop");
  try {
    const result = await syncHorizon(loop ? { maxAgeMs: HORIZON_LOOP_MAX_AGE_MS } : {});
    const ok = result.status === "synced" || result.status === "fresh";
    return Response.json({ result }, { status: ok ? 200 : 502 });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}
