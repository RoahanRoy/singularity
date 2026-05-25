/**
 * Seed Appwrite with cluster / agent / agent_event rows that mirror the mock data.
 * Run with: npx tsx scripts/seed.ts
 *
 * Idempotent: skips clusters whose unique name already exists.
 */
import "dotenv/config";
import { Client, Databases, ID, Query } from "node-appwrite";

const endpoint = process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT!;
const projectId = process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID!;
const apiKey = process.env.APPWRITE_API_KEY!;
const DB = process.env.NEXT_PUBLIC_APPWRITE_DATABASE_ID || "meridian";

if (!endpoint || !projectId || !apiKey) {
  throw new Error("Missing Appwrite env vars (endpoint / project id / api key)");
}

const client = new Client().setEndpoint(endpoint).setProject(projectId).setKey(apiKey);
const db = new Databases(client);

const CLUSTERS = [
  { name: "Macro & Rates",       theme: "macro",     agent_count: 412,  health: 0.74 },
  { name: "Equities — US",       theme: "equities",  agent_count: 1284, health: 0.61 },
  { name: "Equities — Europe",   theme: "equities",  agent_count: 612,  health: 0.52 },
  { name: "Volatility Surface",  theme: "vol",       agent_count: 184,  health: 0.83 },
  { name: "Commodities",         theme: "commod",    agent_count: 244,  health: 0.40 },
  { name: "Credit & HY",         theme: "credit",    agent_count: 198,  health: 0.55 },
  { name: "Earnings Forensics",  theme: "earnings",  agent_count: 524,  health: 0.91 },
  { name: "Event-Driven",        theme: "event",     agent_count: 312,  health: 0.68 },
  { name: "Geopolitical Intel.", theme: "geo",       agent_count: 156,  health: 0.46 },
  { name: "Alt-Data Synthesis",  theme: "alt",       agent_count: 388,  health: 0.62 },
  { name: "Execution Microstr.", theme: "exec",      agent_count: 96,   health: 0.79 },
  { name: "Risk & Topology",     theme: "risk",      agent_count: 142,  health: 0.88 },
];

const ROLES = ["research", "execution", "risk", "ops"] as const;
const STATUSES = ["idle", "thinking", "executing", "blocked"] as const;
const MODELS = ["claude-opus-4-7", "claude-sonnet-4-6", "gpt-5", "haiku-4-5"];

async function upsertClusters() {
  const out: Record<string, string> = {};
  for (const c of CLUSTERS) {
    const existing = await db.listDocuments(DB, "clusters", [Query.equal("name", c.name), Query.limit(1)]);
    if (existing.total > 0) {
      out[c.name] = existing.documents[0].$id;
      continue;
    }
    const doc = await db.createDocument(DB, "clusters", ID.unique(), c);
    out[c.name] = doc.$id;
    console.log("cluster +", c.name);
  }
  return out;
}

async function seedAgents(clusterIds: Record<string, string>) {
  // Seed a representative sample (12 per cluster), not the full headcount —
  // free tier has limited writes and Swarm count display uses cluster.agent_count.
  for (const c of CLUSTERS) {
    const existing = await db.listDocuments(DB, "agents", [Query.equal("cluster_id", clusterIds[c.name]), Query.limit(1)]);
    if (existing.total > 0) continue;
    const tasks = [];
    for (let i = 0; i < 12; i++) {
      tasks.push(
        db.createDocument(DB, "agents", ID.unique(), {
          name: `${c.theme}-${String(i).padStart(3, "0")}`,
          role: ROLES[i % ROLES.length],
          cluster_id: clusterIds[c.name],
          status: STATUSES[i % STATUSES.length],
          model: MODELS[i % MODELS.length],
          conviction: c.health + (Math.random() - 0.5) * 0.2,
          last_action_at: new Date(Date.now() - Math.random() * 60_000).toISOString(),
        })
      );
    }
    await Promise.all(tasks);
    console.log("agents +", c.name, "(12)");
  }
}

const FEED = [
  { cluster: "Earnings Forensics", kind: "thought",   summary: "SEMI/TSM capex guidance language softened vs. Q2; mgmt tone -0.31σ" },
  { cluster: "Macro & Rates",      kind: "thought",   summary: "BoJ intermeeting probability re-rated to 0.18 after Ueda remarks" },
  { cluster: "Volatility Surface", kind: "thought",   summary: "Term structure inversion in SPX 1W/1M; convex hedge candidate" },
  { cluster: "Geopolitical Intel.",kind: "alert",     summary: "Strait of Hormuz traffic anomaly — 3 vessels deviated, low priority" },
  { cluster: "Event-Driven",       kind: "thought",   summary: "MSFT/AVGO patent litigation update; resolution probability +0.07" },
  { cluster: "Alt-Data Synthesis", kind: "thought",   summary: "NA truck-stop diesel throughput -2.4% w/w, divergent from rail data" },
  { cluster: "Earnings Forensics", kind: "handoff",   summary: "Hedge against NVDA long thesis: 3 dissenters escalated" },
  { cluster: "Risk & Topology",    kind: "memo",      summary: "Tail-risk topology updated. Worst-1% drawdown re-estimated at -2.81%" },
  { cluster: "Execution Microstr.",kind: "tool_call", summary: "Iceberg routing on ASML — slippage tracking 0.4bp below model" },
  { cluster: "Macro & Rates",      kind: "thought",   summary: "Cross-asset signal cluster forming: DXY↑ / XAU↑ / UST10Y↓" },
  { cluster: "Equities — US",      kind: "alert",     summary: "Quiet-period violation suspected, $XYZ ⇒ pause coverage" },
  { cluster: "Earnings Forensics", kind: "handoff",   summary: "Supplier deflection on EV/CHRG call — escalating to forensic tier" },
];

async function seedEvents(clusterIds: Record<string, string>) {
  const existing = await db.listDocuments(DB, "agent_events", [Query.limit(1)]);
  if (existing.total > 0) {
    console.log("agent_events already seeded, skipping");
    return;
  }
  const now = Date.now();
  for (let i = 0; i < FEED.length; i++) {
    const f = FEED[i];
    const cid = clusterIds[f.cluster] ?? null;
    const sample = await db.listDocuments(DB, "agents", [Query.equal("cluster_id", cid!), Query.limit(1)]);
    const aid = sample.documents[0]?.$id ?? "unknown";
    await db.createDocument(DB, "agent_events", ID.unique(), {
      agent_id: aid,
      cluster_id: cid,
      kind: f.kind,
      summary: f.summary,
      payload_json: null,
      occurred_at: new Date(now - (FEED.length - i) * 3000).toISOString(),
    });
  }
  console.log("agent_events + 12");
}

const FILINGS = [
  { ticker: "NVDA", form_type: "10-K",          minutes_ago: 0,    status: "indexed",   summary: "Annual Report — segment commentary on China-restricted SKUs and supply mix." },
  { ticker: "TSM",  form_type: "EARNINGS CALL", minutes_ago: 0.2,  status: "parsing",   summary: "Q4 2025 transcript — capex language softens; mgmt deflects two questions on inventory." },
  { ticker: "AVGO", form_type: "8-K",           minutes_ago: 1.1,  status: "indexed",   summary: "Executive departure disclosure — CFO transition, no successor named." },
  { ticker: "BX",   form_type: "13F",           minutes_ago: 3.2,  status: "indexed",   summary: "Reported holdings reveal -$340M reduction in semiconductor names." },
  { ticker: "—",    form_type: "S-1",           minutes_ago: 8,    status: "indexed",   summary: "Newly filed: vertical-AI infra company, lead investors include sovereign vehicle." },
  { ticker: "ASML", form_type: "NEWS",          minutes_ago: 11,   status: "indexed",   summary: "Reuters wire — export-license clarification scheduled next month." },
  { ticker: "GOOG", form_type: "PATENT",        minutes_ago: 23,   status: "indexed",   summary: "Granted: distillation method for sub-300B parameter models." },
  { ticker: "AMZN", form_type: "ALT",           minutes_ago: 31,   status: "indexed",   summary: "Truck-stop diesel throughput dataset — -2.4% w/w, NA corridors." },
  { ticker: "JPM",  form_type: "REG",           minutes_ago: 47,   status: "indexed",   summary: "Fed exam letter referenced in proxy; mention of liquidity stress overlay." },
];

async function seedFilings() {
  const existing = await db.listDocuments(DB, "filings", [Query.limit(1)]);
  if (existing.total > 0) {
    console.log("filings already seeded, skipping");
    return;
  }
  const now = Date.now();
  for (const f of FILINGS) {
    await db.createDocument(DB, "filings", ID.unique(), {
      ticker: f.ticker,
      form_type: f.form_type,
      filed_at: new Date(now - f.minutes_ago * 60_000).toISOString(),
      // we cram the human summary into source_url so DocList can render it;
      // a v2 schema would add a `summary` attribute. fine for now.
      source_url: f.summary,
      status: f.status,
      vector_id: null,
    });
  }
  console.log("filings +", FILINGS.length);
}

async function seedMemo(clusterIds: Record<string, string>) {
  const existing = await db.listDocuments(DB, "memos", [Query.limit(1)]);
  if (existing.total > 0) {
    console.log("memos already seeded, skipping");
    return;
  }
  // grab an agent from Earnings Forensics to author the memo
  const cid = clusterIds["Earnings Forensics"];
  const authors = await db.listDocuments(DB, "agents", [Query.equal("cluster_id", cid), Query.limit(1)]);
  const authorId = authors.documents[0]?.$id ?? "unknown";
  await db.createDocument(DB, "memos", ID.unique(), {
    title: "TSM — Q4 print, demand softness signal",
    ticker: "TSM",
    thesis:
      "Three independent agents converged on a softening-demand interpretation of management's tone, supported by alt-data divergence in NA capex shipments and a thinning options skew on TSM 1M. Suggested expression: long SOXX vs. short TSM call spread. Risk-managed via VIX overlay.",
    conviction: 0.74,
    author_agent_id: authorId,
    status: "draft",
    vector_id: null,
  });
  console.log("memos + 1");
}

const POSITIONS = [
  { ticker: "NVDA",  qty:  18420, avg_cost: 412.18, market_value:  9_142_300, unrealized_pnl:  1_540_220, weight: 0.071 },
  { ticker: "TSM",   qty:  62100, avg_cost: 168.42, market_value: 11_820_900, unrealized_pnl:    264_500, weight: 0.092 },
  { ticker: "AVGO",  qty:   9840, avg_cost: 1240.10, market_value: 13_120_400, unrealized_pnl:    920_100, weight: 0.102 },
  { ticker: "ASML",  qty:  11200, avg_cost: 880.55, market_value:  9_640_000, unrealized_pnl:   -210_400, weight: 0.075 },
  { ticker: "MSFT",  qty:  21500, avg_cost: 408.20, market_value:  9_412_000, unrealized_pnl:    632_100, weight: 0.073 },
  { ticker: "GOOG",  qty:  34800, avg_cost: 178.40, market_value:  6_842_400, unrealized_pnl:    412_000, weight: 0.053 },
  { ticker: "GLD",   qty:  41200, avg_cost: 228.10, market_value: 10_540_800, unrealized_pnl:  1_122_300, weight: 0.082 },
  { ticker: "TLT",   qty:  88400, avg_cost:  92.40, market_value:  7_840_800, unrealized_pnl:   -418_200, weight: 0.061 },
  { ticker: "XHB",   qty: -12400, avg_cost:  98.20, market_value: -1_240_000, unrealized_pnl:    142_000, weight: -0.010 },
  { ticker: "EWJ",   qty:  62800, avg_cost:  72.40, market_value:  4_840_200, unrealized_pnl:    218_400, weight: 0.038 },
];

async function seedPositions() {
  const existing = await db.listDocuments(DB, "positions", [Query.limit(1)]);
  if (existing.total > 0) {
    console.log("positions already seeded, skipping");
    return;
  }
  for (const p of POSITIONS) {
    await db.createDocument(DB, "positions", ID.unique(), { ...p, factor_exposures_json: null });
  }
  console.log("positions +", POSITIONS.length);
}

const PENDING_TRADES = [
  { ticker: "NVDA", side: "buy"  as const, qty:  4200, price: 496.20, venue: "NASDAQ" },
  { ticker: "TSM",  side: "sell" as const, qty:  8400, price: 190.40, venue: "NYSE"   },
  { ticker: "GLD",  side: "buy"  as const, qty:  6200, price: 255.80, venue: "ARCA"   },
  { ticker: "XHB",  side: "sell" as const, qty: 12400, price:  86.40, venue: "ARCA"   },
  { ticker: "EWJ",  side: "buy"  as const, qty:  3100, price:  77.10, venue: "ARCA"   },
];

async function seedTrades(clusterIds: Record<string, string>) {
  const existing = await db.listDocuments(DB, "trades", [Query.limit(1)]);
  if (existing.total > 0) {
    console.log("trades already seeded, skipping");
    return;
  }
  // pull an Execution agent if available, else any
  const cid = clusterIds["Execution Microstr."];
  const agents = await db.listDocuments(DB, "agents", [Query.equal("cluster_id", cid), Query.limit(1)]);
  const aid = agents.documents[0]?.$id ?? "unknown";
  for (const t of PENDING_TRADES) {
    await db.createDocument(DB, "trades", ID.unique(), {
      ticker: t.ticker,
      side: t.side,
      qty: t.qty,
      price: t.price,
      venue: t.venue,
      agent_id: aid,
      status: "pending",
      filled_at: null,
    });
  }
  console.log("trades +", PENDING_TRADES.length);
}

const GOV_EVENTS = [
  { kind: "approval"      as const, actor: "K. Park",            target: "trade:NVDA buy 4200",  reason: "within auto-execute cap" },
  { kind: "block"         as const, actor: "risk/r-04",          target: "trade:TSM call spread", reason: "VaR breach projected" },
  { kind: "override"      as const, actor: "K. Park",            target: "rule:china-semi-cap",   reason: "PM authorized 5% headroom" },
  { kind: "approval"      as const, actor: "exec/x-19",          target: "memo:TSM Q4",           reason: "quorum 5/6" },
  { kind: "policy_change" as const, actor: "governance/gov-01",  target: "rule:voice-trade",      reason: "disabled for session" },
  { kind: "approval"      as const, actor: "K. Park",            target: "spawn:8 forensic agts", reason: "budget $480 within cap" },
];

async function seedGovEvents() {
  const existing = await db.listDocuments(DB, "governance_events", [Query.limit(1)]);
  if (existing.total > 0) {
    console.log("governance_events already seeded, skipping");
    return;
  }
  const now = Date.now();
  for (let i = 0; i < GOV_EVENTS.length; i++) {
    const g = GOV_EVENTS[i];
    await db.createDocument(DB, "governance_events", ID.unique(), {
      ...g,
      occurred_at: new Date(now - (GOV_EVENTS.length - i) * 90_000).toISOString(),
    });
  }
  console.log("governance_events +", GOV_EVENTS.length);
}

const BUDGET = [
  { category: "llm"        as const, provider: "anthropic",     amount_usd:  412.18 },
  { category: "llm"        as const, provider: "openai",        amount_usd:  284.40 },
  { category: "llm"        as const, provider: "anthropic",     amount_usd:  148.20 },
  { category: "data"       as const, provider: "polygon",       amount_usd:   92.00 },
  { category: "data"       as const, provider: "refinitiv",     amount_usd:  220.00 },
  { category: "compute"    as const, provider: "modal",         amount_usd:   48.10 },
  { category: "venue_fees" as const, provider: "ibkr",          amount_usd:   79.40 },
];

async function seedBudget() {
  const existing = await db.listDocuments(DB, "budget_ledger", [Query.limit(1)]);
  if (existing.total > 0) {
    console.log("budget_ledger already seeded, skipping");
    return;
  }
  const now = Date.now();
  for (let i = 0; i < BUDGET.length; i++) {
    const b = BUDGET[i];
    await db.createDocument(DB, "budget_ledger", ID.unique(), {
      ...b,
      meta_json: null,
      occurred_at: new Date(now - (BUDGET.length - i) * 240_000).toISOString(),
    });
  }
  console.log("budget_ledger +", BUDGET.length);
}

(async () => {
  const ids = await upsertClusters();
  await seedAgents(ids);
  await seedEvents(ids);
  await seedFilings();
  await seedMemo(ids);
  await seedPositions();
  await seedTrades(ids);
  await seedGovEvents();
  await seedBudget();
  console.log("\n✓ seed complete");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
