export type Cluster = {
  id: string;
  name: string;
  agents: number;
  conv: number;
  color: "amber" | "cyan";
};

export type Tick = { s: string; p: number; d: number };

export type FeedItem = {
  c: string;
  a: string;
  msg: string;
  t: string;
};

function mulberry32(a: number) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = mulberry32(20260524);
export const rand = (a: number, b: number) => a + rng() * (b - a);
export const pick = <T>(arr: T[]): T => arr[Math.floor(rng() * arr.length)];

export const clusters: Cluster[] = [
  { id: "macro",       name: "Macro & Rates",       agents: 412,  conv: 0.74, color: "amber" },
  { id: "equities",    name: "Equities — US",       agents: 1284, conv: 0.61, color: "amber" },
  { id: "equities-eu", name: "Equities — Europe",   agents: 612,  conv: 0.52, color: "amber" },
  { id: "vol",         name: "Volatility Surface",  agents: 184,  conv: 0.83, color: "amber" },
  { id: "commod",      name: "Commodities",         agents: 244,  conv: 0.40, color: "amber" },
  { id: "credit",      name: "Credit & HY",         agents: 198,  conv: 0.55, color: "amber" },
  { id: "earnings",    name: "Earnings Forensics",  agents: 524,  conv: 0.91, color: "amber" },
  { id: "event",       name: "Event-Driven",        agents: 312,  conv: 0.68, color: "amber" },
  { id: "geo",         name: "Geopolitical Intel.", agents: 156,  conv: 0.46, color: "amber" },
  { id: "alt",         name: "Alt-Data Synthesis",  agents: 388,  conv: 0.62, color: "cyan" },
  { id: "exec",        name: "Execution Microstr.", agents: 96,   conv: 0.79, color: "cyan" },
  { id: "risk",        name: "Risk & Topology",     agents: 142,  conv: 0.88, color: "cyan" },
];

const rawTicks: [string, number, number][] = [
  ["ES", 5274.25, 0.42], ["NQ", 18430.5, 0.71], ["RTY", 2106.3, -0.15],
  ["DXY", 102.41, -0.08], ["UST10Y", 4.183, 0.024], ["JGB10Y", 0.992, -0.011],
  ["XAU", 2412.10, 0.32], ["WTI", 78.44, 1.18], ["BRENT", 82.10, 1.04],
  ["NVDA", 1184.20, 2.15], ["TSM", 174.80, 0.91], ["ASML", 968.40, -0.42],
  ["CL=H6", 79.10, 1.22], ["VIX", 13.41, -0.62], ["MOVE", 92.4, -1.10],
];

export const ticker: Tick[] = rawTicks.map(([s, p, d]) => ({ s, p, d }));

// ── India market ─────────────────────────────────────────────────────────────
// Shown when the operator switches the desk to Indian markets. Prices are
// indicative seeds for the marquee; live position data comes from Kite.
const rawTicksIN: [string, number, number][] = [
  ["NIFTY", 24010.6, 0.38], ["SENSEX", 79045.2, 0.31], ["BANKNIFTY", 51820.4, 0.52],
  ["NIFTYIT", 41230.8, -0.24], ["USDINR", 83.42, 0.06], ["INDIA10Y", 6.984, -0.012],
  ["GOLDMCX", 71240.0, 0.44], ["CRUDEMCX", 6612.0, 1.02], ["INDIAVIX", 13.82, -0.71],
  ["RELIANCE", 2948.5, 0.81], ["TCS", 3902.1, -0.18], ["HDFCBANK", 1678.3, 0.62],
  ["INFY", 1842.7, -0.33], ["ICICIBANK", 1142.9, 0.74], ["ITC", 438.6, 0.21],
];

export const tickerIN: Tick[] = rawTicksIN.map(([s, p, d]) => ({ s, p, d }));

// India-desk clusters (NSE). Mirrors the US set's shape so the Swarm screen
// renders them identically; infra clusters (alt/exec/risk) are shared.
export const clustersIN: Cluster[] = [
  { id: "macro",      name: "Macro & RBI",          agents: 318,  conv: 0.69, color: "amber" },
  { id: "equities",   name: "Equities — NSE",       agents: 1042, conv: 0.58, color: "amber" },
  { id: "banks",      name: "Banks & NBFC",         agents: 486,  conv: 0.71, color: "amber" },
  { id: "it",         name: "IT Services",          agents: 372,  conv: 0.55, color: "amber" },
  { id: "energy",     name: "Energy & Materials",   agents: 264,  conv: 0.47, color: "amber" },
  { id: "fmcgauto",   name: "FMCG & Auto",          agents: 298,  conv: 0.60, color: "amber" },
  { id: "pharma",     name: "Pharma & Health",      agents: 212,  conv: 0.64, color: "amber" },
  { id: "earnings",   name: "Earnings Forensics",   agents: 441,  conv: 0.88, color: "amber" },
  { id: "event",      name: "Event-Driven",         agents: 256,  conv: 0.66, color: "amber" },
  { id: "alt",        name: "Alt-Data Synthesis",   agents: 312,  conv: 0.61, color: "cyan" },
  { id: "exec",       name: "Execution Microstr.",  agents: 88,   conv: 0.77, color: "cyan" },
  { id: "risk",       name: "Risk & Topology",      agents: 128,  conv: 0.86, color: "cyan" },
];

export const feedSeed: FeedItem[] = [
  { c: "Earnings Forensics", a: "agent/4f-2c1", msg: "<span class='h'>SEMI/TSM</span> — capex guidance language softened vs. Q2; mgmt tone -0.31σ", t: "0.3s" },
  { c: "Macro & Rates",      a: "agent/m-118", msg: "<span class='h'>BoJ</span> intermeeting probability re-rated to <span class='h'>0.18</span> after Ueda remarks", t: "1.1s" },
  { c: "Vol Surface",        a: "agent/v-22b", msg: "Term structure inversion in <span class='h'>SPX 1W/1M</span>; convex hedge candidate", t: "2.6s" },
  { c: "Geopolitical",       a: "agent/g-09",  msg: "Strait of Hormuz traffic anomaly — 3 vessels deviated, low priority", t: "3.4s" },
  { c: "Event-Driven",       a: "agent/e-77",  msg: "<span class='h'>MSFT/AVGO</span> patent litigation update; resolution probability +0.07", t: "4.0s" },
  { c: "Alt-Data",           a: "agent/d-310", msg: "<span class='h'>NA truck-stop</span> diesel throughput -2.4% w/w, divergent from rail data", t: "5.1s" },
  { c: "Earnings Forensics", a: "agent/4f-118", msg: "Detected hedge against <span class='h'>NVDA</span> long thesis: <span class='h'>3 dissenters</span> escalated", t: "6.8s" },
  { c: "Risk",               a: "agent/r-04",  msg: "Tail-risk topology updated. Worst-1% drawdown re-estimated at <span class='h'>-2.81%</span>", t: "7.4s" },
  { c: "Execution",          a: "agent/x-19",  msg: "Iceberg routing on <span class='h'>ASML</span> — slippage tracking 0.4bp below model", t: "8.9s" },
  { c: "Macro & Rates",      a: "agent/m-44",  msg: "Cross-asset signal cluster forming: <span class='h'>DXY↑ / XAU↑ / UST10Y↓</span>", t: "9.7s" },
  { c: "Equities — US",      a: "agent/eq-621", msg: "Quiet-period violation suspected, <span class='h'>$XYZ</span> ⇒ pause coverage", t: "11.2s" },
  { c: "Earnings Forensics", a: "agent/4f-9",  msg: "Supplier deflection on <span class='h'>EV/CHRG</span> call — escalating to forensic tier", t: "12.0s" },
];

// India-desk activity seed (shown until live agent_events arrive in IN mode).
export const feedSeedIN: FeedItem[] = [
  { c: "Banks & NBFC",     a: "agent/b-114", msg: "<span class='h'>HDFCBANK</span> — NIM commentary firmer vs. prior quarter; deposit-cost glide flagged", t: "0.4s" },
  { c: "Macro & RBI",      a: "agent/m-07",  msg: "<span class='h'>RBI</span> MPC tone parsed dovish-neutral; OIS re-priced 4bp lower at 1Y", t: "1.3s" },
  { c: "IT Services",      a: "agent/it-22", msg: "<span class='h'>TCS/INFY</span> deal-TCV language softened; discretionary spend caution noted", t: "2.7s" },
  { c: "Equities — NSE",   a: "agent/eq-88", msg: "<span class='h'>RELIANCE</span> retail margin mix improving; O2C spreads neutral", t: "3.9s" },
  { c: "FMCG & Auto",      a: "agent/fa-31", msg: "Rural demand inflection in <span class='h'>HUL</span> volume prints — divergent from urban", t: "5.2s" },
  { c: "Pharma & Health",  a: "agent/ph-09", msg: "<span class='h'>SUNPHARMA</span> USFDA observation resolution probability +0.06", t: "6.6s" },
  { c: "Event-Driven",     a: "agent/e-12",  msg: "Block-deal flow detected in <span class='h'>ICICIBANK</span> — low priority", t: "8.1s" },
  { c: "Risk",             a: "agent/r-03",  msg: "India book tail-topology updated. Worst-1% drawdown re-estimated at <span class='h'>-2.34%</span>", t: "9.4s" },
];
