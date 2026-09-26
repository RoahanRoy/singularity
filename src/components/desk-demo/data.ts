// Sample data for the marketing desk preview. Illustrative only — nothing here
// is read from, or written to, the live book.

export type DemoMarket = "US" | "IN";
export type DemoScreen = "portfolio" | "swarm" | "research" | "console" | "compute";

export const RNG = (seed: number) => {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

export const SCREENS: [DemoScreen, string, string, string][] = [
  ["portfolio", "Portfolio", "Capital", "pie_chart"],
  ["swarm", "Swarm", "Intelligence", "hub"],
  ["research", "Research", "Intelligence", "description"],
  ["console", "Console", "Operator", "forum"],
  ["compute", "Compute", "System", "memory"],
];

// id, label, x, y (0–1), agent count, infra?
export const TOPO: [string, string, number, number, number, 0 | 1][] = [
  ["earnings", "Earnings", 0.3, 0.36, 42, 0],
  ["macro", "Macro", 0.66, 0.26, 36, 0],
  ["vol", "Vol surface", 0.86, 0.58, 22, 0],
  ["equities", "Equities", 0.18, 0.68, 48, 0],
  ["credit", "Credit", 0.5, 0.76, 26, 0],
  ["geo", "Geopolitical", 0.74, 0.84, 20, 0],
  ["alt", "Alt-data", 0.5, 0.22, 32, 1],
  ["exec", "Execution", 0.09, 0.3, 16, 1],
  ["risk", "Risk", 0.93, 0.26, 18, 1],
];
export const LINKS: [string, string][] = [
  ["earnings", "equities"], ["earnings", "macro"], ["macro", "vol"], ["vol", "risk"],
  ["alt", "earnings"], ["alt", "macro"], ["equities", "credit"], ["credit", "risk"],
  ["geo", "macro"], ["geo", "credit"], ["exec", "equities"], ["exec", "vol"],
  ["alt", "geo"], ["risk", "credit"],
];
export const TOPO_NODES = (() => {
  const r = RNG(424242);
  const out: { id: string; x: number; y: number; r: number; inf: 0 | 1; active: boolean; delay: string }[] = [];
  TOPO.forEach(([id, , x, y, cnt, inf]) => {
    const rad = 18 + Math.sqrt(cnt) * 6.5;
    for (let i = 0; i < cnt; i++) {
      const a = r() * Math.PI * 2;
      const d = Math.pow(r(), 0.65) * rad;
      out.push({
        id,
        x: +(x * 1000 + Math.cos(a) * d).toFixed(1),
        y: +(y * 560 + Math.sin(a) * d).toFixed(1),
        r: +(1.6 + r() * 2).toFixed(2),
        inf,
        active: r() < 0.18,
        delay: (r() * 3).toFixed(2),
      });
    }
  });
  return out;
})();

export const NAVB: Record<DemoMarket, number> = { US: 1284902144, IN: 10724183400 };
// label, long label, points, seed, vol
export const RANGES: [string, string, number, number, number][] = [
  ["1D", "Today", 78, 11, 0.0012],
  ["1W", "Past week", 60, 23, 0.003],
  ["1M", "Past month", 90, 37, 0.006],
  ["3M", "Past 3 months", 90, 41, 0.009],
  ["YTD", "Year to date", 120, 53, 0.012],
  ["1Y", "Past year", 150, 67, 0.013],
];
export const RANGE_STEP_MS: Record<string, number> = {
  "1D": 6 * 60000, "1W": 3 * 3600000, "1M": 8 * 3600000, "3M": 86400000, YTD: 2 * 86400000, "1Y": 2.4 * 86400000,
};

export const TICKS: Record<DemoMarket, [string, number, number][]> = {
  US: [["ES", 5274.25, 0.42], ["NQ", 18430.5, 0.71], ["RTY", 2106.3, -0.15], ["DXY", 102.41, -0.08], ["UST10Y", 4.183, 0.024], ["XAU", 2412.1, 0.32], ["WTI", 78.44, 1.18], ["BRENT", 82.1, 1.04], ["VIX", 13.41, -0.62], ["MOVE", 92.4, -1.1]],
  IN: [["NIFTY", 24010.6, 0.38], ["SENSEX", 79045.2, 0.31], ["BANKNIFTY", 51820.4, 0.52], ["NIFTYIT", 41230.8, -0.24], ["USDINR", 83.42, 0.06], ["INDIA10Y", 6.984, -0.012], ["GOLDMCX", 71240.0, 0.44], ["CRUDEMCX", 6612.0, 1.02], ["INDIAVIX", 13.82, -0.71]],
};
export const HOLD: Record<DemoMarket, [string, number, number][]> = {
  US: [["NVDA", 1184.2, 2.15], ["TSM", 174.8, 0.91], ["ASML", 968.4, -0.42]],
  IN: [["RELIANCE", 2948.5, 0.81], ["HDFCBANK", 1678.3, 0.62], ["ICICIBANK", 1142.9, 0.74], ["TCS", 3902.1, -0.18], ["INFY", 1842.7, -0.33], ["ITC", 438.6, 0.21]],
};
export const NAMES: Record<string, string> = {
  NVDA: "NVIDIA", TSM: "Taiwan Semiconductor", ASML: "ASML Holding", RELIANCE: "Reliance Industries",
  HDFCBANK: "HDFC Bank", ICICIBANK: "ICICI Bank", TCS: "Tata Consultancy", INFY: "Infosys", ITC: "ITC Ltd",
};

// id, name, agents, conviction, infra?
export const CLU: Record<DemoMarket, [string, string, number, number, 0 | 1][]> = {
  US: [["macro", "Macro & Rates", 412, 0.74, 0], ["equities", "Equities — US", 1284, 0.61, 0], ["equities-eu", "Equities — Europe", 612, 0.52, 0], ["vol", "Volatility Surface", 184, 0.83, 0], ["commod", "Commodities", 244, 0.4, 0], ["credit", "Credit & HY", 198, 0.55, 0], ["earnings", "Earnings Forensics", 524, 0.91, 0], ["event", "Event-Driven", 312, 0.68, 0], ["geo", "Geopolitical Intel.", 156, 0.46, 0], ["alt", "Alt-Data Synthesis", 388, 0.62, 1], ["exec", "Execution Microstr.", 96, 0.79, 1], ["risk", "Risk & Topology", 142, 0.88, 1]],
  IN: [["macro", "Macro & RBI", 318, 0.69, 0], ["equities", "Equities — NSE", 1042, 0.58, 0], ["banks", "Banks & NBFC", 486, 0.71, 0], ["it", "IT Services", 372, 0.55, 0], ["energy", "Energy & Materials", 264, 0.47, 0], ["fmcgauto", "FMCG & Auto", 298, 0.6, 0], ["pharma", "Pharma & Health", 212, 0.64, 0], ["earnings", "Earnings Forensics", 441, 0.88, 0], ["event", "Event-Driven", 256, 0.66, 0], ["alt", "Alt-Data Synthesis", 312, 0.61, 1], ["exec", "Execution Microstr.", 88, 0.77, 1], ["risk", "Risk & Topology", 128, 0.86, 1]],
};
// cluster label, agent, message, cluster id
export const FEED: Record<DemoMarket, [string, string, string, string][]> = {
  US: [["Earnings Forensics", "agent/4f-2c1", "SEMI/TSM — capex guidance language softened vs. Q2; management tone −0.31σ", "earnings"], ["Macro & Rates", "agent/m-118", "BoJ intermeeting probability re-rated to 0.18 after Ueda remarks", "macro"], ["Vol Surface", "agent/v-22b", "Term-structure inversion in SPX 1W/1M; convex hedge candidate", "vol"], ["Geopolitical", "agent/g-09", "Strait of Hormuz traffic anomaly — 3 vessels deviated, low priority", "geo"], ["Event-Driven", "agent/e-77", "MSFT/AVGO patent litigation update; resolution probability +0.07", "event"], ["Alt-Data", "agent/d-310", "NA truck-stop diesel throughput −2.4% w/w, diverging from rail data", "alt"], ["Earnings Forensics", "agent/4f-118", "Hedge detected against NVDA long thesis: 3 dissenters escalated", "earnings"], ["Risk", "agent/r-04", "Tail-risk topology updated. Worst-1% drawdown re-estimated at −2.81%", "risk"], ["Execution", "agent/x-19", "Iceberg routing on ASML — slippage tracking 0.4bp below model", "exec"], ["Macro & Rates", "agent/m-44", "Cross-asset signal cluster forming: DXY↑ / XAU↑ / UST10Y↓", "macro"], ["Equities — US", "agent/eq-621", "Quiet-period violation suspected in $XYZ — coverage paused", "equities"], ["Earnings Forensics", "agent/4f-9", "Supplier deflection on EV/CHRG call — escalated to forensic tier", "earnings"]],
  IN: [["Banks & NBFC", "agent/b-114", "HDFCBANK — NIM commentary firmer vs. prior quarter; deposit-cost glide flagged", "banks"], ["Macro & RBI", "agent/m-07", "RBI MPC tone parsed dovish-neutral; OIS re-priced 4bp lower at 1Y", "macro"], ["IT Services", "agent/it-22", "TCS/INFY deal-TCV language softened; discretionary spend caution noted", "it"], ["Equities — NSE", "agent/eq-88", "RELIANCE retail margin mix improving; O2C spreads neutral", "equities"], ["FMCG & Auto", "agent/fa-31", "Rural demand inflection in HUL volume prints — diverging from urban", "fmcgauto"], ["Pharma & Health", "agent/ph-09", "SUNPHARMA USFDA observation resolution probability +0.06", "pharma"], ["Event-Driven", "agent/e-12", "Block-deal flow detected in ICICIBANK — low priority", "event"], ["Risk", "agent/r-03", "India book tail topology updated. Worst-1% drawdown re-estimated at −2.34%", "risk"]],
};

export const METRICS: [string, string, "up" | "down" | ""][] = [
  ["YTD", "+18.42%", "up"], ["MTD", "+3.18%", "up"], ["Sharpe", "2.41", ""], ["Max drawdown", "−4.18%", "down"],
  ["Sortino", "3.62", ""], ["Vol (30d)", "9.2%", ""], ["Hit rate", "61.4%", ""], ["Beta · SPX", "0.08", ""],
];
// ticker, side, weight, agents for, against, conviction
export const VOTES: [string, "Add" | "Trim" | "Exit", string, number, number, number][] = [
  ["NVDA", "Add", "+0.30%", 7, 0, 0.78], ["TSM", "Trim", "−0.22%", 5, 1, 0.68], ["GLD", "Add", "+0.15%", 4, 2, 0.55],
  ["XHB", "Exit", "−0.40%", 6, 1, 0.71], ["EWJ", "Add", "+0.10%", 3, 1, 0.49],
];
export const EXPO: [string, number][] = [
  ["US large-cap", 0.72], ["US small-cap", 0.18], ["EU equities", 0.34], ["JP equities", 0.21], ["EM equities", -0.12],
  ["Inv-grade credit", 0.46], ["High yield", -0.08], ["Rates 2–5Y", -0.31], ["Rates 10Y+", 0.18], ["FX · USD", 0.24],
  ["Gold", 0.41], ["Oil / energy", -0.16], ["Vol (VIX)", 0.08],
];
// name, probability label, outcomes [name, p, book impact %], note
export const SCEN: [string, string, [string, number, number][], string][] = [
  ["FOMC · March", "p 0.84", [["Hold 4.25", 0.62, 0.41], ["Hawkish hold", 0.28, -0.18], ["Cut 25bp", 0.1, 1.12]], ""],
  ["TSM Q4 print", "p 1.00", [["Beat, soft guide", 0.41, 0.22], ["In line", 0.34, -0.08], ["Miss", 0.25, -0.61]], ""],
  ["Hormuz disruption", "p 0.06", [["Tail event", 1, -2.81]], "Hedged impact −0.44%"],
];
export const FACT = ["MOM", "VAL", "QUAL", "SIZE", "VOL", "GROWTH", "YIELD", "CARRY"];
export const SECT = ["TECH", "HEALTH", "FIN", "ENERGY", "DISC", "STAPLES", "INDU", "MATS", "UTIL", "RE", "COMM"];

// source, ticker, title, when
export const DOCS: [string, string, string, string][] = [
  ["10-K", "NVDA", "Annual report — segment commentary on China-restricted SKUs and supply mix.", "0.4s ago"],
  ["Earnings call", "TSM", "Q4 2025 transcript — capex language softens; management deflects two questions on inventory.", "12s ago"],
  ["8-K", "AVGO", "Executive departure disclosure — CFO transition, no successor named.", "1m 4s ago"],
  ["13F", "BX", "Reported holdings reveal a −$340M reduction in semiconductor names.", "3m 12s ago"],
  ["S-1", "—", "Newly filed: vertical-AI infrastructure company; lead investors include a sovereign vehicle.", "8m ago"],
  ["News", "ASML", "Reuters — export-license clarification scheduled next month.", "11m ago"],
  ["Patent", "GOOG", "Granted: distillation method for sub-300B parameter models.", "23m ago"],
  ["Alt", "AMZN", "Truck-stop diesel throughput dataset — −2.4% w/w, NA corridors.", "31m ago"],
  ["Reg", "JPM", "Fed exam letter referenced in proxy; mention of liquidity stress overlay.", "47m ago"],
];
// speaker, segments [text, mark: a = hedging, b = reassurance, r = deflection]
export const TRANS: [string, [string, "" | "a" | "b" | "r"][]][] = [
  ["CFO · prepared remarks · 14:22", [["We continue to see ", ""], ["solid demand", "a"], [" across high-performance compute, with N-3 utilization remaining near historical peaks. However, our customers in the AI-accelerator segment are ", ""], ["re-pacing certain orders", "b"], [" as they reconcile build schedules with downstream platform readiness. We view this as a timing matter, not a demand matter.", ""]]],
  ["Analyst — Morgan Stanley", [["Could you help us understand the magnitude of that re-pacing? Is this concentrated in any customer or geography, and how should we think about Q1?", ""]]],
  ["CFO", [["We are ", ""], ["not in a position to disaggregate that today.", "r"], [" What I can say is that the overall picture for the year remains consistent with the framework we shared in October. We expect ", ""], ["capital expenditures in 2026 to be roughly in line with 2025", "a"], [", with some flex around equipment delivery timing.", ""]]],
  ["CEO", [["I want to add — we are extremely confident in the long-term trajectory. The conversations we are having with our largest customers are ", ""], ["as constructive as they have ever been.", "b"]]],
];
export const ENT: [string, string, number][] = [
  ["Taiwan Semiconductor (TSM)", "subject", 1.0], ["Apple (AAPL)", "customer", 0.78], ["NVIDIA (NVDA)", "customer", 0.74],
  ["ASML Holding (ASML)", "supplier", 0.63], ["Samsung Foundry", "competitor", 0.55], ["Intel Foundry", "competitor", 0.44],
  ["MediaTek (2454.TW)", "peer", 0.41], ["Sumco Corporation", "input", 0.33],
];
export const MEMO_NOTES: [string, string, string][] = [
  ["troubleshoot", "earnings/4f-118 · forensics", "“Solid demand” appears 14× this call vs. a mean of 4.1×. Hedging detected vs. last 8 prints. Confidence 0.82."],
  ["graphic_eq", "tone delta · vs. Q2 2025", "Management certainty −0.31σ. Two deflected questions. Cross-referenced with TSM and ASML supply commentary."],
  ["swap_vert", "thesis · auto-generated", "Long SOXX / short TSM 1M ATM call spread. Sized at 0.4% NAV. Waiting for PM review."],
];

export const RULES: [string, boolean][] = [
  ["Max single-name NAV ≤ 1.2%", true], ["China-linked semis ≤ 10.0%", true], ["Net leverage ≤ 2.8×", true],
  ["VaR (99, 1d) ≤ 1.8% NAV", true], ["Auto-execute under $5M notional", true], ["Voice-trade permission", false],
  ["Two-agent dissent → human review", true], ["Overnight power: PM only", false],
];
export const ACTIVE_AGENTS: [string, string, "accent" | "down" | "blue"][] = [
  ["earnings/4f-118", "TSM forensics", "accent"], ["earnings/4f-9", "supplier graph", "accent"], ["macro/m-44", "cross-asset", "accent"],
  ["risk/r-04", "dissenter", "down"], ["exec/x-19", "pacing", "blue"], ["alt/d-310", "diesel divergence", "blue"],
];
// model, share, latency ms, role
export const ROUTES: [string, number, number, string][] = [
  ["OPUS-4.7", 0.62, 412, "reasoning"], ["HAIKU-4.5", 0.88, 48, "ingest"], ["SONNET-4.6", 0.55, 188, "synth"],
  ["EMBED-V4", 0.91, 12, "retrieval"], ["RERANK-V2", 0.4, 22, "retrieval"], ["FORECAST-N", 0.71, 96, "tabular"],
  ["VISION-T", 0.18, 304, "charts"], ["MEM-LARGE", 0.66, 8, "memory"],
];
export const PIPES: [string, string][] = [
  ["filings-ingestion", "12.4K/h"], ["earnings-transcribe", "18 active"], ["news-multilingual", "2.4K/h"],
  ["alt-data-fusion", "84 streams"], ["patent-graph", "rebuild 22m"], ["macro-nowcaster", "step 14"],
  ["thesis-generator", "118 queued"], ["backtest-orchestrator", "running"], ["execution-routing", "13 venues"],
  ["compliance-watch", "0 alerts"],
];
export const VENUES: [string, string][] = [
  ["NYSE / ARCA", "0.42ms"], ["NASDAQ", "0.38ms"], ["CBOE", "0.51ms"], ["ICE Futures", "0.62ms"], ["CME Globex", "0.58ms"],
  ["LSE / Cboe EU", "1.12ms"], ["Eurex", "1.08ms"], ["TSE / Osaka", "1.84ms"], ["HKEX", "2.10ms"], ["SGX", "2.14ms"],
];

export type DemoMsg = {
  u: 0 | 1;
  name?: string;
  text: string;
  quote?: string;
  card?: string;
  actions?: boolean;
  rows?: [string, string][];
};
export const MSGS: DemoMsg[] = [
  { u: 1, text: "Show me all high-conviction positions from post-earnings supplier dislocations in the last 72 hours." },
  { u: 0, name: "Meridian · synthesizer", text: "Found *7 positions* that fit. Three come from the TSM call (supplier side); four trace to AVGO and the CHRG/EV cluster. Median conviction *0.74*, median horizon *11 days*.", card: "Positions · post-earnings supplier dislocation", rows: [["Long", "SOXX · 0.62%"], ["Long", "ASML · 0.30%"], ["Short", "TSM 1M ATM call spread · 0.40%"], ["Pair", "AVGO / MRVL · 0.18% / −0.18%"], ["Long", "CHRG 2W puts · 0.12%"], ["Hedge", "VIX 1M call spread · 0.20%"], ["Long", "SMCI · 0.14%"], ["Sharpe (port.)", "1.82"]] },
  { u: 1, text: "Reduce China-linked semiconductor exposure by 15%. Preserve idiosyncratic alpha. Run pre-trade through the new risk overlay." },
  { u: 0, name: "Meridian · portfolio orchestrator", text: "I modelled three execution paths. Path B keeps *87%* of idiosyncratic alpha and cuts China-linked semis from *9.4%* to *8.0%*. The risk overlay passes. 28 sub-agents took part; 2 dissented and asked for human review.", quote: "Dissent · risk/topology-04: this unwind is correlated with our SOXX long. Consider pacing over 2 sessions to avoid internal hedging cost.", card: "Proposed orders · path B · staged over 2 sessions", actions: true, rows: [["Reduce", "TSM ADR · −0.62%"], ["Reduce", "SMIC HK · −0.31%"], ["Reduce", "SOXX (paced)"], ["Keep", "ASML, AVGO, NVDA"], ["Slippage est.", "2.4bp"], ["Alpha kept", "87%"], ["Δ VaR", "−0.08%"], ["Time to fill", "~46 min"]] },
  { u: 1, text: "Spawn deeper forensic agents on the TSM filing anomaly. Limit 8 agents, $480 inference budget." },
  { u: 0, name: "Meridian · agent orchestrator", text: "Spawned *8 forensic agents* across language, tone, supplier graph, options skew, patents and management history. Budget capped at *$480* ($61 expected). Findings will land in the TSM memo as numbered sub-reports. ETA *~7 minutes*." },
];
export const HINTS = ["Spawn an agent", "Add a guardrail", "Replay a scenario", "What's my biggest risk?"];

export const fmtP = (p: number) =>
  p.toLocaleString("en-US", { minimumFractionDigits: p < 100 ? 3 : 2, maximumFractionDigits: p < 100 ? 3 : 2 });

export const spark = (seed: number, up: boolean) => {
  const r = RNG(seed);
  const s = [0];
  for (let i = 1; i < 24; i++) s.push(s[i - 1] + (r() - (up ? 0.4 : 0.6)));
  const mn = Math.min(...s);
  const rg = Math.max(...s) - mn || 1;
  return s.map((v, i) => (i ? "L" : "M") + ((i / 23) * 100).toFixed(1) + "," + (28 - ((v - mn) / rg) * 26).toFixed(1)).join(" ");
};

export function exchangeNow(m: DemoMarket, now = new Date()) {
  const off = m === "IN" ? 330 : -240;
  const l = new Date(now.getTime() + off * 60000);
  const d = l.getUTCDay();
  const z = (n: number) => String(n).padStart(2, "0");
  const clock = z(l.getUTCHours()) + ":" + z(l.getUTCMinutes()) + ":" + z(l.getUTCSeconds()) + (m === "IN" ? " IST" : " ET");
  if (d === 0 || d === 6) return { s: "closed" as const, clock };
  const mins = l.getUTCHours() * 60 + l.getUTCMinutes();
  const [o, c, p] = m === "IN" ? [555, 930, 540] : [570, 960, 480];
  const ae = m === "IN" ? 960 : 1200;
  const s = mins >= o && mins < c ? "open" : mins >= p && mins < o ? "pre" : mins >= c && mins < ae ? "after" : "closed";
  return { s: s as "open" | "pre" | "after" | "closed", clock };
}
