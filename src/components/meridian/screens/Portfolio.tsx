"use client";

import { useEffect, useMemo, useState } from "react";
import { Panel } from "../primitives";
import { listPositions, listPendingTrades, subscribeTrades } from "@/lib/appwrite/queries";
import type { Position, Trade } from "@/lib/appwrite/schema";

function PnLChart() {
  const data = useMemo(() => {
    const arr = [0];
    for (let i = 1; i < 180; i++) arr.push(arr[i - 1] + (Math.random() - 0.46) * 0.14);
    return arr;
  }, []);
  const w = 600, h = 180;
  const min = Math.min(...data), max = Math.max(...data);
  const range = max - min || 1;
  const pts = data.map((v, i) => [(i / (data.length - 1)) * w, h - ((v - min) / range) * (h - 20) - 10] as const);
  const d = pts.map(([x, y], i) => (i ? "L" : "M") + x.toFixed(2) + "," + y.toFixed(2)).join(" ");
  const zeroY = h - ((0 - min) / range) * (h - 20) - 10;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ width: "100%", height: 180 }}>
      <defs>
        <linearGradient id="pnlFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--md-accent)" stopOpacity="0.30" />
          <stop offset="100%" stopColor="var(--md-accent)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <g stroke="var(--line-soft)" strokeWidth="0.5">
        {[0.25, 0.5, 0.75].map((p, i) => (
          <line key={i} x1="0" y1={h * p} x2={w} y2={h * p} />
        ))}
      </g>
      <line x1="0" y1={zeroY} x2={w} y2={zeroY} stroke="var(--ink-4)" strokeDasharray="2 3" strokeWidth="0.6" />
      <path d={d + ` L${w},${h} L0,${h} Z`} fill="url(#pnlFill)" />
      <path d={d} fill="none" stroke="var(--md-accent)" strokeWidth="1.4" vectorEffect="non-scaling-stroke" />
      <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r="2.2" fill="var(--md-accent)" />
    </svg>
  );
}

function Exposures() {
  const rows = [
    { name: "US LARGE-CAP",  v:  0.72 },
    { name: "US SMALL-CAP",  v:  0.18 },
    { name: "EU EQUITIES",   v:  0.34 },
    { name: "JP EQUITIES",   v:  0.21 },
    { name: "EM EQUITIES",   v: -0.12 },
    { name: "INV-GRADE CR",  v:  0.46 },
    { name: "HIGH YIELD",    v: -0.08 },
    { name: "RATES 2-5Y",    v: -0.31 },
    { name: "RATES 10Y+",    v:  0.18 },
    { name: "FX · USD",      v:  0.24 },
    { name: "GOLD",          v:  0.41 },
    { name: "OIL / ENERGY",  v: -0.16 },
    { name: "VOL (VIX)",     v:  0.08 },
  ];
  return (
    <div>
      {rows.map((r, i) => (
        <div key={i} className="exposure-row">
          <span style={{ color: "var(--ink-2)", letterSpacing: "0.08em" }}>{r.name}</span>
          <div className="b">
            <span className="zero" />
            {r.v >= 0 ? (
              <i className="pos" style={{ width: Math.abs(r.v) * 50 + "%" }} />
            ) : (
              <i className="neg" style={{ width: Math.abs(r.v) * 50 + "%" }} />
            )}
          </div>
          <span style={{ color: r.v >= 0 ? "var(--green)" : "var(--red)", textAlign: "right" }}>
            {(r.v >= 0 ? "+" : "") + (r.v * 100).toFixed(1)}%
          </span>
          <span style={{ color: "var(--ink-3)", textAlign: "right", fontSize: 10 }}>
            β {(r.v * 1.2).toFixed(2)}
          </span>
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

type Vote = { id: string; ticker: string; side: string; wt: string; a: number; n: number; c: number };

const FALLBACK_VOTES: Vote[] = [
  { id: "v-0", ticker: "NVDA", side: "ADD",  wt: "+0.30%", a: 7, n: 0, c: 0.78 },
  { id: "v-1", ticker: "TSM",  side: "TRIM", wt: "−0.22%", a: 5, n: 1, c: 0.68 },
  { id: "v-2", ticker: "GLD",  side: "ADD",  wt: "+0.15%", a: 4, n: 2, c: 0.55 },
  { id: "v-3", ticker: "XHB",  side: "EXIT", wt: "−0.40%", a: 6, n: 1, c: 0.71 },
  { id: "v-4", ticker: "EWJ",  side: "ADD",  wt: "+0.10%", a: 3, n: 1, c: 0.49 },
];

function tradeToVote(t: Trade, navUsd = 1_284_902_144): Vote {
  // weight as notional / NAV; side label maps buy/sell to ADD/TRIM
  const notional = Math.abs(t.qty) * t.price;
  const wtPct = (t.side === "buy" ? 1 : -1) * (notional / navUsd) * 100;
  const sideLabel = t.side === "buy" ? "ADD" : Math.abs(t.qty) * t.price > navUsd * 0.003 ? "EXIT" : "TRIM";
  // deterministic mock vote tallies seeded off the document id
  const seed = t.$id.charCodeAt(0) + t.$id.charCodeAt(1);
  return {
    id: t.$id,
    ticker: t.ticker,
    side: sideLabel,
    wt: (wtPct >= 0 ? "+" : "−") + Math.abs(wtPct).toFixed(2) + "%",
    a: 3 + (seed % 5),
    n: seed % 3,
    c: 0.45 + ((seed * 7) % 40) / 100,
  };
}

function VoteList() {
  const [items, setItems] = useState<Vote[]>(FALLBACK_VOTES);

  useEffect(() => {
    let cancelled = false;
    listPendingTrades(8)
      .then((rows) => {
        if (cancelled || rows.length === 0) return;
        setItems(rows.map((t) => tradeToVote(t)));
      })
      .catch(() => {});
    const unsub = subscribeTrades(() => {
      if (cancelled) return;
      listPendingTrades(8).then((rows) => {
        if (!cancelled && rows.length > 0) setItems(rows.map((t) => tradeToVote(t)));
      }).catch(() => {});
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  return (
    <div>
      {items.map((it) => (
        <div
          key={it.id}
          style={{
            display: "grid",
            gridTemplateColumns: "70px 80px 1fr 60px 50px",
            gap: 10,
            padding: "8px 12px",
            borderBottom: "1px solid var(--line-soft)",
            fontFamily: "var(--mono)",
            fontSize: 11,
            alignItems: "center",
          }}
        >
          <span style={{ color: "var(--ink-0)" }}>{it.ticker}</span>
          <span
            style={{
              color:
                it.side === "ADD" ? "var(--green)" : it.side === "EXIT" ? "var(--red)" : "var(--md-accent)",
              letterSpacing: "0.12em",
            }}
          >
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

const FALLBACK_POSITIONS: Position[] = [
  { $id: "p-0", $createdAt: "", $updatedAt: "", ticker: "AVGO", qty: 9840,  avg_cost: 1240.10, market_value: 13_120_400, unrealized_pnl:  920_100, weight: 0.102, factor_exposures_json: null },
  { $id: "p-1", $createdAt: "", $updatedAt: "", ticker: "TSM",  qty: 62100, avg_cost: 168.42,  market_value: 11_820_900, unrealized_pnl:  264_500, weight: 0.092, factor_exposures_json: null },
  { $id: "p-2", $createdAt: "", $updatedAt: "", ticker: "GLD",  qty: 41200, avg_cost: 228.10,  market_value: 10_540_800, unrealized_pnl: 1_122_300, weight: 0.082, factor_exposures_json: null },
  { $id: "p-3", $createdAt: "", $updatedAt: "", ticker: "ASML", qty: 11200, avg_cost: 880.55,  market_value:  9_640_000, unrealized_pnl: -210_400, weight: 0.075, factor_exposures_json: null },
  { $id: "p-4", $createdAt: "", $updatedAt: "", ticker: "MSFT", qty: 21500, avg_cost: 408.20,  market_value:  9_412_000, unrealized_pnl:  632_100, weight: 0.073, factor_exposures_json: null },
  { $id: "p-5", $createdAt: "", $updatedAt: "", ticker: "NVDA", qty: 18420, avg_cost: 412.18,  market_value:  9_142_300, unrealized_pnl: 1_540_220, weight: 0.071, factor_exposures_json: null },
];

function fmtUsd(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (abs >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (abs >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return n.toFixed(0);
}

function PositionsList() {
  const [rows, setRows] = useState<Position[]>(FALLBACK_POSITIONS);

  useEffect(() => {
    let cancelled = false;
    listPositions(15)
      .then((p) => {
        if (cancelled || p.length === 0) return;
        setRows(p);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "70px 1fr 90px 90px 70px",
          gap: 10,
          padding: "6px 12px",
          fontFamily: "var(--mono)",
          fontSize: 10,
          color: "var(--ink-3)",
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          borderBottom: "1px solid var(--line-soft)",
        }}
      >
        <span>Ticker</span>
        <span>Qty</span>
        <span style={{ textAlign: "right" }}>MV</span>
        <span style={{ textAlign: "right" }}>uPnL</span>
        <span style={{ textAlign: "right" }}>Wt</span>
      </div>
      {rows.map((p) => (
        <div
          key={p.$id}
          style={{
            display: "grid",
            gridTemplateColumns: "70px 1fr 90px 90px 70px",
            gap: 10,
            padding: "8px 12px",
            borderBottom: "1px solid var(--line-soft)",
            fontFamily: "var(--mono)",
            fontSize: 11,
            alignItems: "center",
          }}
        >
          <span style={{ color: "var(--ink-0)" }}>{p.ticker}</span>
          <span style={{ color: "var(--ink-2)" }}>{p.qty.toLocaleString()}</span>
          <span style={{ color: "var(--ink-1)", textAlign: "right" }}>${fmtUsd(p.market_value)}</span>
          <span
            style={{
              color: p.unrealized_pnl >= 0 ? "var(--green)" : "var(--red)",
              textAlign: "right",
            }}
          >
            {p.unrealized_pnl >= 0 ? "+" : "−"}${fmtUsd(Math.abs(p.unrealized_pnl))}
          </span>
          <span style={{ color: "var(--ink-2)", textAlign: "right" }}>
            {(p.weight * 100).toFixed(2)}%
          </span>
        </div>
      ))}
    </div>
  );
}


export function PortfolioScreen() {
  const kpis: [string, string, "up" | "down" | ""][] = [
    ["YTD", "+18.42%", "up"],
    ["MTD", "+3.18%", "up"],
    ["Sharpe", "2.41", ""],
    ["Sortino", "3.62", ""],
    ["Max DD", "−4.18%", "down"],
    ["Vol (30d)", "9.2%", ""],
    ["Hit rate", "61.4%", ""],
    ["Beta·SPX", "0.08", ""],
  ];
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
            <div
              className="mono"
              style={{
                fontSize: 10,
                color: "var(--ink-3)",
                letterSpacing: "0.16em",
                textTransform: "uppercase",
                marginBottom: 8,
              }}
            >
              P&amp;L · 180 sessions
            </div>
            <PnLChart />
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 0,
              borderTop: "1px solid var(--line-soft)",
            }}
          >
            {kpis.map(([k, v, c], i) => (
              <div
                key={i}
                style={{
                  padding: "12px 16px",
                  borderRight: i % 2 === 0 ? "1px solid var(--line-soft)" : 0,
                  borderBottom: i < 6 ? "1px solid var(--line-soft)" : 0,
                  fontFamily: "var(--mono)",
                }}
              >
                <div
                  style={{
                    fontSize: 10,
                    color: "var(--ink-3)",
                    letterSpacing: "0.12em",
                    textTransform: "uppercase",
                  }}
                >
                  {k}
                </div>
                <div
                  style={{
                    fontSize: 18,
                    color: c === "up" ? "var(--green)" : c === "down" ? "var(--red)" : "var(--ink-0)",
                    marginTop: 4,
                  }}
                >
                  {v}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <Panel title="Factor Exposures · Net" meta="rebalance in 1m 12s" bodyClassName="tight">
        <Exposures />
      </Panel>

      <Panel title="Scenario Tree · 24h" meta="MC=20,000" bodyClassName="tight">
        <ScenarioTree />
      </Panel>

      <Panel title="Agent Vote · Pending Reallocation" meta="6 motions · quorum 0.55" bodyClassName="tight">
        <VoteList />
      </Panel>

      <Panel title="Positions · Live" meta="ranked by MV" bodyClassName="tight">
        <PositionsList />
      </Panel>
    </div>
  );
}
