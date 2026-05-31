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

export type ClusterRef = { name: string; theme: string };

const DEFAULT_CLUSTER: ClusterRef = { name: "Tech — Equities US", theme: "equities" };
const CLUSTER_CACHE = new Map<string, string>();

/**
 * Resolve a stable agent doc by name. If the agent exists in a different
 * cluster (e.g. left over from before sector routing), it is rehomed.
 */
export async function ensureAgent(
  name: string,
  role: "research" | "execution" | "risk" | "ops",
  cluster: ClusterRef = DEFAULT_CLUSTER,
) {
  const clusterId = await ensureCluster(cluster.name, cluster.theme);
  const existing = await db.listDocuments(DB, "agents", [Query.equal("name", name), Query.limit(1)]);
  const row = existing.documents[0];
  if (row) {
    if (row.cluster_id !== clusterId) {
      await db.updateDocument(DB, "agents", row.$id, { cluster_id: clusterId });
    }
    return row.$id;
  }
  const doc = await db.createDocument(DB, "agents", ID.unique(), {
    name,
    role,
    cluster_id: clusterId,
    status: "idle",
    model: "claude-sonnet-4-6",
    conviction: 0,
    last_action_at: null,
  });
  return doc.$id;
}

async function ensureCluster(name: string, theme: string) {
  const cached = CLUSTER_CACHE.get(name);
  if (cached) return cached;
  const existing = await db.listDocuments(DB, "clusters", [Query.equal("name", name), Query.limit(1)]);
  if (existing.documents[0]) {
    CLUSTER_CACHE.set(name, existing.documents[0].$id);
    return existing.documents[0].$id;
  }
  const doc = await db.createDocument(DB, "clusters", ID.unique(), {
    name, theme, agent_count: 0, health: 0.9,
  });
  CLUSTER_CACHE.set(name, doc.$id);
  return doc.$id;
}

/**
 * Recompute agent_count on every cluster from the live `agents` collection.
 * Cheap enough to run once per bootstrap — keeps the Swarm panel honest.
 */
export async function recountClusters(): Promise<void> {
  const clusters = await db.listDocuments(DB, "clusters", [Query.limit(100)]);
  for (const c of clusters.documents) {
    const agents = await db.listDocuments(DB, "agents", [
      Query.equal("cluster_id", c.$id),
      Query.limit(1),
    ]);
    if (c.agent_count !== agents.total) {
      await db.updateDocument(DB, "clusters", c.$id, { agent_count: agents.total });
    }
  }
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

/** Built-in fallback used when no risk_limits row exists yet. */
export const DEFAULT_RISK_LIMITS = {
  max_position_weight_pct: 5,
  max_gross_leverage: 1.5,
  daily_var_limit_pct: 3,
  max_name_count: 40,
};

export type RiskLimitValues = typeof DEFAULT_RISK_LIMITS;

/**
 * Read the operator's risk limits, seeding a default row on first run so the
 * operator has something to edit. Falls back to DEFAULT_RISK_LIMITS if the
 * collection is unreachable — the deterministic overlay must always have limits.
 */
export async function ensureRiskLimits(key = "default"): Promise<RiskLimitValues> {
  try {
    const existing = await db.listDocuments(DB, "risk_limits", [Query.equal("key", key), Query.limit(1)]);
    const row = existing.documents[0];
    if (row) {
      return {
        max_position_weight_pct: row.max_position_weight_pct,
        max_gross_leverage: row.max_gross_leverage,
        daily_var_limit_pct: row.daily_var_limit_pct,
        max_name_count: row.max_name_count,
      };
    }
    await db.createDocument(DB, "risk_limits", ID.unique(), {
      key,
      ...DEFAULT_RISK_LIMITS,
      updated_at: new Date().toISOString(),
    });
  } catch (err) {
    console.warn(`[risk] could not load/seed risk_limits, using defaults:`, (err as Error).message);
  }
  return { ...DEFAULT_RISK_LIMITS };
}

/**
 * Append a row to the audit_log. Non-fatal — failures are logged and swallowed
 * so an audit outage never blocks a trade decision (the decision itself still
 * stands; only its paper trail is lost).
 */
export async function writeAudit(
  actor: string,
  action: string,
  target: string,
  decision: "allow" | "block",
  detail: string,
): Promise<void> {
  try {
    await db.createDocument(DB, "audit_log", ID.unique(), {
      actor,
      action,
      target,
      decision,
      detail: detail.slice(0, 4000),
      occurred_at: new Date().toISOString(),
    });
  } catch (err) {
    console.warn(`[audit] failed to record ${action}/${target}:`, (err as Error).message);
  }
}
