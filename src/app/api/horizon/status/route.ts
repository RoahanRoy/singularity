import { horizonConfigured } from "@/lib/horizon/client";
import { horizonBookStatus } from "@/lib/horizon/sync";
import { requireOperator } from "@/lib/appwrite/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Is Horizon the book source, and what has it put on each desk? The Portfolio
 * screen reads this to decide between the Horizon panel and the direct IBKR
 * panel.
 */
export async function GET(req: Request) {
  const denied = await requireOperator(req);
  if (denied) return denied;
  if (!horizonConfigured()) return Response.json({ configured: false });
  try {
    return Response.json({ configured: true, ...(await horizonBookStatus()) });
  } catch (err) {
    return Response.json({ configured: true, error: (err as Error).message });
  }
}
