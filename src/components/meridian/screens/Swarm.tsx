"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Panel, UTCClock } from "../primitives";
import { useMarket } from "../MarketContext";
import { clusters as clustersUS, clustersIN, feedSeed, feedSeedIN } from "@/lib/meridian/data";
import {
  listAgents,
  listClusters,
  listRecentEvents,
  subscribeAgentEvents,
  subscribeAgents,
} from "@/lib/appwrite/queries";
import type { Agent as DbAgent, Cluster as DbCluster, AgentEvent } from "@/lib/appwrite/schema";

// Fixed anchor slots on the canvas. Live clusters are mapped onto these by
// rank (largest agent_count first), so the layout is stable across renders.
const ANCHOR_SLOTS: { x: number; y: number }[] = [
  { x: 0.30, y: 0.35 },
  { x: 0.68, y: 0.28 },
  { x: 0.84, y: 0.55 },
  { x: 0.22, y: 0.62 },
  { x: 0.50, y: 0.78 },
  { x: 0.78, y: 0.82 },
  { x: 0.52, y: 0.18 },
  { x: 0.10, y: 0.30 },
  { x: 0.92, y: 0.30 },
  { x: 0.16, y: 0.82 },
  { x: 0.42, y: 0.50 },
];

const ROLE_COLOR: Record<DbAgent["role"], string> = {
  research:  "var(--md-accent)",
  execution: "var(--cyan)",
  risk:      "#ff8a5c",
  ops:       "var(--ink-1)",
};

type Placed = {
  agent: DbAgent;
  x: number;
  y: number;
  color: string;
};

type ClusterAnchor = {
  id: string;
  themeId: string;
  name: string;
  x: number; // canvas px
  y: number; // canvas px
  count: number;
};

const W = 1000;
const H = 700;

/** Deterministic ring layout per cluster. Returns absolute canvas px. */
function layoutAgents(
  agents: DbAgent[],
  anchorByClusterId: Map<string, ClusterAnchor>,
): Placed[] {
  const byCluster = new Map<string, DbAgent[]>();
  for (const a of agents) {
    const cid = a.cluster_id ?? "__none__";
    const arr = byCluster.get(cid) ?? [];
    arr.push(a);
    byCluster.set(cid, arr);
  }
  const placed: Placed[] = [];
  for (const [cid, members] of byCluster) {
    const anchor = anchorByClusterId.get(cid);
    if (!anchor) continue;
    const n = members.length;
    const radius = Math.max(22, 18 + Math.sqrt(n) * 14);
    // Sort by $id so the visual position is stable across re-renders.
    members.sort((a, b) => a.$id.localeCompare(b.$id));
    members.forEach((agent, i) => {
      const ang = (i / Math.max(1, n)) * Math.PI * 2;
      // Pull slightly inward for inner ring when the cluster is large.
      const ringPull = n > 8 && i % 2 === 1 ? 0.65 : 1;
      placed.push({
        agent,
        x: anchor.x + Math.cos(ang) * radius * ringPull,
        y: anchor.y + Math.sin(ang) * radius * ringPull,
        color: ROLE_COLOR[agent.role] ?? ROLE_COLOR.research,
      });
    });
  }
  return placed;
}

function statusVisual(status: DbAgent["status"]): { opacity: number; halo: boolean; r: number } {
  switch (status) {
    case "executing": return { opacity: 1.0, halo: true,  r: 2.6 };
    case "thinking":  return { opacity: 0.95, halo: false, r: 2.4 };
    case "blocked":   return { opacity: 0.75, halo: false, r: 2.2 };
    case "killed":    return { opacity: 0.25, halo: false, r: 1.8 };
    case "idle":
    default:          return { opacity: 0.50, halo: false, r: 1.8 };
  }
}

type Pulse = { key: number; x: number; y: number; color: string; ttl: number };

function SwarmCanvas({
  clusters,
  agents,
  selectedCluster,
  pulses,
  handoffEdgeIds,
}: {
  clusters: ClusterAnchor[];
  agents: DbAgent[];
  selectedCluster: string;
  pulses: Pulse[];
  handoffEdgeIds: Set<string>;
}) {
  const anchorByClusterId = useMemo(() => {
    const m = new Map<string, ClusterAnchor>();
    for (const c of clusters) m.set(c.id, c);
    return m;
  }, [clusters]);

  const placed = useMemo(
    () => layoutAgents(agents, anchorByClusterId),
    [agents, anchorByClusterId],
  );

  // Ring edges across the ranked cluster list. The IDs match what nodes.ts
  // would address ("cluster:A→cluster:B"), so handoff events can light them up.
  const edges = useMemo(() => {
    if (clusters.length < 2) return [];
    return clusters.map((A, i) => {
      const B = clusters[(i + 1) % clusters.length];
      return {
        id: `${A.id}-${B.id}`,
        srcCluster: A.id,
        x1: A.x, y1: A.y,
        x2: B.x, y2: B.y,
      };
    });
  }, [clusters]);

  return (
    <div className="swarm-canvas">
      <div className="hud-tl">
        SWARM TOPOLOGY · v2.41
        <br />
        AGENTS {placed.length.toLocaleString()} · EDGES {edges.length}
      </div>
      <div className="hud-tr">
        LIVE · 24/7
        <br />
        <UTCClock />
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet">
        <g opacity="0.06" stroke="var(--ink-2)" strokeWidth="0.5">
          {Array.from({ length: 20 }).map((_, i) => (
            <line key={"v" + i} x1={i * 50} y1="0" x2={i * 50} y2={H} />
          ))}
          {Array.from({ length: 14 }).map((_, i) => (
            <line key={"h" + i} x1="0" y1={i * 50} x2={W} y2={i * 50} />
          ))}
        </g>

        {edges.map((e) => {
          const hot = handoffEdgeIds.has(e.id);
          return (
            <g key={e.id}>
              <line
                x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2}
                stroke="var(--cyan)"
                strokeOpacity={hot ? 0.6 : 0.12}
                strokeWidth={hot ? 1.1 : 0.6}
                strokeDasharray="2 4"
              />
              {hot && (
                <circle r="2.4" fill="var(--cyan)">
                  <animateMotion dur="1.6s" repeatCount="1"
                    path={`M${e.x1},${e.y1} L${e.x2},${e.y2}`} />
                  <animate attributeName="opacity" values="0;1;0" dur="1.6s" repeatCount="1" />
                </circle>
              )}
            </g>
          );
        })}

        {clusters.map((c) => {
          const sel = selectedCluster === c.themeId;
          return (
            <g key={c.id}>
              <circle
                cx={c.x} cy={c.y}
                r={Math.max(28, 22 + Math.sqrt(c.count) * 14) + 8}
                fill="none"
                stroke={sel ? "var(--md-accent)" : "var(--line-strong)"}
                strokeOpacity={sel ? 0.9 : 0.35}
                strokeDasharray="3 5"
                strokeWidth={sel ? 1 : 0.6}
              />
              <text
                x={c.x}
                y={c.y - (Math.max(28, 22 + Math.sqrt(c.count) * 14) + 14)}
                textAnchor="middle"
                fill={sel ? "var(--ink-0)" : "var(--ink-2)"}
                fontFamily="var(--mono)"
                fontSize="9"
                letterSpacing="1.6"
              >
                {c.name.toUpperCase()}
              </text>
            </g>
          );
        })}

        {placed.map((p) => {
          const v = statusVisual(p.agent.status);
          return (
            <g key={p.agent.$id}>
              {v.halo && (
                <circle cx={p.x} cy={p.y} r={v.r + 3} fill="none"
                        stroke={p.color} strokeOpacity="0.5" strokeWidth="0.6" />
              )}
              <circle cx={p.x} cy={p.y} r={v.r} fill={p.color} opacity={v.opacity}>
                <title>{`${p.agent.name} · ${p.agent.role} · ${p.agent.status}`}</title>
              </circle>
            </g>
          );
        })}

        {pulses.map((p) => (
          <g key={p.key}>
            <circle cx={p.x} cy={p.y} r="4" fill={p.color}>
              <animate attributeName="r" from="3" to="22" dur="1.2s" fill="freeze" />
              <animate attributeName="opacity" from="0.85" to="0" dur="1.2s" fill="freeze" />
            </circle>
            <circle cx={p.x} cy={p.y} r="2.4" fill={p.color} opacity="0.95" />
          </g>
        ))}
      </svg>

      <div className="legend">
        <span><span className="dot" style={{ background: "var(--md-accent)" }} />RESEARCH</span>
        <span><span className="dot" style={{ background: "var(--cyan)" }} />EXECUTION</span>
        <span><span className="dot" style={{ background: "#ff8a5c" }} />RISK</span>
        <span><span className="dot" style={{ background: "var(--ink-1)" }} />OPS</span>
      </div>
    </div>
  );
}

type FeedRow = { id: string; cluster: string; agent: string; msg: string; t: string };

function fmtAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return s.toFixed(1) + "s";
  if (s < 3600) return Math.floor(s / 60) + "m";
  return Math.floor(s / 3600) + "h";
}

function SwarmFeed({
  events,
  live,
  clusterById,
  market,
}: {
  events: AgentEvent[];
  live: boolean;
  clusterById: Map<string, string>;
  market: "US" | "IN";
}) {
  const seed = market === "IN" ? feedSeedIN : feedSeed;
  const items: FeedRow[] =
    events.length > 0
      ? events.map((e) => ({
          id: e.$id,
          cluster: (e.cluster_id && clusterById.get(e.cluster_id)) || "—",
          agent: "agent/" + e.agent_id.slice(-6),
          msg: e.summary,
          t: fmtAgo(e.occurred_at),
        }))
      : seed.slice(0, 8).map((s, i) => ({
          id: "seed-" + i,
          cluster: s.c,
          agent: s.a,
          msg: s.msg,
          t: s.t,
        }));
  return (
    <div className="feed" data-live={live}>
      {items.map((it, i) => (
        <div className="feed-item" key={it.id}>
          <div className="top">
            <span style={{ color: "var(--md-accent)" }}>● {it.cluster}</span>
            <span style={{ marginLeft: "auto" }}>{it.agent}</span>
            <span style={{ color: "var(--ink-4)" }}>{i === 0 && live ? "live" : it.t}</span>
          </div>
          <div className="msg" dangerouslySetInnerHTML={{ __html: it.msg }} />
        </div>
      ))}
    </div>
  );
}

const INFRA_THEMES = new Set(["alt", "exec", "risk"]);

type UIList = {
  id: string;        // appwrite $id (or fallback string id)
  themeId: string;   // theme slug
  name: string;
  agents: number;
  conv: number;
  color: "amber" | "cyan";
};

function fallbackList(market: "US" | "IN"): UIList[] {
  const src = market === "IN" ? clustersIN : clustersUS;
  return src.map((c) => ({
    id: c.id,
    themeId: c.id,
    name: c.name,
    agents: c.agents,
    conv: c.conv,
    color: c.color,
  }));
}

export function SwarmScreen() {
  const { market } = useMarket();
  const [sel, setSel] = useState("earnings");
  const [list, setList] = useState<UIList[]>(() => fallbackList(market));
  const [agents, setAgents] = useState<DbAgent[]>([]);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [live, setLive] = useState(false);
  const [pulses, setPulses] = useState<Pulse[]>([]);
  const [hotEdges, setHotEdges] = useState<Set<string>>(new Set());
  const agentPosRef = useRef<Map<string, { x: number; y: number; color: string }>>(new Map());
  const clusterAnchorsRef = useRef<ClusterAnchor[]>([]);

  // Load clusters for the active desk. Order by size, map onto anchor slots.
  // Re-runs when the market toggles; resets to that desk's fallback first.
  useEffect(() => {
    let cancelled = false;
    setList(fallbackList(market));
    listClusters(market)
      .then((rows: DbCluster[]) => {
        if (cancelled || rows.length === 0) return;
        const ui: UIList[] = rows.map((c) => ({
          id: c.$id,
          themeId: c.theme,
          name: c.name,
          agents: c.agent_count,
          conv: c.health,
          color: INFRA_THEMES.has(c.theme) ? "cyan" : "amber",
        }));
        setList(ui);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [market]);

  // Load + subscribe agents for the active desk.
  useEffect(() => {
    let cancelled = false;
    setAgents([]);
    listAgents(200, market).then((rows) => {
      if (cancelled) return;
      setAgents(rows);
    }).catch(() => {});
    const unsub = subscribeAgents((a) => {
      if (cancelled) return;
      // The realtime channel is collection-wide; keep only this desk's agents.
      const agentMarket = a.market ?? "US";
      if (agentMarket !== market) return;
      setAgents((prev) => {
        const ix = prev.findIndex((x) => x.$id === a.$id);
        if (ix < 0) return [...prev, a];
        const next = prev.slice();
        next[ix] = a;
        return next;
      });
    });
    return () => { cancelled = true; unsub(); };
  }, [market]);

  // Load + subscribe events; drive pulses + hot edges from real events.
  useEffect(() => {
    let cancelled = false;
    listRecentEvents(8).then((rows) => {
      if (cancelled || rows.length === 0) return;
      setLive(true);
      setEvents(rows);
    }).catch(() => {});

    const unsub = subscribeAgentEvents((ev) => {
      if (cancelled) return;
      setLive(true);
      setEvents((prev) => [ev, ...prev].slice(0, 8));

      // Pulse at the originating agent's last-known dot position.
      const pos = agentPosRef.current.get(ev.agent_id);
      if (pos) {
        const key = Date.now() + Math.random();
        setPulses((prev) => [...prev, { key, x: pos.x, y: pos.y, color: pos.color, ttl: 0 }].slice(-12));
        setTimeout(() => {
          setPulses((prev) => prev.filter((p) => p.key !== key));
        }, 1300);
      }

      // Light up an edge for handoff-kind events out of the originating cluster.
      if (ev.kind === "handoff" && ev.cluster_id) {
        const edges = clusterAnchorsRef.current;
        if (edges.length > 1) {
          const idx = edges.findIndex((c) => c.id === ev.cluster_id);
          if (idx >= 0) {
            const next = edges[(idx + 1) % edges.length];
            const edgeId = `${edges[idx].id}-${next.id}`;
            setHotEdges((prev) => {
              const s = new Set(prev);
              s.add(edgeId);
              return s;
            });
            setTimeout(() => {
              setHotEdges((prev) => {
                const s = new Set(prev);
                s.delete(edgeId);
                return s;
              });
            }, 1700);
          }
        }
      }
    });
    return () => { cancelled = true; unsub(); };
  }, []);

  const clusterById = useMemo(
    () => new Map(list.map((c) => [c.id, c.name])),
    [list],
  );

  // Build cluster anchors: largest clusters claim the first slots.
  const clusterAnchors: ClusterAnchor[] = useMemo(() => {
    const ranked = list.slice().sort((a, b) => b.agents - a.agents).slice(0, ANCHOR_SLOTS.length);
    return ranked.map((c, i) => ({
      id: c.id,
      themeId: c.themeId,
      name: c.name,
      x: ANCHOR_SLOTS[i].x * W,
      y: ANCHOR_SLOTS[i].y * H,
      count: c.agents,
    }));
  }, [list]);

  // Track latest anchors + agent positions in refs so the event handler can
  // resolve pulse coordinates without re-subscribing.
  useEffect(() => {
    clusterAnchorsRef.current = clusterAnchors;
    const anchorMap = new Map(clusterAnchors.map((c) => [c.id, c]));
    const placed = layoutAgents(agents, anchorMap);
    const m = new Map<string, { x: number; y: number; color: string }>();
    for (const p of placed) m.set(p.agent.$id, { x: p.x, y: p.y, color: p.color });
    agentPosRef.current = m;
  }, [clusterAnchors, agents]);

  const totalAgents = agents.length || list.reduce((s, c) => s + c.agents, 0);
  const activeThreads = agents.filter((a) => a.status !== "idle" && a.status !== "killed").length;
  const anomalies = events.filter((e) => e.kind === "alert").length;

  return (
    <div className="swarm">
      <Panel title="Clusters" meta={`${totalAgents.toLocaleString()} agents`} bodyClassName="tight">
        <div className="cluster-list">
          {list.map((c) => (
            <div
              key={c.id}
              className={
                "cluster " +
                (c.color === "cyan" ? "cyan " : "") +
                (sel === c.themeId ? "sel" : "")
              }
              onClick={() => setSel(c.themeId)}
            >
              <div className="name">{c.name}</div>
              <div className="meta">{c.agents}</div>
              <div className="meta" style={{ gridColumn: "1 / -1" }}>
                conv <span className="mono" style={{ color: "var(--ink-1)" }}>{c.conv.toFixed(2)}</span>
              </div>
              <div className="bar"><i style={{ width: c.conv * 100 + "%" }} /></div>
            </div>
          ))}
        </div>
      </Panel>

      <div className="panel" style={{ borderTop: 0, borderBottom: 0 }}>
        <div className="panel-head">
          <span className="title">Swarm Topology</span>
          <span className="meta">
            {totalAgents.toLocaleString()} agents · {activeThreads} active · {anomalies} anomal{anomalies === 1 ? "y" : "ies"}
          </span>
        </div>
        <div className="panel-body tight" style={{ position: "relative", overflow: "hidden" }}>
          <SwarmCanvas
            clusters={clusterAnchors}
            agents={agents}
            selectedCluster={sel}
            pulses={pulses}
            handoffEdgeIds={hotEdges}
          />
        </div>
      </div>

      <Panel title="Activity Stream" meta={live ? "↓ live" : "↓ idle"} bodyClassName="tight">
        <SwarmFeed events={events} live={live} clusterById={clusterById} market={market} />
      </Panel>
    </div>
  );
}
