// Sample data for the public desk demo (landing + guided tour). None of it is
// measured: every screen that shows it says "Sample data". Shapes and names
// follow the real desk (agent and cluster names from scripts/agents/nodes.ts,
// routes from the smart-router prompt) so the demo shows only what the desk does.

export const NAV = 1_284_902_144;
export const DAY_PNL = 4_218_330;
export const CASH = 79_664_000;
export const TARGET_TE = 0.04;

/** The index, then the largest holdings: [label, price, change %]. */
export const TICKS: [string, number, number][] = [
  ["S&P 500", 5268.4, 0.42],
  ["NVDA", 1184.2, 2.15],
  ["MSFT", 421.7, 0.38],
  ["TSM", 174.8, 0.91],
  ["AVGO", 1612.5, 1.12],
  ["ASML", 968.4, -0.42],
];

export type Proposal = {
  id: string;
  ticker: string;
  weight: number; // % of NAV
  qty: number;
  route: string;
  arrival: string;
  conviction: number;
  held: string;
  title: string;
  thesis: string;
};

export const PROPOSALS: Proposal[] = [
  {
    id: "nvda",
    ticker: "NVDA",
    weight: 0.3,
    qty: 3255,
    route: "TWAP · DARK",
    arrival: "1,184.20 · 09:58",
    conviction: 0.78,
    held: "2h",
    title: "Supplier dislocation after the TSM guide",
    thesis: "Supplier dislocation after the TSM guide; data-center orders are still backlogged.",
  },
  {
    id: "gld",
    ticker: "GLD",
    weight: 0.15,
    qty: 8720,
    route: "VWAP · IBKR",
    arrival: "221.04 · 10:31",
    conviction: 0.55,
    held: "40m",
    title: "A hedge against a hawkish rate path",
    thesis: "A hedge against a hawkish FOMC path while the book leans into semis.",
  },
  {
    id: "ewj",
    ticker: "EWJ",
    weight: 0.1,
    qty: 18020,
    route: "VWAP · IBKR",
    arrival: "71.31 · 10:52",
    conviction: 0.49,
    held: "12m",
    title: "BoJ intermeeting odds rising",
    thesis: "BoJ intermeeting odds are rising as the yen carry trade unwinds.",
  },
];

/** [time, agent, summary] */
export const FEED: [string, string, string][] = [
  ["10:52", "PM", "sized EWJ at 0.10% of NAV; staged for your approval."],
  ["10:41", "Earnings Reviewer", "read TSM's Q3 call: capex language softened for the second quarter running."],
  ["10:31", "Risk Officer", "cleared GLD +0.15%: tracking error stays inside the 4.0% target."],
  ["10:12", "Filing Parser", "parsed an 8-K from AVGO (item 2.02, results of operations)."],
  ["09:41", "Risk Officer", "blocked AVGO +0.6%: its active risk would pass the single-name limit."],
];

/** [action, detail, time · actor, blocked] */
export const RECENT: [string, string, string, boolean][] = [
  ["Block", "AVGO +0.6% would lift its active risk past 4.0%", "09:41 · risk-overlay", true],
  ["Approve", "AAPL buy 1,420 (0.18% of NAV)", "09:12 · You", false],
  ["Fill", "AAPL 1,420 @ 228.40 via VWAP", "09:30 · broker", false],
];

/** Fund book holdings: [ticker, name, weight, today %, beta, share of risk]. */
export const HOLDINGS: [string, string, number, number, number, number][] = [
  ["NVDA", "NVIDIA", 0.084, 2.15, 1.74, 0.162],
  ["MSFT", "Microsoft", 0.071, 0.38, 1.02, 0.088],
  ["TSM", "Taiwan Semi", 0.061, 0.91, 1.31, 0.098],
  ["AVGO", "Broadcom", 0.052, 1.12, 1.41, 0.083],
  ["ASML", "ASML", 0.048, -0.42, 1.22, 0.071],
  ["JPM", "JPMorgan", 0.045, 0.21, 1.08, 0.049],
  ["GLD", "Gold ETF", 0.04, 0.32, 0.08, -0.012],
  ["XLE", "Energy ETF", 0.032, 1.18, 0.71, 0.029],
];

/** A smooth sample NAV path for the chart (index → NAV in USD). */
export const NAV_PATH: number[] = Array.from({ length: 64 }, (_, i) => {
  const t = i / 63;
  return NAV * (0.93 + 0.07 * t + 0.012 * Math.sin(i / 3.1) + 0.006 * Math.sin(i / 1.3));
});

export const RISK = {
  var95: 0.0118,
  var95h: 0.0131,
  es95: 0.0149,
  es95h: 0.0172,
  te: 0.042,
  beta: 0.84,
  vol: 0.168,
  measured: 0.912,
  indexTeShare: 0.214,
  /** [ticker, weight, share of risk, TE share, beta, days of ADV] */
  names: [
    ["NVDA", 0.084, 0.162, 0.141, 1.74, 0.41],
    ["MSFT", 0.071, 0.088, 0.041, 1.02, 0.12],
    ["TSM", 0.061, 0.098, 0.087, 1.31, 0.22],
    ["AVGO", 0.052, 0.083, 0.072, 1.41, 0.18],
    ["ASML", 0.048, 0.071, 0.066, 1.22, 0.64],
  ] as [string, number, number, number, number, number][],
  /** [label, peak, trough, index, book, not covered] */
  stress: [
    ["2022 · Rate shock", "2022-01-03", "2022-10-12", -0.254, -0.188, 0.04],
    ["2020 · COVID crash", "2020-02-19", "2020-03-23", -0.339, -0.241, 0.07],
    ["2018 · Q4 selloff", "2018-09-20", "2018-12-24", -0.198, -0.142, 0.11],
  ] as [string, string, string, number, number, number][],
};

/** Research inbox: [ticker, form, headline, age, held, memo]. */
export const INBOX: [string, string, string, string, boolean, boolean][] = [
  ["TSM", "Call", "Q3 2026 earnings call · CFO remarks and Q&A", "14m", true, true],
  ["AVGO", "8-K", "Item 2.02 · Results of operations", "52m", true, false],
  ["NVDA", "10-Q", "Quarterly report · supply commitments", "3h", true, true],
  ["ASML", "6-K", "Q3 results · bookings and backlog", "5h", true, false],
  ["XHB", "News", "Housing starts miss consensus", "6h", false, false],
];

export const MEMO = {
  ticker: "TSM",
  form: "Call",
  author: "Tech Analyst",
  age: "14m",
  title: "Capex language softened two quarters running",
  stats: [
    ["Conviction", "0.68"],
    ["Horizon", "3–6 mo"],
    ["Critic", "Passed"],
    ["Order", "None staged"],
  ] as [string, string][],
  paras: [
    "Management kept full-year revenue guidance but softened its capex language for the second quarter running, and tone on advanced-node demand fell against the Q2 call.",
    "Supplier commentary points the same way: an equipment vendor said customers asked to move deliveries into the next quarter. We read this as demand normalising at the leading edge, not a collapse.",
    "No order: the book already holds TSM at 6.1% and the read does not clear the bar for a trim. Watch the next monthly revenue print.",
  ],
};

/** Quant measurements on Research: [ticker, status, signal, age]. */
export const QUANT: [string, string, string, string][] = [
  ["NVDA", "done", "+0.38", "12m"],
  ["AVGO", "done", "+0.24", "47m"],
  ["TSM", "done", "+0.12", "1h"],
  ["ASML", "running", "—", "3m"],
];

/** Clusters: [name, theme, agents, working, last act]. */
export const CLUSTERS: [string, string, number, number, string][] = [
  ["Tech — Equities US", "equities", 3, 2, "1m"],
  ["Research", "earnings", 2, 1, "4m"],
  ["Quant Research", "signals", 6, 3, "3m"],
  ["Investment Committee", "event", 2, 0, "22m"],
  ["Risk", "risk", 2, 1, "11m"],
  ["Execution", "exec", 3, 0, "1h"],
  ["Portfolio Ops", "event", 2, 1, "8m"],
];

/** Agent activity: [kind, summary, agent · cluster, age]. */
export const TRACE: [string, string, string, string][] = [
  ["action", "Staged EWJ buy 18,020 for operator approval", "PM · Portfolio Ops", "1m"],
  ["thought", "TSM capex language softer than Q2; drafting a memo", "Tech Analyst · Tech — Equities US", "4m"],
  ["action", "Measured ASML: factor exposures and a 5-model ensemble", "Quant Researcher · Quant Research", "3m"],
  ["block", "AVGO +0.6% would breach the single-name active-risk limit", "Risk Officer · Risk", "11m"],
  ["thought", "Challenged the NVDA thesis on supplier concentration; passed", "Red Team Critic · Investment Committee", "22m"],
];

/** Audit log rows: [time, action, detail, actor, kind, blocked]. */
export const LOG: [string, string, string, string, "trade" | "agents" | "guard", boolean][] = [
  ["10:31", "Approve", "GLD buy 8,720 (0.15% of NAV)", "You", "trade", false],
  ["09:41", "Block", "AVGO +0.6% would lift its active risk past 4.0%", "risk-overlay", "guard", true],
  ["09:30", "Fill", "AAPL 1,420 @ 228.40 via VWAP", "broker", "trade", false],
  ["09:12", "Approve", "AAPL buy 1,420 (0.18% of NAV)", "You", "trade", false],
  ["08:30", "Pass", "Pre-trade risk gate cleared GLD +0.15%", "risk-overlay", "guard", false],
  ["Yesterday", "Decline", "XLE buy 0.20% of NAV", "You", "trade", false],
  ["Yesterday", "Start loop", "Tech desk loop", "You", "agents", false],
];

/** Console thread: [mine, who · when, text]. */
export const THREAD: [boolean, string, string][] = [
  [true, "You · 12m ago", "Why did the risk check block AVGO this morning?"],
  [
    false,
    "Meridian · assistant · 12m ago",
    "AVGO at +0.6% of NAV would have lifted its active risk to 4.3%, past the 4.0% single-name limit the risk budget sets. The staged size that fits is about +0.35%; the PM will re-size it on the next sweep if the thesis still holds.",
  ],
  [true, "You · 3m ago", "What's the largest position and how much cash is undeployed?"],
  [
    false,
    "Meridian · assistant · 3m ago",
    "NVDA is the largest at 8.4% of NAV. Cash is $79.7M, 6.2% of NAV, all undeployed mandate capital.",
  ],
];

/** Spend today by category (USD). */
export const SPEND: [string, number][] = [
  ["Model calls", 38.42],
  ["Market data", 4.1],
];
