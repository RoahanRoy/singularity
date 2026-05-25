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
} as const;

type Base = { $id: string; $createdAt: string; $updatedAt: string };

export type Agent = Base & {
  name: string;
  role: "research" | "execution" | "risk" | "ops";
  cluster_id: string | null;
  status: "idle" | "thinking" | "executing" | "blocked" | "killed";
  model: string;
  conviction: number;
  last_action_at: string | null;
};

export type Cluster = Base & {
  name: string;
  theme: string;
  agent_count: number;
  health: number;
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
};

export type Scenario = Base & {
  name: string;
  description: string;
  shocks_json: string;
  nav_delta: number;
  worst_position: string | null;
  run_at: string;
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
  meta_json: string | null;
  occurred_at: string;
};

export type OperatorMessage = Base & {
  thread_id: string;
  role: "operator" | "assistant" | "system";
  content: string;
  tool_calls_json: string | null;
};
