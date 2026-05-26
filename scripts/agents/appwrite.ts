/**
 * Appwrite helpers for the agent loop. Server-only (uses API key).
 */
import dotenv from "dotenv";
import { Client, Databases, ID, Query } from "node-appwrite";

dotenv.config({ path: ".env.local" });
dotenv.config(); // fall back to .env if .env.local missing

const endpoint = process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT!;
const projectId = process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID!;
const apiKey = process.env.APPWRITE_API_KEY!;
export const DB = process.env.NEXT_PUBLIC_APPWRITE_DATABASE_ID || "meridian";

if (!endpoint || !projectId || !apiKey) {
  throw new Error("Missing Appwrite env vars (endpoint / project id / api key)");
}

const client = new Client().setEndpoint(endpoint).setProject(projectId).setKey(apiKey);
export const db = new Databases(client);
export { ID, Query };

/**
 * Resolve a stable agent doc by name — creates it under the Tech cluster on
 * first run so the Swarm screen lights up with our seven agents.
 */
export async function ensureAgent(name: string, role: "research" | "execution" | "risk" | "ops") {
  const existing = await db.listDocuments(DB, "agents", [Query.equal("name", name), Query.limit(1)]);
  if (existing.documents[0]) return existing.documents[0].$id;

  const cluster = await ensureCluster("Tech — Equities US", "equities");
  const doc = await db.createDocument(DB, "agents", ID.unique(), {
    name,
    role,
    cluster_id: cluster,
    status: "idle",
    model: "claude-sonnet-4-6",
    conviction: 0,
    last_action_at: null,
  });
  return doc.$id;
}

async function ensureCluster(name: string, theme: string) {
  const existing = await db.listDocuments(DB, "clusters", [Query.equal("name", name), Query.limit(1)]);
  if (existing.documents[0]) return existing.documents[0].$id;
  const doc = await db.createDocument(DB, "clusters", ID.unique(), {
    name, theme, agent_count: 7, health: 0.9,
  });
  return doc.$id;
}

export async function emit(
  agentId: string,
  kind: "thought" | "tool_call" | "trade" | "memo" | "alert" | "handoff",
  summary: string,
  payload?: unknown,
) {
  await db.createDocument(DB, "agent_events", ID.unique(), {
    agent_id: agentId,
    cluster_id: null,
    kind,
    summary: summary.slice(0, 240),
    payload_json: payload ? JSON.stringify(payload).slice(0, 4000) : null,
    occurred_at: new Date().toISOString(),
  });
  console.log(`[${kind}] ${summary}`);
}

export async function setStatus(agentId: string, status: "idle" | "thinking" | "executing" | "blocked") {
  await db.updateDocument(DB, "agents", agentId, {
    status,
    last_action_at: new Date().toISOString(),
  });
}

/**
 * Append a row to budget_ledger. Non-fatal — failures are logged and swallowed
 * so a ledger outage never breaks the agent loop.
 */
export async function recordSpend(
  category: "llm" | "data" | "compute" | "venue_fees",
  provider: string,
  amountUsd: number,
  meta?: unknown,
): Promise<void> {
  if (!Number.isFinite(amountUsd) || amountUsd < 0) return;
  try {
    await db.createDocument(DB, "budget_ledger", ID.unique(), {
      category,
      provider,
      amount_usd: Number(amountUsd.toFixed(6)),
      meta_json: meta ? JSON.stringify(meta).slice(0, 4000) : null,
      occurred_at: new Date().toISOString(),
    });
  } catch (err) {
    console.warn(`[budget] failed to record ${category} $${amountUsd}:`, (err as Error).message);
  }
}
