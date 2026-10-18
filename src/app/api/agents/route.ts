import { allStatuses } from "@/lib/agents/supervisor";
import { requireOperator } from "@/lib/appwrite/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const denied = await requireOperator(req);
  if (denied) return denied;
  return Response.json({ agents: allStatuses() });
}
