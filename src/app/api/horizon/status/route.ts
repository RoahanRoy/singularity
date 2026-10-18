import { horizonConfigured } from "@/lib/horizon/client";
import { horizonBookStatus } from "@/lib/horizon/sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Is Horizon the book source, and what has it put on each desk? The Portfolio
 * screen reads this to decide between the Horizon panel and the direct
 * Kite / IBKR panels.
 */
export async function GET() {
  if (!horizonConfigured()) return Response.json({ configured: false });
  try {
    return Response.json({ configured: true, ...(await horizonBookStatus()) });
  } catch (err) {
    return Response.json({ configured: true, error: (err as Error).message });
  }
}
