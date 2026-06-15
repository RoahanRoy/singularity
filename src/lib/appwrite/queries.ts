"use client";

import { Query, ID, type Models } from "appwrite";
import { databases, DATABASE_ID, client } from "./client";
import { COLLECTIONS, type Agent, type Cluster, type AgentEvent, type Filing, type Memo, type Position, type Trade, type OperatorMessage, type GovernanceEvent, type BudgetLedger, type Scenario, type FundSnapshot, type RiskLimits, type AuditLog, type AgentCommand, type AgentStatusDoc, type KiteAccount, type IbkrAccount, type Market } from "./schema";

/**
 * Market filter. When a desk is passed we constrain to that desk's rows.
 * Legacy rows are tagged "US" once the schema migration runs, so the US desk
 * stays intact and the India desk only ever sees India-tagged data.
 */
function marketFilter(market?: Market): string[] {
  return market ? [Query.equal("market", market)] : [];
}

export async function listAgents(limit = 200, market?: Market): Promise<Agent[]> {
  const res = await databases.listDocuments<Agent & Models.Document>(
    DATABASE_ID,
    COLLECTIONS.agents,
    [...marketFilter(market), Query.limit(limit)],
  );
  return res.documents;
}

export function subscribeAgents(onChange: (a: Agent) => void) {
  const channel = `databases.${DATABASE_ID}.collections.${COLLECTIONS.agents}.documents`;
  return client.subscribe<Agent & Models.Document>(channel, (msg) => {
    if (msg.events.some((e) => e.endsWith(".create") || e.endsWith(".update"))) {
      onChange(msg.payload);
    }
  });
}

export async function listClusters(market?: Market): Promise<Cluster[]> {
  const res = await databases.listDocuments<Cluster & Models.Document>(
    DATABASE_ID,
    COLLECTIONS.clusters,
    [...marketFilter(market), Query.orderDesc("agent_count"), Query.limit(50)],
  );
  return res.documents;
}

export async function listRecentEvents(limit = 12): Promise<AgentEvent[]> {
  const res = await databases.listDocuments<AgentEvent & Models.Document>(
    DATABASE_ID,
    COLLECTIONS.agent_events,
    [Query.orderDesc("occurred_at"), Query.limit(limit)],
  );
  return res.documents;
}

export function subscribeAgentEvents(onCreate: (ev: AgentEvent) => void) {
  const channel = `databases.${DATABASE_ID}.collections.${COLLECTIONS.agent_events}.documents`;
  return client.subscribe<AgentEvent & Models.Document>(channel, (msg) => {
    if (msg.events.some((e) => e.endsWith(".create"))) {
      onCreate(msg.payload);
    }
  });
}

export async function listFilings(limit = 12, market?: Market): Promise<Filing[]> {
  const res = await databases.listDocuments<Filing & Models.Document>(
    DATABASE_ID,
    COLLECTIONS.filings,
    [...marketFilter(market), Query.orderDesc("$createdAt"), Query.limit(limit)],
  );
  return res.documents;
}

/**
 * Subscribe to new filings, optionally restricted to a desk. Appwrite's
 * realtime channel can't filter server-side, so we drop foreign-desk payloads
 * client-side. Legacy rows without a `market` field are treated as "US".
 */
export function subscribeFilings(onCreate: (f: Filing) => void, market?: Market) {
  const channel = `databases.${DATABASE_ID}.collections.${COLLECTIONS.filings}.documents`;
  return client.subscribe<Filing & Models.Document>(channel, (msg) => {
    if (!msg.events.some((e) => e.endsWith(".create"))) return;
    if (market && (msg.payload.market ?? "US") !== market) return;
    onCreate(msg.payload);
  });
}

export async function listMemos(limit = 6, market?: Market): Promise<Memo[]> {
  const res = await databases.listDocuments<Memo & Models.Document>(
    DATABASE_ID,
    COLLECTIONS.memos,
    [...marketFilter(market), Query.orderDesc("$createdAt"), Query.limit(limit)],
  );
  return res.documents;
}

export async function listPositions(limit = 25, market?: Market): Promise<Position[]> {
  const res = await databases.listDocuments<Position & Models.Document>(
    DATABASE_ID,
    COLLECTIONS.positions,
    [...marketFilter(market), Query.orderDesc("market_value"), Query.limit(limit)],
  );
  return res.documents;
}

export async function listPendingTrades(limit = 10, market?: Market): Promise<Trade[]> {
  const res = await databases.listDocuments<Trade & Models.Document>(
    DATABASE_ID,
    COLLECTIONS.trades,
    [...marketFilter(market), Query.equal("status", "pending"), Query.orderDesc("$createdAt"), Query.limit(limit)],
  );
  return res.documents;
}

export async function listRecentTrades(limit = 50): Promise<Trade[]> {
  const res = await databases.listDocuments<Trade & Models.Document>(
    DATABASE_ID,
    COLLECTIONS.trades,
    [Query.orderDesc("$createdAt"), Query.limit(limit)],
  );
  return res.documents;
}

export async function listMemosByFiling(filingId: string, limit = 6): Promise<Memo[]> {
  const res = await databases.listDocuments<Memo & Models.Document>(
    DATABASE_ID,
    COLLECTIONS.memos,
    [Query.equal("filing_id", filingId), Query.orderDesc("$createdAt"), Query.limit(limit)],
  );
  return res.documents;
}

export function subscribeTrades(onChange: (t: Trade) => void) {
  const channel = `databases.${DATABASE_ID}.collections.${COLLECTIONS.trades}.documents`;
  return client.subscribe<Trade & Models.Document>(channel, (msg) => {
    if (msg.events.some((e) => e.endsWith(".create") || e.endsWith(".update"))) {
      onChange(msg.payload);
    }
  });
}

export async function getTopMemo(market?: Market): Promise<Memo | null> {
  const res = await databases.listDocuments<Memo & Models.Document>(
    DATABASE_ID,
    COLLECTIONS.memos,
    [...marketFilter(market), Query.orderDesc("conviction"), Query.limit(1)],
  );
  return res.documents[0] ?? null;
}

export async function listOperatorMessages(threadId = "default", limit = 50): Promise<OperatorMessage[]> {
  const res = await databases.listDocuments<OperatorMessage & Models.Document>(
    DATABASE_ID,
    COLLECTIONS.operator_messages,
    [Query.equal("thread_id", threadId), Query.orderAsc("$createdAt"), Query.limit(limit)],
  );
  return res.documents;
}

export async function sendOperatorMessage(
  content: string,
  role: "operator" | "assistant" | "system" = "operator",
  threadId = "default",
): Promise<OperatorMessage> {
  return databases.createDocument<OperatorMessage & Models.Document>(
    DATABASE_ID,
    COLLECTIONS.operator_messages,
    ID.unique(),
    { thread_id: threadId, role, content, tool_calls_json: null },
  );
}

export function subscribeOperatorMessages(threadId: string, onCreate: (m: OperatorMessage) => void) {
  const channel = `databases.${DATABASE_ID}.collections.${COLLECTIONS.operator_messages}.documents`;
  return client.subscribe<OperatorMessage & Models.Document>(channel, (msg) => {
    if (msg.events.some((e) => e.endsWith(".create")) && msg.payload.thread_id === threadId) {
      onCreate(msg.payload);
    }
  });
}

export async function listGovernanceEvents(limit = 10): Promise<GovernanceEvent[]> {
  const res = await databases.listDocuments<GovernanceEvent & Models.Document>(
    DATABASE_ID,
    COLLECTIONS.governance_events,
    [Query.orderDesc("occurred_at"), Query.limit(limit)],
  );
  return res.documents;
}

export async function listBudgetLedger(limit = 50): Promise<BudgetLedger[]> {
  const res = await databases.listDocuments<BudgetLedger & Models.Document>(
    DATABASE_ID,
    COLLECTIONS.budget_ledger,
    [Query.orderDesc("occurred_at"), Query.limit(limit)],
  );
  return res.documents;
}

export async function listScenarios(limit = 12, market?: Market): Promise<Scenario[]> {
  const res = await databases.listDocuments<Scenario & Models.Document>(
    DATABASE_ID,
    COLLECTIONS.scenarios,
    [...marketFilter(market), Query.orderDesc("run_at"), Query.limit(limit)],
  );
  return res.documents;
}

/** Oldest → newest, so the series can be charted left-to-right. */
export async function listFundSnapshots(limit = 200, market?: Market): Promise<FundSnapshot[]> {
  const res = await databases.listDocuments<FundSnapshot & Models.Document>(
    DATABASE_ID,
    COLLECTIONS.fund_snapshots,
    [...marketFilter(market), Query.orderDesc("captured_at"), Query.limit(limit)],
  );
  return res.documents.slice().reverse();
}

// The Compute screen's inference plane, pipelines, and GPU fabric are now
// derived from live agents / clusters / budget_ledger, so the old
// `model_routes`, `pipelines`, and `compute_nodes` collections are no longer
// queried. The types remain in schema.ts for any external tooling.

/** The operator's configured risk limits (singleton row keyed by `key`). */
export async function getRiskLimits(key = "default"): Promise<RiskLimits | null> {
  const res = await databases.listDocuments<RiskLimits & Models.Document>(
    DATABASE_ID,
    COLLECTIONS.risk_limits,
    [Query.equal("key", key), Query.limit(1)],
  );
  return res.documents[0] ?? null;
}

/** Append-only pre-trade / governance audit trail, newest first. */
export async function listAuditLog(limit = 50): Promise<AuditLog[]> {
  const res = await databases.listDocuments<AuditLog & Models.Document>(
    DATABASE_ID,
    COLLECTIONS.audit_log,
    [Query.orderDesc("occurred_at"), Query.limit(limit)],
  );
  return res.documents;
}

/**
 * Enqueue a control command for the laptop dispatcher. The UI never spawns
 * agents itself (it may be running on serverless Vercel); it just writes a
 * row here and the dispatcher — running where `claude login` lives — acts on
 * it and reports back via agent_status.
 */
export async function enqueueAgentCommand(
  target: "responder" | "tech" | "india",
  action: "start" | "stop" | "restart",
  requestedBy: string | null = null,
): Promise<AgentCommand> {
  return databases.createDocument<AgentCommand & Models.Document>(
    DATABASE_ID,
    COLLECTIONS.agent_commands,
    ID.unique(),
    {
      target,
      action,
      status: "pending",
      requested_by: requestedBy,
      occurred_at: new Date().toISOString(),
      consumed_at: null,
    },
  );
}

/** Current worker status rows, as last published by the dispatcher. */
export async function listAgentStatus(): Promise<AgentStatusDoc[]> {
  const res = await databases.listDocuments<AgentStatusDoc & Models.Document>(
    DATABASE_ID,
    COLLECTIONS.agent_status,
    [Query.limit(25)],
  );
  return res.documents;
}

/** Realtime worker-status updates (the dispatcher republishes every tick). */
export function subscribeAgentStatus(onChange: (row: AgentStatusDoc) => void) {
  const channel = `databases.${DATABASE_ID}.collections.${COLLECTIONS.agent_status}.documents`;
  return client.subscribe<AgentStatusDoc & Models.Document>(channel, (msg) => {
    if (msg.events.some((e) => e.endsWith(".create") || e.endsWith(".update"))) {
      onChange(msg.payload);
    }
  });
}

/** Connected Zerodha Kite accounts backing the India fund. */
export async function listKiteAccounts(limit = 25): Promise<KiteAccount[]> {
  const res = await databases.listDocuments<KiteAccount & Models.Document>(
    DATABASE_ID,
    COLLECTIONS.kite_accounts,
    [Query.orderDesc("$createdAt"), Query.limit(limit)],
  );
  return res.documents;
}

/** Realtime Kite-account updates (status / last-synced changes after a sync). */
export function subscribeKiteAccounts(onChange: (row: KiteAccount) => void) {
  const channel = `databases.${DATABASE_ID}.collections.${COLLECTIONS.kite_accounts}.documents`;
  return client.subscribe<KiteAccount & Models.Document>(channel, (msg) => {
    if (msg.events.some((e) => e.endsWith(".create") || e.endsWith(".update") || e.endsWith(".delete"))) {
      onChange(msg.payload);
    }
  });
}

/** Connected Interactive Brokers accounts backing the US fund. */
export async function listIbkrAccounts(limit = 25): Promise<IbkrAccount[]> {
  const res = await databases.listDocuments<IbkrAccount & Models.Document>(
    DATABASE_ID,
    COLLECTIONS.ibkr_accounts,
    [Query.orderDesc("$createdAt"), Query.limit(limit)],
  );
  return res.documents;
}

/** Realtime IBKR-account updates (status / last-synced changes after a sync). */
export function subscribeIbkrAccounts(onChange: (row: IbkrAccount) => void) {
  const channel = `databases.${DATABASE_ID}.collections.${COLLECTIONS.ibkr_accounts}.documents`;
  return client.subscribe<IbkrAccount & Models.Document>(channel, (msg) => {
    if (msg.events.some((e) => e.endsWith(".create") || e.endsWith(".update") || e.endsWith(".delete"))) {
      onChange(msg.payload);
    }
  });
}
