// Screen 3: AI Portfolio Operating System
const { useState: useStateS3, useEffect: useEffectS3, useMemo: useMemoS3 } = React;

function genSpark(n, base, vol) {
  const arr = [base];
  for (let i = 1; i < n; i++) arr.push(arr[i - 1] + (Math.random() - 0.48) * vol);
  return arr;
}

function PnLChart() {
  const data = useMemoS3(() => {
    const arr = [0];
    for (let i = 1; i < 180; i++) arr.push(arr[i - 1] + (Math.random() - 0.46) * 0.14);
    return arr;
  }, []);
  const w = 600, h = 180;
  const min = Math.min(...data), max = Math.max(...data);
  const range = (max - min) || 1;
  const pts = data.map((v, i) => [(i / (data.length - 1)) * w, h - ((v - min) / range) * (h - 20) - 10]);
  const d = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(2) + "," + p[1].toFixed(2)).join(" ");
  const zeroY = h - ((0 - min) / range) * (h - 20) - 10;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ width: "100%", height: 180 }}>
      <defs>
        <linearGradient id="pnlFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.30" />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <g stroke="var(--line-soft)" strokeWidth="0.5">
        {[0.25, 0.5, 0.75].map((p, i) => <line key={i} x1="0" y1={h * p} x2={w} y2={h * p} />)}
      </g>
      <line x1="0" y1={zeroY} x2={w} y2={zeroY} stroke="var(--ink-4)" strokeDasharray="2 3" strokeWidth="0.6" />
      <path d={d + ` L${w},${h} L0,${h} Z`} fill="url(#pnlFill)" />
      <path d={d} fill="none" stroke="var(--accent)" strokeWidth="1.4" vectorEffect="non-scaling-stroke" />
      <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r="2.2" fill="var(--accent)" />
    </svg>
  );
}

function Exposures() {
  const rows = [
    { name: "US LARGE-CAP",   v: 0.72 },
    { name: "US SMALL-CAP",   v: 0.18 },
    { name: "EU EQUITIES",    v: 0.34 },
    { name: "JP EQUITIES",    v: 0.21 },
    { name: "EM EQUITIES",    v: -0.12 },
    { name: "INV-GRADE CR",   v: 0.46 },
    { name: "HIGH YIELD",     v: -0.08 },
    { name: "RATES 2-5Y",     v: -0.31 },
    { name: "RATES 10Y+",     v: 0.18 },
    { name: "FX · USD",       v: 0.24 },
    { name: "GOLD",           v: 0.41 },
    { name: "OIL / ENERGY",   v: -0.16 },
    { name: "VOL (VIX)",      v: 0.08 },
  ];
  return (
    <div>
      {rows.map((r, i) => (
        <div key={i} className="exposure-row">
          <span style={{ color: "var(--ink-2)", letterSpacing: "0.08em" }}>{r.name}</span>
          <div className="b">
            <span className="zero"></span>
            {r.v >= 0
              ? <i className="pos" style={{ width: (Math.abs(r.v) * 50) + "%" }} />
              : <i className="neg" style={{ width: (Math.abs(r.v) * 50) + "%" }} />
            }
          </div>
          <span style={{ color: r.v >= 0 ? "var(--green)" : "var(--red)", textAlign: "right" }}>
            {(r.v >= 0 ? "+" : "") + (r.v * 100).toFixed(1)}%
          </span>
          <span style={{ color: "var(--ink-3)", textAlign: "right", fontSize: 10 }}>β {(r.v * 1.2).toFixed(2)}</span>
        </div>
      ))}
    </div>
  );
}

function ScenarioTree() {
  return (
    <div className="scenario-tree">
      <div><span className="p">root</span></div>
      <div>├─ <span className="n">FOMC March</span> <span className="p">p=0.84</span></div>
      <div>│  ├─ <span className="n">hold @ 4.25</span> <span className="p">0.62</span> → <span className="v">+0.41%</span></div>
      <div>│  ├─ <span className="n">hawkish hold</span> <span className="p">0.28</span> → <span className="neg">−0.18%</span></div>
      <div>│  └─ <span className="n">cut 25bp</span>  <span className="p">0.10</span> → <span className="v">+1.12%</span></div>
      <div>├─ <span className="n">TSM Q4 print</span> <span className="p">p=1.00</span></div>
      <div>│  ├─ <span className="n">beat + soft guide</span> <span className="p">0.41</span> → <span className="v">+0.22%</span></div>
      <div>│  ├─ <span className="n">in-line</span>           <span className="p">0.34</span> → <span className="neg">−0.08%</span></div>
      <div>│  └─ <span className="n">miss</span>              <span className="p">0.25</span> → <span className="neg">−0.61%</span></div>
      <div>└─ <span className="n">Hormuz disruption</span>    <span className="p">p=0.06</span></div>
      <div>&nbsp;&nbsp;&nbsp;└─ <span className="n">tail event</span> → <span className="neg">−2.81%</span> <span className="p">(hedged: −0.44%)</span></div>
    </div>
  );
}

function VoteList() {
  const items = [
    { ticker: "NVDA", side: "ADD",  wt: "+0.30%", a: 7, n: 0, c: 0.78 },
    { ticker: "TSM",  side: "TRIM", wt: "−0.22%", a: 5, n: 1, c: 0.68 },
    { ticker: "GLD",  side: "ADD",  wt: "+0.15%", a: 4, n: 2, c: 0.55 },
    { ticker: "XHB",  side: "EXIT", wt: "−0.40%", a: 6, n: 1, c: 0.71 },
    { ticker: "EWJ",  side: "ADD",  wt: "+0.10%", a: 3, n: 1, c: 0.49 },
  ];
  return (
    <div>
      {items.map((it, i) => (
        <div key={i} style={{
          display: "grid", gridTemplateColumns: "70px 80px 1fr 60px 50px", gap: 10,
          padding: "8px 12px", borderBottom: "1px solid var(--line-soft)",
          fontFamily: "var(--mono)", fontSize: 11, alignItems: "center"
        }}>
          <span style={{ color: "var(--ink-0)" }}>{it.ticker}</span>
          <span style={{ color: it.side === "ADD" ? "var(--green)" : it.side === "EXIT" ? "var(--red)" : "var(--accent)", letterSpacing: "0.12em" }}>
            {it.side}
          </span>
          <span style={{ color: "var(--ink-2)" }}>{it.wt}</span>
          <span style={{ color: "var(--ink-2)" }}>{it.a} / {it.a + it.n}</span>
          <span style={{ color: "var(--ink-1)", textAlign: "right" }}>{it.c.toFixed(2)}</span>
        </div>
      ))}
    </div>
  );
}

function FactorHeatmap() {
  const factors = ["MOM", "VAL", "QUAL", "SIZE", "VOL", "GROWTH", "YIELD", "CARRY"];
  const sectors = ["TECH", "HEALTH", "FIN", "ENERGY", "DISC", "STAPLES", "INDU", "MATS", "UTIL", "RE", "COMM"];
  function val(i, j) {
    const seed = (i * 31 + j * 17) % 100;
    return ((seed / 100) - 0.5) * 2;
  }
  return (
    <div style={{ padding: "10px 12px", overflow: "auto" }}>
      <div style={{ display: "grid", gridTemplateColumns: "60px repeat(11, 1fr)", gap: 2, fontFamily: "var(--mono)", fontSize: 9.5, letterSpacing: "0.1em" }}>
        <div></div>
        {sectors.map(s => <div key={s} style={{ color: "var(--ink-3)", textAlign: "center" }}>{s}</div>)}
        {factors.map((f, i) => (
          <React.Fragment key={f}>
            <div style={{ color: "var(--ink-3)", display: "flex", alignItems: "center" }}>{f}</div>
            {sectors.map((s, j) => {
              const v = val(i, j);
              const isPos = v >= 0;
              const op = Math.min(0.95, 0.15 + Math.abs(v) * 0.85);
              const bg = isPos ? `oklch(0.74 0.10 155 / ${op})` : `oklch(0.70 0.13 25 / ${op})`;
              return (
                <div key={s + i} style={{
                  height: 22, background: bg,
                  display: "grid", placeItems: "center",
                  color: Math.abs(v) > 0.5 ? "#0a0a0a" : "var(--ink-1)",
                  fontSize: 9.5,
                }}>{v.toFixed(1)}</div>
              );
            })}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

function PortfolioScreen() {
  return (
    <div className="portfolio">
      <div className="panel span-row-2" style={{ borderTop: 0, borderBottom: 0, borderLeft: 0 }}>
        <div className="panel-head">
          <span className="title">Fund · Live</span>
          <span className="meta">NAV · Mark-to-Market · last tick 0.4s ago</span>
        </div>
        <div className="panel-body tight" style={{ overflow: "auto" }}>
          <div className="bigstat">
            <span className="k">Net Asset Value</span>
            <span className="v">$1,284,902,144</span>
            <span className="d up">+0.82% today · +$10.45M</span>
          </div>
          <div style={{ padding: "10px 16px" }}>
            <div className="mono" style={{ fontSize: 10, color: "var(--ink-3)", letterSpacing: "0.16em", textTransform: "uppercase", marginBottom: 8 }}>
              P&L · 180 sessions
            </div>
            <PnLChart />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 0, borderTop: "1px solid var(--line-soft)" }}>
            {[
              ["YTD", "+18.42%", "up"],
              ["MTD", "+3.18%", "up"],
              ["Sharpe", "2.41", ""],
              ["Sortino", "3.62", ""],
              ["Max DD", "−4.18%", "down"],
              ["Vol (30d)", "9.2%", ""],
              ["Hit rate", "61.4%", ""],
              ["Beta·SPX", "0.08", ""],
            ].map(([k, v, c], i) => (
              <div key={i} style={{
                padding: "12px 16px",
                borderRight: i % 2 === 0 ? "1px solid var(--line-soft)" : 0,
                borderBottom: i < 6 ? "1px solid var(--line-soft)" : 0,
                fontFamily: "var(--mono)",
              }}>
                <div style={{ fontSize: 10, color: "var(--ink-3)", letterSpacing: "0.12em", textTransform: "uppercase" }}>{k}</div>
                <div style={{ fontSize: 18, color: c === "up" ? "var(--green)" : c === "down" ? "var(--red)" : "var(--ink-0)", marginTop: 4 }}>{v}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <Panel title="Factor Exposures · Net" meta="rebalance in 1m 12s" bodyClassName="tight" className="">
        <Exposures />
      </Panel>

      <Panel title="Scenario Tree · 24h" meta="MC=20,000" bodyClassName="tight">
        <ScenarioTree />
      </Panel>

      <Panel title="Agent Vote · Pending Reallocation" meta="6 motions · quorum 0.55" bodyClassName="tight">
        <VoteList />
      </Panel>

      <Panel title="Factor × Sector Topology" meta="z-score · 30d" bodyClassName="tight">
        <FactorHeatmap />
      </Panel>
    </div>
  );
}

window.PortfolioScreen = PortfolioScreen;
