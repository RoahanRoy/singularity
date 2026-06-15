"use client";

import { useEffect, useMemo, useState } from "react";
import { Panel } from "../primitives";
import {
  listAgents,
  listClusters,
  listMemos,
  listPositions,
  listBudgetLedger,
  listRecentTrades,
} from "@/lib/appwrite/queries";
import type {
  Agent,
  Cluster,
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

function fmtCount(n: number): string {
  return n.toLocaleString();
}

/** Agents that are doing work right now. */
const ACTIVE: Agent["status"][] = ["thinking", "executing"];

/** Friendly label for a raw model id (claude-opus-4-7 → OPUS-4.7). */
function modelLabel(model: string): string {
  const m = model.trim();
  const known = m.match(/^claude-(opus|sonnet|haiku)-([\d-]+)$/i);
  if (known) return `${known[1].toUpperCase()}-${known[2].replace(/-/g, ".")}`;
  if (/^gpt/i.test(m)) return m.toUpperCase();
  return m.toUpperCase();
}

// ── Agent fleet grid (driven by live agents) ──────────────────────────────────
// Replaces the old fictional GPU rack: every cell is a real agent, coloured by
// its live status. Utilization is the share of the fleet actually working.

const STATUS_RACK: Record<Agent["status"], string> = {
  executing: "hot",
  thinking: "warm",
  idle: "idle",
  blocked: "off",
  killed: "off",
};

function Fleet({ agents, clusters }: { agents: Agent[]; clusters: Cluster[] }) {
  // Headline scale: the swarm advertises far more agents than we sample into the
  // `agents` collection, so the count comes from cluster headcount when present.
  const fleetTotal =
    clusters.reduce((s, c) => s + (c.agent_count || 0), 0) || agents.length;
  const activeShare =
    agents.length > 0
      ? agents.filter((a) => ACTIVE.includes(a.status)).length / agents.length
      : 0;
  const models = Array.from(new Set(agents.map((a) => a.model))).map(modelLabel);

  const cells = useMemo(
    () => agents.map((a) => ({ id: a.$id, cls: STATUS_RACK[a.status] ?? "idle", name: a.name, status: a.status })),
    [agents],
  );

  const title = "Agent Fleet · Live";
  const meta = fleetTotal
    ? `${fmtCount(fleetTotal)} agents · ${(activeShare * 100).toFixed(1)}% active · ${models.length} models`
    : "no agents reporting";

  return (
    <div className="panel" style={{ borderTop: 0 }}>
      <div className="panel-head">
        <span className="title">{title}</span>
        <span className="meta">{meta}</span>
      </div>
      <div className="rack">
        {cells.length === 0 ? (
          <div className="dim" style={{ gridColumn: "1 / -1", fontFamily: "var(--mono)", fontSize: 11, padding: 4 }}>
            No agents reporting.
          </div>
        ) : (
          cells.map((c) => (
            <div key={c.id} className={"u " + c.cls} title={`${c.name} · ${c.status}`} />
          ))
        )}
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

// ── Model routing (derived from the live model mix the fleet runs) ─────────────

type Route = { model: string; agents: number; load: number; status: "OK" | "degraded" };

function deriveRoutes(agents: Agent[]): Route[] {
  const by = new Map<string, Agent[]>();
  for (const a of agents) {
    const arr = by.get(a.model);
    if (arr) arr.push(a);
    else by.set(a.model, [a]);
  }
  const out: Route[] = [];
  for (const [model, list] of by) {
    const active = list.filter((a) => ACTIVE.includes(a.status)).length;
    const degraded = list.some((a) => a.status === "blocked" || a.status === "killed");
    out.push({
      model: modelLabel(model),
      agents: list.length,
      load: list.length > 0 ? active / list.length : 0,
      status: degraded ? "degraded" : "OK",
    });
  }
  return out.sort((a, b) => b.agents - a.agents);
}

function Routing({ routes }: { routes: Route[] }) {
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
        <span>MODEL</span><span>LOAD</span><span className="ms">AGENTS</span><span className="st">STATUS</span>
      </div>
      {routes.map((r) => (
        <div key={r.model} className="row">
          <span style={{ color: "var(--ink-0)" }}>{r.model}</span>
          <div className="b"><i style={{ width: Math.max(0, Math.min(1, r.load)) * 100 + "%" }} /></div>
          <span className="ms">{r.agents}</span>
          <span className="st" style={{ color: r.status === "OK" ? "var(--green)" : "var(--red)" }}>
            ● {r.status}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Telemetry (derived from fleet + ledger) ───────────────────────────────────

function MetricBlock({ k, v, sub, color }: { k: string; v: string; sub?: string; color?: string }) {
  return (
    <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--line-soft)" }}>
      <div className="mono" style={{ fontSize: 10, color: "var(--ink-3)", letterSpacing: "0.16em", textTransform: "uppercase" }}>{k}</div>
      <div className="mono" style={{ fontSize: 22, color: color || "var(--ink-0)", marginTop: 4 }}>{v}</div>
      {sub && <div className="mono" style={{ fontSize: 10.5, color: "var(--ink-3)", marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + "B";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

function Telemetry({
  agents,
  clusters,
  ledger,
}: {
  agents: Agent[];
  clusters: Cluster[];
  ledger: BudgetLedger[];
}) {
  const fleetTotal =
    clusters.reduce((s, c) => s + (c.agent_count || 0), 0) || agents.length;
  const activeShare =
    agents.length > 0
      ? agents.filter((a) => ACTIVE.includes(a.status)).length / agents.length
      : 0;
  const modelCount = new Set(agents.map((a) => a.model)).size;
  const blocked = agents.filter((a) => a.status === "blocked" || a.status === "killed").length;

  const llm = ledger.filter((l) => l.category === "llm");
  const computeSpend = ledger
    .filter((l) => l.category === "compute")
    .reduce((s, l) => s + l.amount_usd, 0);
  const llmSpend = llm.reduce((s, l) => s + l.amount_usd, 0);
  const tokens = llm.reduce((s, l) => s + (l.tokens ?? 0), 0);

  return (
    <>
      <MetricBlock k="Agent fleet" v={fmtCount(fleetTotal)} sub={`${clusters.length} clusters`} />
      <MetricBlock
        k="Fleet active"
        v={(activeShare * 100).toFixed(1) + "%"}
        sub={blocked ? `${blocked} blocked` : "thinking / executing"}
        color="var(--md-accent)"
      />
      <MetricBlock
        k="Tokens processed"
        v={tokens ? fmtTokens(tokens) : "—"}
        sub={`${modelCount} models in rotation`}
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

// ── Pipelines (derived from live clusters) ────────────────────────────────────
// Each cluster is a real processing pipeline with its own health signal.

function clusterStatus(health: number): { label: string; color: string } {
  if (health >= 0.6) return { label: "healthy", color: "var(--green)" };
  if (health >= 0.4) return { label: "strained", color: "var(--md-accent)" };
  return { label: "degraded", color: "var(--red)" };
}

const AGENT_DOT: Record<Agent["status"], string> = {
  executing: "var(--md-accent)",
  thinking: "var(--cyan)",
  idle: "var(--ink-4)",
  blocked: "var(--red)",
  killed: "var(--line-strong)",
};

function AgentRows({ agents }: { agents: Agent[] }) {
  if (agents.length === 0) {
    return (
      <div className="dim" style={{ fontSize: 10.5, padding: "4px 14px 6px 34px" }}>
        No sampled agents for this pipeline.
      </div>
    );
  }
  const sorted = agents.slice().sort((a, b) => {
    const aActive = ACTIVE.includes(a.status) ? 1 : 0;
    const bActive = ACTIVE.includes(b.status) ? 1 : 0;
    if (aActive !== bActive) return bActive - aActive;
    return b.conviction - a.conviction;
  });
  return (
    <div style={{ background: "var(--bg-1)", borderBottom: "1px solid var(--line-soft)" }}>
      {sorted.map((a) => (
        <div
          key={a.$id}
          title={`${a.status} · conviction ${(a.conviction * 100).toFixed(0)}%`}
          style={{
            display: "grid",
            gridTemplateColumns: "16px 1fr auto auto",
            padding: "3px 14px 3px 34px",
            gap: 10,
            alignItems: "center",
          }}
        >
          <span style={{ color: AGENT_DOT[a.status] ?? "var(--ink-4)", fontSize: 9 }}>●</span>
          <span style={{ color: "var(--ink-2)" }}>{a.name}</span>
          <span style={{ color: "var(--ink-3)" }}>{a.role}</span>
          <span style={{ color: "var(--ink-4)", textAlign: "right" }}>{modelLabel(a.model)}</span>
        </div>
      ))}
    </div>
  );
}

function PipelineList({ clusters, agents }: { clusters: Cluster[]; agents: Agent[] }) {
  const [open, setOpen] = useState<Set<string>>(new Set());

  const byCluster = useMemo(() => {
    const m = new Map<string, Agent[]>();
    for (const a of agents) {
      if (!a.cluster_id) continue;
      const arr = m.get(a.cluster_id);
      if (arr) arr.push(a);
      else m.set(a.cluster_id, [a]);
    }
    return m;
  }, [agents]);

  if (clusters.length === 0) {
    return (
      <div className="dim" style={{ fontFamily: "var(--mono)", fontSize: 11, padding: "12px 14px" }}>
        No pipelines registered.
      </div>
    );
  }

  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const sorted = clusters.slice().sort((a, b) => b.agent_count - a.agent_count);
  return (
    <div style={{ fontFamily: "var(--mono)", fontSize: 11 }}>
      {sorted.map((c) => {
        const st = clusterStatus(c.health);
        const sample = byCluster.get(c.$id) ?? [];
        const isOpen = open.has(c.$id);
        return (
          <div key={c.$id}>
            <div
              role="button"
              tabIndex={0}
              onClick={() => toggle(c.$id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  toggle(c.$id);
                }
              }}
              title={`health ${(c.health * 100).toFixed(0)}% · ${st.label}`}
              style={{
                display: "grid",
                gridTemplateColumns: "12px 16px 1fr auto",
                padding: "6px 14px",
                gap: 10,
                alignItems: "center",
                borderBottom: "1px solid var(--line-soft)",
                cursor: "pointer",
                userSelect: "none",
              }}
            >
              <span
                style={{
                  color: "var(--ink-4)",
                  transform: isOpen ? "rotate(90deg)" : "none",
                  transition: "transform 0.12s ease",
                  fontSize: 9,
                }}
              >
                ▶
              </span>
              <span style={{ color: st.color }}>●</span>
              <span style={{ color: "var(--ink-1)" }}>{c.name}</span>
              <span style={{ color: "var(--ink-3)" }}>{fmtCount(c.agent_count)} agents</span>
            </div>
            {isOpen && <AgentRows agents={sample} />}
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
  const [agents, setAgents] = useState<Agent[]>([]);
  const [clusters, setClusters] = useState<Cluster[]>([]);
  const [memos, setMemos] = useState<Memo[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [ledger, setLedger] = useState<BudgetLedger[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);

  useEffect(() => {
    let cancelled = false;
    const set = <T,>(fn: (v: T) => void) => (v: T) => { if (!cancelled) fn(v); };
    listAgents(200).then(set(setAgents)).catch(() => {});
    listClusters().then(set(setClusters)).catch(() => {});
    listMemos(20).then(set(setMemos)).catch(() => {});
    listPositions(50).then(set(setPositions)).catch(() => {});
    listBudgetLedger(200).then(set(setLedger)).catch(() => {});
    listRecentTrades(100).then(set(setTrades)).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const routes = useMemo(() => deriveRoutes(agents), [agents]);
  const venueCount = new Set(trades.map((t) => t.venue).filter(Boolean)).size;
  const kgMeta = `${memos.length} memos · ${positions.length} positions`;
  const strained = clusters.filter((c) => c.health < 0.4).length;
  const healthy = clusters.filter((c) => c.health >= 0.6).length;

  return (
    <div className="compute">
      <Fleet agents={agents} clusters={clusters} />

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
        meta={`${healthy} healthy · ${strained} degraded`}
        bodyClassName="tight"
      >
        <PipelineList clusters={clusters} agents={agents} />
      </Panel>

      <Panel title="Telemetry" bodyClassName="tight">
        <Telemetry agents={agents} clusters={clusters} ledger={ledger} />
      </Panel>

      <Panel title="Execution Venues" meta={`${venueCount} connected`} bodyClassName="tight">
        <Venues trades={trades} />
      </Panel>
    </div>
  );
}
