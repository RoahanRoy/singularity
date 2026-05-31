"use client";

import { useEffect, useMemo, useState } from "react";
import { Panel, UTCClock } from "../primitives";
import { clusters as fallbackClusters, feedSeed } from "@/lib/meridian/data";
import {
  listClusters,
  listRecentEvents,
  subscribeAgentEvents,
} from "@/lib/appwrite/queries";
import type { Cluster as DbCluster, AgentEvent } from "@/lib/appwrite/schema";

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

type Node = {
  id: string;
  cluster: string;
  x: number;
  y: number;
  r: number;
  color: string;
  active: boolean;
};

type CanvasDef = { id: string; name: string; x: number; y: number; count: number; color: string };
type CanvasCluster = { id: string; themeId: string; name: string; agents: number; color: "amber" | "cyan" };

// Fixed coordinate slots + decorative defaults. Live clusters are mapped onto
// these positions; when there's no live data the full set renders as fallback.
const FALLBACK_DEFS: CanvasDef[] = [
  { id: "earnings", name: "Earnings Forensics", x: 0.3,  y: 0.35, count: 42, color: "var(--md-accent)" },
  { id: "macro",    name: "Macro & Rates",      x: 0.68, y: 0.28, count: 36, color: "var(--md-accent)" },
  { id: "vol",      name: "Vol Surface",        x: 0.84, y: 0.55, count: 22, color: "var(--md-accent)" },
  { id: "equities", name: "Equities US",        x: 0.22, y: 0.62, count: 48, color: "var(--md-accent)" },
  { id: "credit",   name: "Credit & HY",        x: 0.5,  y: 0.78, count: 26, color: "var(--md-accent)" },
  { id: "geo",      name: "Geopolitical",       x: 0.78, y: 0.82, count: 20, color: "var(--md-accent)" },
  { id: "alt",      name: "Alt-Data",           x: 0.52, y: 0.18, count: 32, color: "var(--cyan)" },
  { id: "exec",     name: "Execution",          x: 0.1,  y: 0.3,  count: 16, color: "var(--cyan)" },
  { id: "risk",     name: "Risk Topology",      x: 0.92, y: 0.3,  count: 18, color: "var(--cyan)" },
];

function SwarmCanvas({ selectedCluster, clusters }: { selectedCluster: string; clusters: CanvasCluster[] }) {
  const { nodes, edges, clusterDefs } = useMemo(() => {
    const W = 1000, H = 700;
    const r = rngFactory(424242);
    const defs: CanvasDef[] = clusters.length
      ? clusters.slice(0, FALLBACK_DEFS.length).map((c, i) => ({
          id: c.themeId || c.id,
          name: c.name,
          x: FALLBACK_DEFS[i].x,
          y: FALLBACK_DEFS[i].y,
          count: Math.max(6, Math.min(60, Math.round(c.agents) || 8)),
          color: c.color === "cyan" ? "var(--cyan)" : "var(--md-accent)",
        }))
      : FALLBACK_DEFS;
    const nodes: Node[] = [];
    defs.forEach((c) => {
      const cx = c.x * W, cy = c.y * H;
      const radius = 24 + Math.sqrt(c.count) * 7;
      for (let i = 0; i < c.count; i++) {
        const ang = r() * Math.PI * 2;
        const dist = Math.pow(r(), 0.65) * radius;
        nodes.push({
          id: c.id + "-" + i,
          cluster: c.id,
          x: cx + Math.cos(ang) * dist,
          y: cy + Math.sin(ang) * dist,
          r: 1.2 + r() * 1.6,
          color: c.color,
          active: r() < 0.18,
        });
      }
    });
    // Ring edges across whatever clusters exist, so the animated links render
    // for any id set — live themes or the fallback topology.
    const edges =
      defs.length > 1
        ? defs.map((A, i) => {
            const B = defs[(i + 1) % defs.length];
            return {
              id: `${A.id}-${B.id}-${i}`,
              x1: A.x * W, y1: A.y * H,
              x2: B.x * W, y2: B.y * H,
              delay: (i * 0.7) % 6,
            };
          })
        : [];
    return { nodes, edges, clusterDefs: defs };
  }, [clusters]);

  const [pulse, setPulse] = useState<{ x: number; y: number; color: string; key: number } | null>(null);
  useEffect(() => {
    const id = setInterval(() => {
      const n = nodes[Math.floor(Math.random() * nodes.length)];
      setPulse({ x: n.x, y: n.y, color: n.color, key: Date.now() });
    }, 900);
    return () => clearInterval(id);
  }, [nodes]);

  const viewW = 1000, viewH = 700;

  return (
    <div className="swarm-canvas">
      <div className="hud-tl">
        SWARM TOPOLOGY · v2.41
        <br />
        NODES {nodes.length.toLocaleString()} · EDGES {edges.length}
      </div>
      <div className="hud-tr">
        LIVE · 24/7
        <br />
        <UTCClock />
      </div>

      <svg viewBox={`0 0 ${viewW} ${viewH}`} preserveAspectRatio="xMidYMid meet">
        <g opacity="0.06" stroke="var(--ink-2)" strokeWidth="0.5">
          {Array.from({ length: 20 }).map((_, i) => (
            <line key={"v" + i} x1={i * 50} y1="0" x2={i * 50} y2={viewH} />
          ))}
          {Array.from({ length: 14 }).map((_, i) => (
            <line key={"h" + i} x1="0" y1={i * 50} x2={viewW} y2={i * 50} />
          ))}
        </g>

        {edges.map((e) => (
          <g key={e.id}>
            <line
              x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2}
              stroke="var(--cyan)" strokeOpacity="0.15" strokeWidth="0.6"
              strokeDasharray="2 4"
            />
            <circle r="2.2" fill="var(--cyan)">
              <animateMotion dur="6s" repeatCount="indefinite" begin={`${-e.delay}s`}
                path={`M${e.x1},${e.y1} L${e.x2},${e.y2}`} />
              <animate attributeName="opacity" values="0;1;0" dur="6s" repeatCount="indefinite" begin={`${-e.delay}s`} />
            </circle>
          </g>
        ))}

        {clusterDefs.map((c) => {
          const sel = selectedCluster === c.id;
          return (
            <g key={c.id}>
              <circle
                cx={c.x * viewW} cy={c.y * viewH}
                r={28 + Math.sqrt(c.count) * 7}
                fill="none"
                stroke={sel ? "var(--md-accent)" : "var(--line-strong)"}
                strokeOpacity={sel ? 0.9 : 0.35}
                strokeDasharray="3 5"
                strokeWidth={sel ? 1 : 0.6}
              />
              <text
                x={c.x * viewW}
                y={c.y * viewH - (32 + Math.sqrt(c.count) * 7)}
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

        {nodes.map((n) => (
          <circle key={n.id} cx={n.x} cy={n.y} r={n.r} fill={n.color} opacity={n.active ? 0.95 : 0.55} />
        ))}

        {pulse && (
          <g key={pulse.key}>
            <circle cx={pulse.x} cy={pulse.y} r="4" fill={pulse.color}>
              <animate attributeName="r" from="3" to="22" dur="1.2s" fill="freeze" />
              <animate attributeName="opacity" from="0.8" to="0" dur="1.2s" fill="freeze" />
            </circle>
            <circle cx={pulse.x} cy={pulse.y} r="2.4" fill={pulse.color} opacity="0.95" />
          </g>
        )}
      </svg>

      <div className="legend">
        <span><span className="dot" style={{ background: "var(--md-accent)" }} />RESEARCH AGENTS</span>
        <span><span className="dot" style={{ background: "var(--cyan)" }} />INFRASTRUCTURE AGENTS</span>
        <span><span className="dot" style={{ background: "var(--ink-3)" }} />IDLE</span>
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

function SwarmFeed({ clusterById }: { clusterById: Map<string, string> }) {
  const [items, setItems] = useState<FeedRow[]>(() =>
    feedSeed.slice(0, 8).map((s, i) => ({ id: "seed-" + i, cluster: s.c, agent: s.a, msg: s.msg, t: s.t })),
  );
  const [live, setLive] = useState(false);

  useEffect(() => {
    let cancelled = false;
    listRecentEvents(8)
      .then((events) => {
        if (cancelled || events.length === 0) return;
        setLive(true);
        setItems(
          events.map((e) => ({
            id: e.$id,
            cluster: (e.cluster_id && clusterById.get(e.cluster_id)) || "—",
            agent: "agent/" + e.agent_id.slice(-6),
            msg: e.summary,
            t: fmtAgo(e.occurred_at),
          })),
        );
      })
      .catch(() => {});
    const unsub = subscribeAgentEvents((ev: AgentEvent) => {
      if (cancelled) return;
      setLive(true);
      setItems((prev) =>
        [
          {
            id: ev.$id,
            cluster: (ev.cluster_id && clusterById.get(ev.cluster_id)) || "—",
            agent: "agent/" + ev.agent_id.slice(-6),
            msg: ev.summary,
            t: "0.1s",
          },
          ...prev,
        ].slice(0, 8),
      );
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [clusterById]);

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
  id: string;
  themeId: string;
  name: string;
  agents: number;
  conv: number;
  color: "amber" | "cyan";
};

export function SwarmScreen() {
  const [sel, setSel] = useState("earnings");
  const [list, setList] = useState<UIList[]>(() =>
    fallbackClusters.map((c) => ({
      id: c.id,
      themeId: c.id,
      name: c.name,
      agents: c.agents,
      conv: c.conv,
      color: c.color,
    })),
  );
  const [clusterById, setClusterById] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    let cancelled = false;
    listClusters()
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
        setClusterById(new Map(rows.map((c) => [c.$id, c.name])));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const total = list.reduce((s, c) => s + c.agents, 0);

  return (
    <div className="swarm">
      <Panel title="Clusters" meta={`${total.toLocaleString()} agents`} bodyClassName="tight">
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
          <span className="meta">{total.toLocaleString()} agents · 14 active threads · 0 anomalies</span>
        </div>
        <div className="panel-body tight" style={{ position: "relative", overflow: "hidden" }}>
          <SwarmCanvas selectedCluster={sel} clusters={list} />
        </div>
      </div>

      <Panel title="Activity Stream" meta="↓ live" bodyClassName="tight">
        <SwarmFeed clusterById={clusterById} />
      </Panel>
    </div>
  );
}
