"use client";

import { useMemo } from "react";
import { Panel } from "../primitives";

function rngFactory(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function Rack({ title, meta }: { title: string; meta: string }) {
  const units = useMemo(() => {
    const r = rngFactory(7919);
    const out: string[] = [];
    for (let i = 0; i < 192; i++) {
      const v = r();
      let cls: string;
      if (v < 0.05) cls = "hot";
      else if (v < 0.3) cls = "warm";
      else if (v < 0.55) cls = "cool";
      else if (v < 0.85) cls = "idle";
      else cls = "off";
      out.push(cls);
    }
    return out;
  }, []);
  return (
    <div className="panel" style={{ borderTop: 0 }}>
      <div className="panel-head">
        <span className="title">{title}</span>
        <span className="meta">{meta}</span>
      </div>
      <div className="rack">
        {units.map((u, i) => (
          <div key={i} className={"u " + u} />
        ))}
      </div>
    </div>
  );
}

function KnowledgeGraph() {
  const W = 600, H = 380;
  const nodes = useMemo(() => {
    const r = rngFactory(99173);
    const labels = [
      "TSM", "NVDA", "AAPL", "ASML", "AVGO", "MRVL", "SMCI", "SOXX",
      "FED", "BoJ", "ECB", "PBoC", "DXY", "JPY", "USTs", "JGB",
      "WTI", "BRENT", "XAU", "VIX", "MOVE", "HY-OAS", "China Semi", "EU AI Act",
      "Hormuz", "Red Sea", "Taiwan Strait", "Diesel-NA", "Rail-NA",
    ];
    return labels.map((l) => ({
      id: l,
      x: 40 + r() * (W - 80),
      y: 30 + r() * (H - 60),
      r: 2.6 + r() * 2.2,
    }));
  }, []);
  const edges = useMemo(() => {
    const r = rngFactory(2911);
    const out: [number, number][] = [];
    for (let i = 0; i < 36; i++) {
      const a = Math.floor(r() * nodes.length);
      let b = Math.floor(r() * nodes.length);
      if (b === a) b = (b + 1) % nodes.length;
      out.push([a, b]);
    }
    return out;
  }, [nodes]);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "100%" }} preserveAspectRatio="xMidYMid meet">
      {edges.map(([a, b], i) => (
        <line key={i} x1={nodes[a].x} y1={nodes[a].y} x2={nodes[b].x} y2={nodes[b].y}
          stroke="var(--cyan)" strokeOpacity="0.18" strokeWidth="0.6" />
      ))}
      {nodes.map((n) => (
        <g key={n.id}>
          <circle cx={n.x} cy={n.y} r={n.r} fill="var(--md-accent)" opacity="0.85" />
          <text x={n.x + n.r + 4} y={n.y + 3.2}
            fill="var(--ink-2)" fontFamily="var(--mono)" fontSize="9" letterSpacing="0.6">
            {n.id}
          </text>
        </g>
      ))}
    </svg>
  );
}

function Routing() {
  const rows = [
    { mdl: "OPUS-4.7",   pct: 0.62, ms: 412, st: "OK" },
    { mdl: "HAIKU-4.5",  pct: 0.88, ms: 48,  st: "OK" },
    { mdl: "SONNET-4.6", pct: 0.55, ms: 188, st: "OK" },
    { mdl: "EMBED-V4",   pct: 0.91, ms: 12,  st: "OK" },
    { mdl: "RERANK-V2",  pct: 0.40, ms: 22,  st: "OK" },
    { mdl: "FORECAST-N", pct: 0.71, ms: 96,  st: "OK" },
    { mdl: "VISION-T",   pct: 0.18, ms: 304, st: "OK" },
    { mdl: "MEM-LARGE",  pct: 0.66, ms: 8,   st: "OK" },
  ];
  return (
    <div className="routing">
      <div className="row" style={{ color: "var(--ink-3)", letterSpacing: "0.1em", borderBottom: "1px solid var(--line)" }}>
        <span>MODEL</span><span>LOAD</span><span className="ms">MS</span><span className="st">STATUS</span>
      </div>
      {rows.map((r, i) => (
        <div key={i} className="row">
          <span style={{ color: "var(--ink-0)" }}>{r.mdl}</span>
          <div className="b"><i style={{ width: r.pct * 100 + "%" }} /></div>
          <span className="ms">{r.ms}</span>
          <span className="st">● {r.st}</span>
        </div>
      ))}
    </div>
  );
}

function MetricBlock({ k, v, sub, color }: { k: string; v: string; sub?: string; color?: string }) {
  return (
    <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--line-soft)" }}>
      <div className="mono" style={{ fontSize: 10, color: "var(--ink-3)", letterSpacing: "0.16em", textTransform: "uppercase" }}>{k}</div>
      <div className="mono" style={{ fontSize: 22, color: color || "var(--ink-0)", marginTop: 4 }}>{v}</div>
      {sub && <div className="mono" style={{ fontSize: 10.5, color: "var(--ink-3)", marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function PipelineList() {
  const items = [
    { name: "filings-ingestion",     ev: "12.4K/h" },
    { name: "earnings-transcribe",   ev: "18 active" },
    { name: "news-multilingual",     ev: "2.4K/h" },
    { name: "alt-data-fusion",       ev: "84 streams" },
    { name: "patent-graph",          ev: "rebuild 22m" },
    { name: "macro-nowcaster",       ev: "step 14" },
    { name: "thesis-generator",      ev: "118 queued" },
    { name: "backtest-orchestrator", ev: "running" },
    { name: "execution-routing",     ev: "13 venues" },
    { name: "compliance-watch",      ev: "0 alerts" },
  ];
  return (
    <div style={{ fontFamily: "var(--mono)", fontSize: 11 }}>
      {items.map((it, i) => (
        <div
          key={i}
          style={{
            display: "grid",
            gridTemplateColumns: "16px 1fr auto",
            padding: "6px 14px",
            gap: 10,
            alignItems: "center",
            borderBottom: "1px solid var(--line-soft)",
          }}
        >
          <span style={{ color: "var(--green)" }}>●</span>
          <span style={{ color: "var(--ink-1)" }}>{it.name}</span>
          <span style={{ color: "var(--ink-3)" }}>{it.ev}</span>
        </div>
      ))}
    </div>
  );
}

export function ComputeScreen() {
  const venues: [string, string, string][] = [
    ["NYSE / ARCA", "OK", "0.42ms"],
    ["NASDAQ", "OK", "0.38ms"],
    ["CBOE", "OK", "0.51ms"],
    ["ICE Futures", "OK", "0.62ms"],
    ["CME Globex", "OK", "0.58ms"],
    ["LSE / Cboe EU", "OK", "1.12ms"],
    ["Eurex", "OK", "1.08ms"],
    ["TSE / Osaka", "OK", "1.84ms"],
    ["HKEX", "OK", "2.10ms"],
    ["SGX", "OK", "2.14ms"],
  ];
  return (
    <div className="compute">
      <Rack title="GPU Fabric · DC-EAST · H100 / B200" meta="2,304 GPUs · 86.4% util · 41.2°C avg" />

      <Panel title="Model Routing · Inference Plane" meta="last 60s" bodyClassName="tight">
        <Routing />
      </Panel>

      <div className="panel" style={{ borderTop: 0 }}>
        <div className="panel-head">
          <span className="title">Knowledge Graph · Live</span>
          <span className="meta">4.2M entities · 38.1M edges</span>
        </div>
        <div className="panel-body tight kg">
          <KnowledgeGraph />
        </div>
      </div>

      <Panel title="Pipelines" meta="10 active · 0 failing" bodyClassName="tight">
        <PipelineList />
      </Panel>

      <Panel title="Telemetry" bodyClassName="tight">
        <MetricBlock k="Inference / sec" v="48,221" sub="rolling 60s" />
        <MetricBlock k="Tokens / day" v="1.84 B" sub="research + synthesis" color="var(--md-accent)" />
        <MetricBlock k="Memory · vector store" v="38.1 TB" sub="HNSW + IVF-PQ" />
        <MetricBlock k="Avg latency · plan→exec" v="612 ms" sub="p50" color="var(--cyan)" />
      </Panel>

      <Panel title="Execution Venues" meta="13 connected" bodyClassName="tight">
        <div style={{ fontFamily: "var(--mono)", fontSize: 11, padding: "8px 14px", lineHeight: 1.9 }}>
          {venues.map(([n, s, l]) => (
            <div key={n} style={{ display: "grid", gridTemplateColumns: "1fr 40px 60px", gap: 8 }}>
              <span style={{ color: "var(--ink-1)" }}>{n}</span>
              <span style={{ color: "var(--green)" }}>● {s}</span>
              <span style={{ color: "var(--ink-3)", textAlign: "right" }}>{l}</span>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}
