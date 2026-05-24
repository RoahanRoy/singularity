// MERIDIAN — shared static data + tiny RNG
// Stable across renders so the design reads consistently.

window.MD = (function () {
  // seeded RNG
  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  const rng = mulberry32(20260524);
  const rand = (a, b) => a + rng() * (b - a);
  const pick = arr => arr[Math.floor(rng() * arr.length)];

  const clusters = [
    { id: "macro",    name: "Macro & Rates",          agents: 412, conv: 0.74, color: "amber" },
    { id: "equities", name: "Equities — US",          agents: 1284, conv: 0.61, color: "amber" },
    { id: "equities-eu", name: "Equities — Europe",   agents: 612, conv: 0.52, color: "amber" },
    { id: "vol",      name: "Volatility Surface",     agents: 184, conv: 0.83, color: "amber" },
    { id: "commod",   name: "Commodities",            agents: 244, conv: 0.40, color: "amber" },
    { id: "credit",   name: "Credit & HY",            agents: 198, conv: 0.55, color: "amber" },
    { id: "earnings", name: "Earnings Forensics",     agents: 524, conv: 0.91, color: "amber" },
    { id: "event",    name: "Event-Driven",           agents: 312, conv: 0.68, color: "amber" },
    { id: "geo",      name: "Geopolitical Intel.",    agents: 156, conv: 0.46, color: "amber" },
    { id: "alt",      name: "Alt-Data Synthesis",     agents: 388, conv: 0.62, color: "cyan" },
    { id: "exec",     name: "Execution Microstr.",    agents: 96,  conv: 0.79, color: "cyan" },
    { id: "risk",     name: "Risk & Topology",        agents: 142, conv: 0.88, color: "cyan" },
  ];

  // ticker
  const ticks = [
    ["ES", 5274.25, 0.42], ["NQ", 18430.5, 0.71], ["RTY", 2106.3, -0.15],
    ["DXY", 102.41, -0.08], ["UST10Y", 4.183, 0.024], ["JGB10Y", 0.992, -0.011],
    ["XAU", 2412.10, 0.32], ["WTI", 78.44, 1.18], ["BRENT", 82.10, 1.04],
    ["NVDA", 1184.20, 2.15], ["TSM", 174.80, 0.91], ["ASML", 968.40, -0.42],
    ["CL=H6", 79.10, 1.22], ["VIX", 13.41, -0.62], ["MOVE", 92.4, -1.10],
  ];

  // swarm activity feed
  const feedSeed = [
    { c: "Earnings Forensics", a: "agent/4f-2c1", msg: "<span class='h'>SEMI/TSM</span> — capex guidance language softened vs. Q2; mgmt tone -0.31σ", t: "0.3s" },
    { c: "Macro & Rates", a: "agent/m-118", msg: "<span class='h'>BoJ</span> intermeeting probability re-rated to <span class='h'>0.18</span> after Ueda remarks", t: "1.1s" },
    { c: "Vol Surface", a: "agent/v-22b", msg: "Term structure inversion in <span class='h'>SPX 1W/1M</span>; convex hedge candidate", t: "2.6s" },
    { c: "Geopolitical", a: "agent/g-09", msg: "Strait of Hormuz traffic anomaly — 3 vessels deviated, low priority", t: "3.4s" },
    { c: "Event-Driven", a: "agent/e-77", msg: "<span class='h'>MSFT/AVGO</span> patent litigation update; resolution probability +0.07", t: "4.0s" },
    { c: "Alt-Data", a: "agent/d-310", msg: "<span class='h'>NA truck-stop</span> diesel throughput -2.4% w/w, divergent from rail data", t: "5.1s" },
    { c: "Earnings Forensics", a: "agent/4f-118", msg: "Detected hedge against <span class='h'>NVDA</span> long thesis: <span class='h'>3 dissenters</span> escalated", t: "6.8s" },
    { c: "Risk", a: "agent/r-04", msg: "Tail-risk topology updated. Worst-1% drawdown re-estimated at <span class='h'>-2.81%</span>", t: "7.4s" },
    { c: "Execution", a: "agent/x-19", msg: "Iceberg routing on <span class='h'>ASML</span> — slippage tracking 0.4bp below model", t: "8.9s" },
    { c: "Macro & Rates", a: "agent/m-44", msg: "Cross-asset signal cluster forming: <span class='h'>DXY↑ / XAU↑ / UST10Y↓</span>", t: "9.7s" },
    { c: "Equities — US", a: "agent/eq-621", msg: "Quiet-period violation suspected, <span class='h'>$XYZ</span> ⇒ pause coverage", t: "11.2s" },
    { c: "Earnings Forensics", a: "agent/4f-9", msg: "Supplier deflection on <span class='h'>EV/CHRG</span> call — escalating to forensic tier", t: "12.0s" },
  ];

  const ticker = ticks.map(([s, p, d]) => ({ s, p, d }));

  return { rand, pick, clusters, ticker, feedSeed };
})();
