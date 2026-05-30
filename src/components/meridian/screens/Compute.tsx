"use client";

import { useEffect, useMemo, useState } from "react";
import { Panel } from "../primitives";
import {
  listComputeNodes,
  listModelRoutes,
  listPipelines,
  listMemos,
  listPositions,
  listBudgetLedger,
  listRecentTrades,
} from "@/lib/appwrite/queries";
import type {
  ComputeNode,
  ModelRoute,
  Pipeline,
  Memo,
  Position,
  BudgetLedger,
  Trade,
  MemoEntity,
} from "@/lib/appwrite/schema";

// ── helpers ────────────────────────────────────────────────────────────────

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

function fmtUsd(n: number): string {
  return "$" + n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

// ── GPU fabric rack (driven by compute_nodes) ─────────────────────────────────

function Rack({ nodes }: { nodes: ComputeNode[] }) {
  const totalGpus = nodes.reduce((s, n) => s + n.gpu_count, 0);
  const wUtil =
    totalGpus > 0
      ? nodes.reduce((s, n) => s + n.utilization * n.gpu_count, 0) / totalGpus
      : 0;
  const avgTemp =
    nodes.length > 0 ? nodes.reduce((s, n) => s + n.temp_c, 0) / nodes.length : 0;
  const zones = Array.from(new Set(nodes.map((n) => n.zone)));
  const models = Array.from(new Set(nodes.map((n) => n.gpu_model)));

  // 192 rack units, distributed across hot/warm/cool/idle/off so that the share
  // of "active" units tracks the measured fabric utilization.
  const units = useMemo(() => {
    const r = rngFactory(7919 + Math.round(wUtil * 1000));
    const out: string[] = [];
    for (let i = 0; i < 192; i++) {
      const v = r();
      let cls: string;
      if (v < wUtil * 0.12) cls = "hot";
      else if (v < wUtil * 0.5) cls = "warm";
      else if (v < wUtil) cls = "cool";
      else if (v < wUtil + (1 - wUtil) * 0.6) cls = "idle";
      else cls = "off";
      out.push(cls);
    }
    return out;
  }, [wUtil]);

  const title = zones.length
    ? `GPU Fabric · ${zones.join(" / ")} · ${models.join(" / ")}`
    : "GPU Fabric";
  const meta = totalGpus
    ? `${totalGpus.toLocaleString()} GPUs · ${(wUtil * 100).toFixed(1)}% util · ${avgTemp.toFixed(1)}°C avg`
    : "no fabric reporting";

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

// ── Knowledge graph (derived from memo entities + positions) ──────────────────

function KnowledgeGraph({ memos, positions }: { memos: Memo[]; positions: Position[] }) {
  const W = 600, H = 380;

  const { nodes, edges } = useMemo(() => {
    const labelSet = new Set<string>();
    const adjacency: [string, string][] = [];

    // entity co-occurrence inside each memo → edges from the subject outward
    for (const m of memos) {
      if (!m.entities_json) continue;
      let ents: MemoEntity[];
      try {
        ents = JSON.parse(m.entities_json);
      } catch {
        continue;
      }
      if (!Array.isArray(ents) || ents.length === 0) continue;
      const subject = ents.find((e) => e.role === "subject") ?? ents[0];
      const subjLabel = shortLabel(subject.name);
      labelSet.add(subjLabel);
      for (const e of ents) {
        if (e === subject) continue;
        const l = shortLabel(e.name);
        labelSet.add(l);
        adjacency.push([subjLabel, l]);
      }
    }

    // positions seed the graph too — tickers as standalone nodes
    for (const p of positions) labelSet.add(p.ticker);

    const labels = Array.from(labelSet).slice(0, 32);
    const r = rngFactory(99173 + labels.length);
    const placed = labels.map((l) => ({
      id: l,
      x: 40 + r() * (W - 80),
      y: 30 + r() * (H - 60),
      r: 2.6 + r() * 2.2,
    }));
    const idx = new Map(placed.map((n, i) => [n.id, i]));
    const edgeIdx: [number, number][] = [];
    for (const [a, b] of adjacency) {
      const ai = idx.get(a);
      const bi = idx.get(b);
      if (ai !== undefined && bi !== undefined) edgeIdx.push([ai, bi]);
    }
    return { nodes: placed, edges: edgeIdx };
  }, [memos, positions]);

  if (nodes.length === 0) {
    return (
      <div className="dim" style={{ fontFamily: "var(--mono)", fontSize: 11, padding: "16px" }}>
        No entities indexed yet — author a memo to populate the graph.
      </div>
    );
  }

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

function shortLabel(name: string): string {
  // prefer a parenthetical ticker, else the first token
  const m = name.match(/\(([^)]+)\)/);
  if (m) return m[1];
  return name.split(/\s+/)[0];
}

// ── Model routing (driven by model_routes) ────────────────────────────────────

function Routing({ routes }: { routes: ModelRoute[] }) {
  if (routes.length === 0) {
    return (
      <div className="dim" style={{ fontFamily: "var(--mono)", fontSize: 11, padding: "12px 14px" }}>
        No models reporting on the inference plane.
      </div>
    );
  }
  return (
    <div className="routing">
      <div className="row" style={{ color: "var(--ink-3)", letterSpacing: "0.1em", borderBottom: "1px solid var(--line)" }}>
        <span>MODEL</span><span>LOAD</span><span className="ms">MS</span><span className="st">STATUS</span>
      </div>
      {routes.map((r) => (
        <div key={r.$id} className="row">
          <span style={{ color: "var(--ink-0)" }}>{r.model}</span>
          <div className="b"><i style={{ width: Math.max(0, Math.min(1, r.load)) * 100 + "%" }} /></div>
          <span className="ms">{r.latency_ms}</span>
          <span className="st">● {r.status}</span>
        </div>
      ))}
    </div>
  );
}

// ── Telemetry (derived from fabric + routes + ledger) ─────────────────────────

function MetricBlock({ k, v, sub, color }: { k: string; v: string; sub?: string; color?: string }) {
  return (
    <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--line-soft)" }}>
      <div className="mono" style={{ fontSize: 10, color: "var(--ink-3)", letterSpacing: "0.16em", textTransform: "uppercase" }}>{k}</div>
      <div className="mono" style={{ fontSize: 22, color: color || "var(--ink-0)", marginTop: 4 }}>{v}</div>
      {sub && <div className="mono" style={{ fontSize: 10.5, color: "var(--ink-3)", marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function Telemetry({
  nodes,
  routes,
  ledger,
}: {
  nodes: ComputeNode[];
  routes: ModelRoute[];
  ledger: BudgetLedger[];
}) {
  const totalGpus = nodes.reduce((s, n) => s + n.gpu_count, 0);
  const wUtil =
    totalGpus > 0
      ? nodes.reduce((s, n) => s + n.utilization * n.gpu_count, 0) / totalGpus
      : 0;
  const avgLatency =
    routes.length > 0
      ? Math.round(routes.reduce((s, r) => s + r.latency_ms, 0) / routes.length)
      : 0;
  const computeSpend = ledger
    .filter((l) => l.category === "compute")
    .reduce((s, l) => s + l.amount_usd, 0);
  const llmSpend = ledger
    .filter((l) => l.category === "llm")
    .reduce((s, l) => s + l.amount_usd, 0);

  return (
    <>
      <MetricBlock k="GPU fabric" v={totalGpus.toLocaleString()} sub={`${nodes.length} zones`} />
      <MetricBlock
        k="Fabric utilization"
        v={(wUtil * 100).toFixed(1) + "%"}
        sub="GPU-weighted"
        color="var(--md-accent)"
      />
      <MetricBlock
        k="Avg inference latency"
        v={avgLatency ? avgLatency + " ms" : "—"}
        sub={`across ${routes.length} models`}
        color="var(--cyan)"
      />
      <MetricBlock
        k="Compute + LLM spend"
        v={fmtUsd(computeSpend + llmSpend)}
        sub="session ledger"
      />
    </>
  );
}

// ── Pipelines (driven by pipelines collection) ────────────────────────────────

function PipelineList({ pipelines }: { pipelines: Pipeline[] }) {
  if (pipelines.length === 0) {
    return (
      <div className="dim" style={{ fontFamily: "var(--mono)", fontSize: 11, padding: "12px 14px" }}>
        No pipelines registered.
      </div>
    );
  }
  return (
    <div style={{ fontFamily: "var(--mono)", fontSize: 11 }}>
      {pipelines.map((it) => {
        const color =
          it.status === "failing" ? "var(--red)" : it.status === "idle" ? "var(--ink-4)" : "var(--green)";
        return (
          <div
            key={it.$id}
            style={{
              display: "grid",
              gridTemplateColumns: "16px 1fr auto",
              padding: "6px 14px",
              gap: 10,
              alignItems: "center",
              borderBottom: "1px solid var(--line-soft)",
            }}
          >
            <span style={{ color }}>●</span>
            <span style={{ color: "var(--ink-1)" }}>{it.name}</span>
            <span style={{ color: "var(--ink-3)" }}>{it.throughput}</span>
          </div>
        );
      })}
    </div>
  );
}

// ── Execution venues (derived from trades) ────────────────────────────────────

function Venues({ trades }: { trades: Trade[] }) {
  const venues = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of trades) {
      if (!t.venue) continue;
      counts.set(t.venue, (counts.get(t.venue) || 0) + 1);
    }
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [trades]);

  if (venues.length === 0) {
    return (
      <div className="dim" style={{ fontFamily: "var(--mono)", fontSize: 11, padding: "8px 14px" }}>
        No venue connections recorded.
      </div>
    );
  }

  return (
    <div style={{ fontFamily: "var(--mono)", fontSize: 11, padding: "8px 14px", lineHeight: 1.9 }}>
      {venues.map(([name, count]) => (
        <div key={name} style={{ display: "grid", gridTemplateColumns: "1fr 50px 70px", gap: 8 }}>
          <span style={{ color: "var(--ink-1)" }}>{name}</span>
          <span style={{ color: "var(--green)" }}>● OK</span>
          <span style={{ color: "var(--ink-3)", textAlign: "right" }}>
            {count} order{count === 1 ? "" : "s"}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Screen ────────────────────────────────────────────────────────────────────

export function ComputeScreen() {
  const [nodes, setNodes] = useState<ComputeNode[]>([]);
  const [routes, setRoutes] = useState<ModelRoute[]>([]);
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [memos, setMemos] = useState<Memo[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [ledger, setLedger] = useState<BudgetLedger[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);

  useEffect(() => {
    let cancelled = false;
    const set = <T,>(fn: (v: T) => void) => (v: T) => { if (!cancelled) fn(v); };
    listComputeNodes(20).then(set(setNodes)).catch(() => {});
    listModelRoutes(20).then(set(setRoutes)).catch(() => {});
    listPipelines(20).then(set(setPipelines)).catch(() => {});
    listMemos(20).then(set(setMemos)).catch(() => {});
    listPositions(50).then(set(setPositions)).catch(() => {});
    listBudgetLedger(200).then(set(setLedger)).catch(() => {});
    listRecentTrades(100).then(set(setTrades)).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const activePipes = pipelines.filter((p) => p.status === "running").length;
  const failingPipes = pipelines.filter((p) => p.status === "failing").length;
  const venueCount = new Set(trades.map((t) => t.venue).filter(Boolean)).size;
  const kgMeta = `${memos.length} memos · ${positions.length} positions`;

  return (
    <div className="compute">
      <Rack nodes={nodes} />

      <Panel title="Model Routing · Inference Plane" meta={`${routes.length} models`} bodyClassName="tight">
        <Routing routes={routes} />
      </Panel>

      <div className="panel" style={{ borderTop: 0 }}>
        <div className="panel-head">
          <span className="title">Knowledge Graph · Live</span>
          <span className="meta">{kgMeta}</span>
        </div>
        <div className="panel-body tight kg">
          <KnowledgeGraph memos={memos} positions={positions} />
        </div>
      </div>

      <Panel
        title="Pipelines"
        meta={`${activePipes} active · ${failingPipes} failing`}
        bodyClassName="tight"
      >
        <PipelineList pipelines={pipelines} />
      </Panel>

      <Panel title="Telemetry" bodyClassName="tight">
        <Telemetry nodes={nodes} routes={routes} ledger={ledger} />
      </Panel>

      <Panel title="Execution Venues" meta={`${venueCount} connected`} bodyClassName="tight">
        <Venues trades={trades} />
      </Panel>
    </div>
  );
}
