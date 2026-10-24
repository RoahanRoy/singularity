"use client";

import { Query, ID, type Models } from "appwrite";
import { databases, DATABASE_ID, client } from "./client";
import { COLLECTIONS, type Agent, type Cluster, type AgentEvent, type Filing, type Memo, type Position, type Trade, type OperatorMessage, type GovernanceEvent, type BudgetLedger, type Scenario, type FundSnapshot, type RiskLimits, type AuditLog, type AgentCommand, type AgentStatusDoc, type IbkrAccount, type QuantReport, type Market, isFundPosition } from "./schema";

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

/** The fund's own book: the desk's paper positions. */
export async function listFundPositions(limit = 25, market?: Market): Promise<Position[]> {
  const res = await databases.listDocuments<Position & Models.Document>(
    DATABASE_ID,
    COLLECTIONS.positions,
    [
      ...marketFilter(market),
      // Legacy advisory rows still in `positions` carry one of these.
      Query.isNull("horizon_source"),
      Query.isNull("ibkr_account_id"),
      Query.isNull("kite_account_id"),
      Query.orderDesc("market_value"),
      Query.limit(limit),
    ],
  );
  return res.documents.filter(isFundPosition).map((p) => ({ ...p, book: "fund" as const }));
}

/** The advisory book: the operator's real holdings, synced from Horizon or IBKR. */
export async function listAdvisoryPositions(limit = 25, market?: Market): Promise<Position[]> {
  const res = await databases.listDocuments<Position & Models.Document>(
    DATABASE_ID,
    COLLECTIONS.advisory_positions,
    [...marketFilter(market), Query.orderDesc("market_value"), Query.limit(limit)],
  );
  return res.documents.map((p) => ({ ...p, book: "advisory" as const }));
}

/** Both books, largest first, each row tagged with its `book`. */
export async function listPositions(limit = 25, market?: Market): Promise<Position[]> {
  const [fund, advisory] = await Promise.all([listFundPositions(limit, market), listAdvisoryPositions(limit, market)]);
  return [...fund, ...advisory].sort((a, b) => b.market_value - a.market_value).slice(0, limit);
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

/** Orders the broker sized and cleared but holds for the operator: memos in
 *  review (or approved, waiting for the loop's sweep) that carry pending_exec_json. */
export async function listHeldMemos(limit = 10, market?: Market): Promise<Memo[]> {
  const res = await databases.listDocuments<Memo & Models.Document>(
    DATABASE_ID,
    COLLECTIONS.memos,
    [...marketFilter(market), Query.equal("status", ["review", "approved"]), Query.orderDesc("$createdAt"), Query.limit(limit)],
  );
  return res.documents.filter((m) => m.pending_exec_json);
}

export function subscribeMemos(onChange: (m: Memo) => void) {
  const channel = `databases.${DATABASE_ID}.collections.${COLLECTIONS.memos}.documents`;
  return client.subscribe<Memo & Models.Document>(channel, (msg) => {
    if (msg.events.some((e) => e.endsWith(".create") || e.endsWith(".update"))) {
      onChange(msg.payload);
    }
  });
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

/** Agents whose rows mark a quant-desk cycle's progress: started, screened, finished. */
export const QUANT_HEAD_AGENTS = ["market-data-reader", "fundamentals-screener", "ensemble-combiner"] as const;

/**
 * Recent quant-desk progress rows on a desk, newest first: each cycle's
 * market-data, screener and (unless the screen stopped it) ensemble report.
 * The Quant screen groups them into the newest cycle per ticker.
 */
export async function listQuantHeads(market?: Market, limit = 1500): Promise<QuantReport[]> {
  // Three head rows per cycle; the daily sweep (scripts/agents/quant-sweep.ts)
  // writes ~170 cycles a day, so page until two sweeps' worth are loaded.
  const out: QuantReport[] = [];
  let cursor: string | undefined;
  while (out.length < limit) {
    const page = Math.min(500, limit - out.length);
    const res = await databases.listDocuments<QuantReport & Models.Document>(
      DATABASE_ID,
      COLLECTIONS.quant_reports,
      [
        Query.equal("agent", [...QUANT_HEAD_AGENTS]), ...marketFilter(market), Query.orderDesc("run_at"), Query.limit(page),
        ...(cursor ? [Query.cursorAfter(cursor)] : []),
      ],
    );
    out.push(...res.documents);
    if (res.documents.length < page) break;
    cursor = res.documents[res.documents.length - 1].$id;
  }
  return out;
}

/**
 * The quant desk's ensemble verdicts on a desk from the last `days`, newest
 * first. The Portfolio rebalance takes the newest row per ticker; a daily sweep
 * writes well under a hundred, so one page covers the week.
 */
export async function listEnsembleVerdicts(market: Market, days = 7): Promise<QuantReport[]> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const res = await databases.listDocuments<QuantReport & Models.Document>(
    DATABASE_ID,
    COLLECTIONS.quant_reports,
    [
      Query.equal("agent", "ensemble-combiner"), ...marketFilter(market), Query.greaterThan("run_at", since),
      Query.orderDesc("run_at"), Query.limit(500),
    ],
  );
  return res.documents;
}

/** Every agent report from one quant-desk cycle, in the order they ran. */
export async function listQuantCycle(cycleId: string): Promise<QuantReport[]> {
  const res = await databases.listDocuments<QuantReport & Models.Document>(
    DATABASE_ID,
    COLLECTIONS.quant_reports,
    [Query.equal("cycle_id", cycleId), Query.orderAsc("run_at"), Query.limit(100)],
  );
  return res.documents;
}

/** Realtime: each quant agent's report as it lands. */
export function subscribeQuantReports(onCreate: (r: QuantReport) => void) {
  const channel = `databases.${DATABASE_ID}.collections.${COLLECTIONS.quant_reports}.documents`;
  return client.subscribe<QuantReport & Models.Document>(channel, (msg) => {
    if (msg.events.some((e) => e.endsWith(".create"))) {
      onCreate(msg.payload);
    }
  });
}
