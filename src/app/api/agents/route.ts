import { allStatuses } from "@/lib/agents/supervisor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ agents: allStatuses() });
}
