import { AGENT_NAMES, getStatus, startAgent, stopAgent, type AgentName } from "@/lib/agents/supervisor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = { name?: string; action?: string };

function isAgentName(s: string): s is AgentName {
  return (AGENT_NAMES as string[]).includes(s);
}

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const name = body.name;
  const action = body.action;
  if (!name || !isAgentName(name)) {
    return Response.json({ error: `unknown agent: ${name}` }, { status: 400 });
  }
  if (action !== "start" && action !== "stop" && action !== "restart") {
    return Response.json({ error: `unknown action: ${action}` }, { status: 400 });
  }

  if (action === "start") return Response.json({ status: startAgent(name) });
  if (action === "stop") return Response.json({ status: stopAgent(name) });
  // restart
  stopAgent(name);
  // tiny delay so SIGTERM propagates before respawn
  await new Promise((r) => setTimeout(r, 250));
  return Response.json({ status: startAgent(name) });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const name = url.searchParams.get("name");
  if (!name || !isAgentName(name)) {
    return Response.json({ error: `unknown agent: ${name}` }, { status: 400 });
  }
  return Response.json({ status: getStatus(name) });
}
