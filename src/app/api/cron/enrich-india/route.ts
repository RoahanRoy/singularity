import { createAdminClient, DATABASE_ID } from "@/lib/appwrite/server";
import { runIndiaEnrichment } from "@/lib/india/enrich";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Enrichment fetches ~34 Yahoo histories + writes betas/snapshots; give it room.
export const maxDuration = 60;

/**
 * Weekly India-book enrichment, invoked by Vercel Cron (see vercel.json).
 *
 * Vercel attaches `Authorization: Bearer ${CRON_SECRET}` to cron requests when
 * the CRON_SECRET env var is set, so we require it — this also lets you trigger
 * a manual run with the same bearer token. If CRON_SECRET is unset we refuse
 * rather than expose an unauthenticated write endpoint.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return Response.json({ error: "CRON_SECRET not configured" }, { status: 503 });
  }
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const { databases } = createAdminClient();
    const summary = await runIndiaEnrichment(databases, DATABASE_ID);
    return Response.json({ ok: true, at: new Date().toISOString(), summary });
  } catch (err) {
    return Response.json({ ok: false, error: (err as Error).message }, { status: 500 });
  }
}
