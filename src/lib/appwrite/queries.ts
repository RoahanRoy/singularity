"use client";

import { Query, ID, type Models } from "appwrite";
import { databases, DATABASE_ID, client } from "./client";
import { COLLECTIONS, type Cluster, type AgentEvent, type Filing, type Memo, type Position, type Trade, type OperatorMessage, type GovernanceEvent, type BudgetLedger } from "./schema";

export async function listClusters(): Promise<Cluster[]> {
  const res = await databases.listDocuments<Cluster & Models.Document>(
    DATABASE_ID,
    COLLECTIONS.clusters,
    [Query.orderDesc("agent_count"), Query.limit(50)],
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

export async function listFilings(limit = 12): Promise<Filing[]> {
  const res = await databases.listDocuments<Filing & Models.Document>(
    DATABASE_ID,
    COLLECTIONS.filings,
    [Query.orderDesc("filed_at"), Query.limit(limit)],
  );
  return res.documents;
}

export function subscribeFilings(onCreate: (f: Filing) => void) {
  const channel = `databases.${DATABASE_ID}.collections.${COLLECTIONS.filings}.documents`;
  return client.subscribe<Filing & Models.Document>(channel, (msg) => {
    if (msg.events.some((e) => e.endsWith(".create"))) {
      onCreate(msg.payload);
    }
  });
}

export async function listMemos(limit = 6): Promise<Memo[]> {
  const res = await databases.listDocuments<Memo & Models.Document>(
    DATABASE_ID,
    COLLECTIONS.memos,
    [Query.orderDesc("$createdAt"), Query.limit(limit)],
  );
  return res.documents;
}

export async function listPositions(limit = 25): Promise<Position[]> {
  const res = await databases.listDocuments<Position & Models.Document>(
    DATABASE_ID,
    COLLECTIONS.positions,
    [Query.orderDesc("market_value"), Query.limit(limit)],
  );
  return res.documents;
}

export async function listPendingTrades(limit = 10): Promise<Trade[]> {
  const res = await databases.listDocuments<Trade & Models.Document>(
    DATABASE_ID,
    COLLECTIONS.trades,
    [Query.equal("status", "pending"), Query.orderDesc("$createdAt"), Query.limit(limit)],
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

export async function getTopMemo(): Promise<Memo | null> {
  const res = await databases.listDocuments<Memo & Models.Document>(
    DATABASE_ID,
    COLLECTIONS.memos,
    [Query.orderDesc("conviction"), Query.limit(1)],
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
