/**
 * Single source of truth for collection IDs and document shapes.
 * Mirrors appwrite.json — keep in sync.
 */

export const COLLECTIONS = {
  agents: "agents",
  clusters: "clusters",
  agent_events: "agent_events",
  filings: "filings",
  memos: "memos",
  positions: "positions",
  trades: "trades",
  scenarios: "scenarios",
  governance_events: "governance_events",
  budget_ledger: "budget_ledger",
  operator_messages: "operator_messages",
  fund_snapshots: "fund_snapshots",
  model_routes: "model_routes",
  pipelines: "pipelines",
  compute_nodes: "compute_nodes",
  risk_limits: "risk_limits",
  audit_log: "audit_log",
  agent_commands: "agent_commands",
  agent_status: "agent_status",
  kite_accounts: "kite_accounts",
} as const;

type Base = { $id: string; $createdAt: string; $updatedAt: string };

/** Which desk a row belongs to. Untagged legacy rows are treated as "US". */
export type Market = "US" | "IN";

export type Agent = Base & {
  name: string;
  role: "research" | "execution" | "risk" | "ops";
  cluster_id: string | null;
  status: "idle" | "thinking" | "executing" | "blocked" | "killed";
  model: string;
  conviction: number;
  last_action_at: string | null;
  market?: Market | null;
};

export type Cluster = Base & {
  name: string;
  theme: string;
  agent_count: number;
  health: number;
  market?: Market | null;
};

export type AgentEvent = Base & {
  agent_id: string;
  cluster_id: string | null;
  kind: "thought" | "tool_call" | "trade" | "memo" | "alert" | "handoff";
  summary: string;
  payload_json: string | null;
  occurred_at: string;
};

export type Filing = Base & {
  ticker: string;
  form_type: string;
  filed_at: string;
  source_url: string;
  status: "queued" | "parsing" | "indexed" | "failed";
  vector_id: string | null;
  market?: Market | null;
};

export type Memo = Base & {
  title: string;
  ticker: string | null;
  thesis: string;
  conviction: number;
  author_agent_id: string;
  status: "draft" | "review" | "approved" | "rejected";
  vector_id: string | null;
  entities_json: string | null;
  filing_id: string | null;
  market?: Market | null;
};

export type MemoEntity = {
  name: string;
  role: "subject" | "customer" | "supplier" | "competitor" | "peer" | "input" | string;
  weight: number;
};

export type Position = Base & {
  ticker: string;
  qty: number;
  avg_cost: number;
  market_value: number;
  unrealized_pnl: number;
  weight: number;
  factor_exposures_json: string | null;
  market?: Market | null;
  kite_account_id?: string | null;
};

export type Trade = Base & {
  ticker: string;
  side: "buy" | "sell";
  qty: number;
  price: number;
  venue: string;
  agent_id: string;
  status: "pending" | "filled" | "rejected" | "cancelled";
  filled_at: string | null;
  market?: Market | null;
};

export type Scenario = Base & {
  name: string;
  description: string;
  shocks_json: string;
  nav_delta: number;
  worst_position: string | null;
  run_at: string;
  market?: Market | null;
};

export type GovernanceEvent = Base & {
  kind: "approval" | "block" | "override" | "policy_change";
  actor: string;
  target: string;
  reason: string;
  occurred_at: string;
};

export type BudgetLedger = Base & {
  category: "llm" | "data" | "compute" | "venue_fees";
  provider: string;
  amount_usd: number;
  tokens: number | null;
  meta_json: string | null;
  occurred_at: string;
};

export type OperatorMessage = Base & {
  thread_id: string;
  role: "operator" | "assistant" | "system";
  content: string;
  tool_calls_json: string | null;
};

export type FundSnapshot = Base & {
  nav_usd: number;
  pnl_daily: number;
  captured_at: string;
  market?: Market | null;
};

export type ModelRoute = Base & {
  model: string;
  load: number;
  latency_ms: number;
  status: string;
  updated_at: string;
};

export type Pipeline = Base & {
  name: string;
  status: "running" | "idle" | "failing" | string;
  throughput: string;
  updated_at: string;
};

export type ComputeNode = Base & {
  zone: string;
  gpu_model: string;
  gpu_count: number;
  utilization: number;
  temp_c: number;
  updated_at: string;
};

export type RiskLimits = Base & {
  key: string;
  max_position_weight_pct: number;
  max_gross_leverage: number;
  daily_var_limit_pct: number;
  max_name_count: number;
  updated_at: string;
};

export type AuditLog = Base & {
  actor: string;
  action: string;
  target: string;
  decision: "allow" | "block" | string;
  detail: string;
  occurred_at: string;
};

/** The workers the operator can drive. */
export type AgentWorker = "responder" | "tech" | "india";

/**
 * A connected Zerodha Kite account. Single-operator app, so the daily-expiring
 * access token is stored server-side. On a 401 from Kite the status flips to
 * `needs_reauth` and the operator re-runs the login flow.
 */
export type KiteAccount = Base & {
  operator_id: string | null;
  label: string;
  kite_user_id: string;
  api_key: string;
  access_token: string;
  public_token: string | null;
  status: "connected" | "needs_reauth" | "error";
  equity_cash: number;
  holdings_count: number;
  last_synced_at: string | null;
};

/**
 * A control command enqueued by the Operator Console (possibly served from
 * Vercel) and consumed by the laptop dispatcher, which actually owns the
 * agent child processes. This is the message bus that lets a serverless UI
 * drive processes that must run where `claude login` lives.
 */
export type AgentCommand = Base & {
  target: AgentWorker | string;
  action: "start" | "stop" | "restart";
  status: "pending" | "done" | "error";
  requested_by: string | null;
  occurred_at: string;
  consumed_at: string | null;
};

/** Live status of a worker, published by the dispatcher for the UI to render. */
export type AgentStatusDoc = Base & {
  name: AgentWorker | string;
  running: boolean;
  pid: number | null;
  started_at: string | null;
  exit_code: number | null;
  last_log: string | null;
  updated_at: string;
};

/** A single factor exposure entry stored on a position's factor_exposures_json. */
export type FactorExposure = {
  factor: string;
  beta: number;
};

/** A scenario branch stored inside a scenario's shocks_json. */
export type ScenarioBranch = {
  label: string;
  prob: number;
  delta: number;
  hedged_delta?: number;
};
