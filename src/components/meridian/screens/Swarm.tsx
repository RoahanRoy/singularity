"use client";

import { CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Panel, UTCClock } from "../primitives";
import { useMarket } from "../MarketContext";
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

const STATUS_COLOR: Record<DbAgent["status"], string> = {
  executing: "var(--cyan)",
  thinking:  "var(--md-accent)",
  blocked:   "#ff8a5c",
  killed:    "var(--ink-4)",
  idle:      "var(--ink-3)",
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
// The hand-placed slots cover the first eleven clusters. Past that, each extra
// slot is the grid point farthest from every slot already taken, so a desk
// with any number of clusters still draws all of them, in a stable layout.
function anchorSlots(n: number): { x: number; y: number }[] {
  const slots = ANCHOR_SLOTS.slice(0, n);
  if (slots.length >= n) return slots;
  const grid: { x: number; y: number }[] = [];
  for (let gx = 8; gx <= 92; gx += 4) {
    for (let gy = 12; gy <= 88; gy += 4) grid.push({ x: gx / 100, y: gy / 100 });
  }
  while (slots.length < n) {
    let best = grid[0];
    let bestD = -1;
    for (const g of grid) {
      let d = Infinity;
      for (const t of slots) d = Math.min(d, Math.hypot((g.x - t.x) * W, (g.y - t.y) * H));
      if (d > bestD) { bestD = d; best = g; }
    }
    slots.push(best);
  }
  return slots;
}

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

// Events don't name a recipient, but a desk cycle is a relay: each stage
// speaks within a second or two of the previous one handing over, while
// separate tickers are 30s+ apart. So a different agent speaking inside the
// window is read as that agent having messaged this one.
const LINK_WINDOW_MS = 20_000;
const TRAVEL_MS = 650; // spark down the synapse — matches .syn-spark
const FIRE_MS = 1400; // halo decay — matches .syn-halo
const HISTORY = 200; // recent events the synapses are learned from
const REPLAY_STEP_MS = 420;
const REPLAY_MAX = 80;
const RUN_GAP_MS = 10 * 60_000; // a quiet gap this long separates two runs

type Synapse = { from: string; to: string; weight: number };

/** One firing: `to` lights up; with a known sender, a spark runs to it first. */
type Fire = { key: number; from: string | null; to: string; color: string };

function senderOf(prev: AgentEvent | undefined, ev: AgentEvent): string | null {
  if (!prev || prev.agent_id === ev.agent_id) return null;
  const gap = Date.parse(ev.occurred_at) - Date.parse(prev.occurred_at);
  return gap >= 0 && gap <= LINK_WINDOW_MS ? prev.agent_id : null;
}

/** Every inferred hand-off in the history, weighted by how often it happened. */
function inferSynapses(oldestFirst: AgentEvent[]): Synapse[] {
  const byPair = new Map<string, Synapse>();
  for (let i = 1; i < oldestFirst.length; i++) {
    const from = senderOf(oldestFirst[i - 1], oldestFirst[i]);
    if (!from) continue;
    const to = oldestFirst[i].agent_id;
    const s = byPair.get(from + ">" + to);
    if (s) s.weight++;
    else byPair.set(from + ">" + to, { from, to, weight: 1 });
  }
  return [...byPair.values()];
}

/** The newest burst of events (no gap over RUN_GAP_MS), oldest first. */
function lastRun(newestFirst: AgentEvent[]): AgentEvent[] {
  const run: AgentEvent[] = [];
  for (const e of newestFirst) {
    const later = run[run.length - 1];
    if (later && Date.parse(later.occurred_at) - Date.parse(e.occurred_at) > RUN_GAP_MS) break;
    run.push(e);
    if (run.length >= REPLAY_MAX) break;
  }
  return run.reverse();
}

/** A curved axon from a to b. A→B and B→A bow to opposite sides, so both stay visible. */
function synapsePath(a: { x: number; y: number }, b: { x: number; y: number }): string {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const bend = Math.min(90, len * 0.22);
  const cx = (a.x + b.x) / 2 - (dy / len) * bend;
  const cy = (a.y + b.y) / 2 + (dx / len) * bend;
  return `M${a.x.toFixed(1)},${a.y.toFixed(1)} Q${cx.toFixed(1)},${cy.toFixed(1)} ${b.x.toFixed(1)},${b.y.toFixed(1)}`;
}

function SwarmCanvas({
  clusters,
  agents,
  selectedCluster,
  synapses,
  fires,
  replay,
  canReplay,
  onReplay,
}: {
  clusters: ClusterAnchor[];
  agents: DbAgent[];
  selectedCluster: string;
  synapses: Synapse[];
  fires: Fire[];
  replay: { at: number; n: number } | null;
  canReplay: boolean;
  onReplay: () => void;
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

  const posById = useMemo(() => new Map(placed.map((p) => [p.agent.$id, p])), [placed]);

  // Synapses between placed agents; the most-used hand-offs draw strongest.
  const wires = useMemo(() => {
    const max = Math.max(1, ...synapses.map((s) => s.weight));
    return synapses.flatMap((s) => {
      const a = posById.get(s.from);
      const b = posById.get(s.to);
      return a && b ? [{ id: s.from + ">" + s.to, d: synapsePath(a, b), k: s.weight / max }] : [];
    });
  }, [synapses, posById]);

  const clusterNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of clusters) m.set(c.id, c.name);
    return m;
  }, [clusters]);

  // The desks run in scheduled bursts, not around the clock, so the HUD shows
  // whether any agent is mid-step right now and, if not, when one last acted.
  const runState = useMemo(() => {
    let active = 0;
    let last: string | null = null;
    for (const a of agents) {
      if (a.status !== "idle" && a.status !== "killed") active++;
      if (a.last_action_at && (!last || Date.parse(a.last_action_at) > Date.parse(last))) last = a.last_action_at;
    }
    return { active, last };
  }, [agents]);

  // Custom hover tooltip. The dots are 2–3px in a 1000×700 viewBox, so each
  // gets a larger transparent hit circle; position is tracked in container px
  // (not SVG coords) so the HTML card sits exactly under the cursor.
  const containerRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{
    agent: DbAgent; x: number; y: number; flipX: boolean; flipY: boolean;
  } | null>(null);

  function onDotHover(agent: DbAgent, e: { clientX: number; clientY: number }) {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    setHover({ agent, x, y, flipX: x > rect.width - 240, flipY: y > rect.height - 150 });
  }

  return (
    <div className="swarm-canvas" ref={containerRef}>
      <div className="hud-tl">
        SWARM TOPOLOGY
        <br />
        AGENTS {placed.length.toLocaleString()} · SYNAPSES {wires.length}
      </div>
      <div className="hud-tr">
        {replay
          ? `REPLAY · ${replay.at}/${replay.n}`
          : runState.active > 0
            ? `LIVE · ${runState.active} ACTIVE`
            : runState.last
              ? `IDLE · LAST RUN ${fmtUtcStamp(runState.last)}`
              : "IDLE · NO RUNS YET"}
        <br />
        <UTCClock />
        {canReplay && (
          <>
            <br />
            <button className="hud-btn" onClick={onReplay} title="Replays the last run's hand-offs on the canvas">
              {replay ? "■ Stop replay" : "▶ Replay last run"}
            </button>
          </>
        )}
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet">
        <defs>
          <filter id="syn-bloom" x="-1" y="-1" width="3" height="3">
            <feGaussianBlur stdDeviation="2.5" />
          </filter>
        </defs>

        <g opacity="0.06" stroke="var(--ink-2)" strokeWidth="0.5">
          {Array.from({ length: 20 }).map((_, i) => (
            <line key={"v" + i} x1={i * 50} y1="0" x2={i * 50} y2={H} />
          ))}
          {Array.from({ length: 14 }).map((_, i) => (
            <line key={"h" + i} x1="0" y1={i * 50} x2={W} y2={i * 50} />
          ))}
        </g>

        {wires.map((w) => (
          <path key={w.id} d={w.d} className="syn" strokeOpacity={0.1 + 0.25 * w.k} strokeWidth={0.5 + 0.8 * w.k} />
        ))}

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

        {/* The signal travelling down the synapse, under the dots. */}
        {fires.map((f) => {
          const a = f.from ? posById.get(f.from) : undefined;
          const b = posById.get(f.to);
          if (!a || !b) return null;
          const d = synapsePath(a, b);
          return (
            <g key={"s" + f.key} style={{ "--syn": f.color } as CSSProperties}>
              <path d={d} pathLength={100} className="syn-trace" />
              <path d={d} pathLength={100} className="syn-spark" />
            </g>
          );
        })}

        {placed.map((p) => {
          const v = statusVisual(p.agent.status);
          const isHover = hover?.agent.$id === p.agent.$id;
          return (
            <g key={p.agent.$id}>
              {v.halo && (
                <circle cx={p.x} cy={p.y} r={v.r + 3} fill="none"
                        stroke={p.color} strokeOpacity="0.5" strokeWidth="0.6" />
              )}
              {isHover && (
                <circle cx={p.x} cy={p.y} r={v.r + 5} fill="none"
                        stroke={p.color} strokeOpacity="0.95" strokeWidth="0.9" />
              )}
              <circle
                cx={p.x} cy={p.y}
                r={isHover ? v.r + 1.4 : v.r}
                fill={p.color}
                opacity={isHover ? 1 : v.opacity}
              />
              {/* Enlarged transparent hit target so the tiny dots are hoverable. */}
              <circle
                cx={p.x} cy={p.y} r={Math.max(7, v.r + 5)}
                fill="transparent"
                style={{ cursor: "pointer" }}
                onMouseEnter={(e) => onDotHover(p.agent, e)}
                onMouseMove={(e) => onDotHover(p.agent, e)}
                onMouseLeave={() => setHover(null)}
              />
            </g>
          );
        })}

        {/* The receiving agent fires once the spark arrives. */}
        {fires.map((f) => {
          const b = posById.get(f.to);
          if (!b) return null;
          const delay = { animationDelay: (f.from && posById.has(f.from) ? TRAVEL_MS : 0) + "ms" };
          return (
            <g key={"f" + f.key} style={{ "--syn": f.color } as CSSProperties} pointerEvents="none">
              <circle cx={b.x} cy={b.y} r={7} className="syn-halo" filter="url(#syn-bloom)" style={delay} />
              <circle cx={b.x} cy={b.y} r={3} className="syn-core" style={delay} />
            </g>
          );
        })}
      </svg>

      <div className="legend">
        <span><span className="dot" style={{ background: "var(--md-accent)" }} />RESEARCH</span>
        <span><span className="dot" style={{ background: "var(--cyan)" }} />EXECUTION</span>
        <span><span className="dot" style={{ background: "#ff8a5c" }} />RISK</span>
        <span><span className="dot" style={{ background: "var(--ink-1)" }} />OPS</span>
      </div>

      {hover && (() => {
        const a = hover.agent;
        const cluster = (a.cluster_id && clusterNameById.get(a.cluster_id)) || "unassigned";
        const tx = hover.flipX ? "calc(-100% - 14px)" : "14px";
        const ty = hover.flipY ? "calc(-100% - 14px)" : "14px";
        return (
          <div
            className="swarm-tooltip"
            style={{ left: hover.x, top: hover.y, transform: `translate(${tx}, ${ty})` }}
          >
            <div className="tt-name">{a.name}</div>
            <div className="tt-row">
              <span style={{ color: ROLE_COLOR[a.role] ?? ROLE_COLOR.research }}>{a.role}</span>
              <span className="tt-status" style={{ color: STATUS_COLOR[a.status] }}>
                <span className="tt-dot" style={{ background: STATUS_COLOR[a.status] }} />
                {a.status}
              </span>
            </div>
            <div className="tt-meta">{cluster}</div>
            <div className="tt-meta">conv {a.conviction.toFixed(2)} · {a.model}</div>
            <div className="tt-meta">
              {a.last_action_at ? `acted ${fmtAgo(a.last_action_at)} ago` : "no actions yet"}
            </div>
          </div>
        );
      })()}
    </div>
  );
}

function fmtAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return Math.round(s) + "s";
  if (s < 3600) return Math.floor(s / 60) + "m";
  if (s < 86400) return Math.floor(s / 3600) + "h";
  return Math.floor(s / 86400) + "d";
}

function fmtUtcStamp(iso: string): string {
  const d = new Date(iso);
  const mon = d.toLocaleString("en-US", { month: "short", timeZone: "UTC" }).toUpperCase();
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${d.getUTCDate()} ${mon} ${hh}:${mm} UTC`;
}

// Every event carries a `kind`; cluster_id is often null, so the kind badge is
// the primary at-a-glance signal. Colors match the canvas role palette.
const KIND_META: Record<AgentEvent["kind"], { label: string; color: string }> = {
  alert:     { label: "alert",   color: "#ff8a5c" },
  handoff:   { label: "handoff", color: "var(--cyan)" },
  memo:      { label: "memo",    color: "var(--md-accent)" },
  trade:     { label: "trade",   color: "var(--md-accent)" },
  tool_call: { label: "tool",    color: "var(--ink-3)" },
  thought:   { label: "think",   color: "var(--ink-2)" },
};

function SwarmFeed({
  events,
  live,
  clusterById,
  agentById,
}: {
  events: AgentEvent[];
  live: boolean;
  clusterById: Map<string, string>;
  agentById: Map<string, DbAgent>;
}) {
  const rows = events.map((e) => {
    const agent = agentById.get(e.agent_id);
    const clusterId = e.cluster_id ?? agent?.cluster_id ?? null;
    return {
      id: e.$id,
      kind: KIND_META[e.kind] ?? KIND_META.thought,
      who: agent?.name ?? "agent/" + e.agent_id.slice(-6),
      cluster: (clusterId && clusterById.get(clusterId)) || null,
      msg: e.summary,
      t: fmtAgo(e.occurred_at),
    };
  });
  return (
    <div className="feed" data-live={live}>
      {rows.length === 0 ? (
        <div className="feed-item">
          <div className="feed-msg" style={{ color: "var(--ink-4)" }}>Awaiting agent activity…</div>
        </div>
      ) : (
        rows.map((r, i) => (
          <div className="feed-item" key={r.id}>
            <div className="top">
              <span className="kind" style={{ color: r.kind.color }}>{r.kind.label}</span>
              <span className="who">
                {r.who}
                {r.cluster ? <span style={{ color: "var(--ink-4)" }}> · {r.cluster}</span> : null}
              </span>
              <span style={{ marginLeft: "auto", flex: "none", color: "var(--ink-4)" }}>
                {i === 0 && live ? "live" : r.t}
              </span>
            </div>
            <div className="feed-msg" dangerouslySetInnerHTML={{ __html: r.msg }} />
          </div>
        ))
      )}
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

export function SwarmScreen() {
  const { market } = useMarket();
  const [sel, setSel] = useState("earnings");
  const [list, setList] = useState<UIList[]>([]);
  const [agents, setAgents] = useState<DbAgent[]>([]);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [live, setLive] = useState(false);
  const [fires, setFires] = useState<Fire[]>([]);
  const [replay, setReplay] = useState<{ at: number; n: number } | null>(null);
  const agentByIdRef = useRef<Map<string, DbAgent>>(new Map());
  const lastDeskEventRef = useRef<AgentEvent | undefined>(undefined);
  const fireSeq = useRef(0);
  const replayTimers = useRef<ReturnType<typeof setTimeout>[]>([]);

  // Load clusters for the active desk. Order by size, map onto anchor slots.
  // Re-runs when the market toggles; resets to that desk's fallback first.
  useEffect(() => {
    let cancelled = false;
    setList([]);
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

  const agentById = useMemo(
    () => new Map(agents.map((a) => [a.$id, a])),
    [agents],
  );

  // The event stream is shared by both desks; keep this desk's, newest first.
  const deskEvents = useMemo(
    () => events.filter((e) => agentById.has(e.agent_id)),
    [events, agentById],
  );
  const synapses = useMemo(() => inferSynapses(deskEvents.slice().reverse()), [deskEvents]);
  const run = useMemo(() => lastRun(deskEvents), [deskEvents]);

  // The realtime handler is subscribed once, so it reads the desk through refs.
  useEffect(() => {
    agentByIdRef.current = agentById;
    lastDeskEventRef.current = deskEvents[0];
  }, [agentById, deskEvents]);

  const fire = useCallback((from: string | null, ev: AgentEvent) => {
    const agent = agentByIdRef.current.get(ev.agent_id);
    if (!agent) return;
    const color = ev.kind === "alert" ? KIND_META.alert.color : (ROLE_COLOR[agent.role] ?? ROLE_COLOR.research);
    const key = ++fireSeq.current;
    setFires((prev) => [...prev, { key, from, to: ev.agent_id, color }].slice(-24));
    setTimeout(() => {
      setFires((prev) => prev.filter((f) => f.key !== key));
    }, TRAVEL_MS + FIRE_MS + 100);
  }, []);

  const stopReplay = useCallback(() => {
    replayTimers.current.forEach(clearTimeout);
    replayTimers.current = [];
    setReplay(null);
  }, []);

  // A replay and its sparks belong to one desk; switching desks ends them.
  useEffect(() => () => {
    stopReplay();
    setFires([]);
  }, [market, stopReplay]);

  // Load + subscribe events; each new one from this desk fires its agent.
  useEffect(() => {
    let cancelled = false;
    listRecentEvents(HISTORY).then((rows) => {
      if (cancelled || rows.length === 0) return;
      setLive(true);
      setEvents(rows);
    }).catch(() => {});

    const unsub = subscribeAgentEvents((ev) => {
      if (cancelled) return;
      setEvents((prev) => [ev, ...prev].slice(0, HISTORY));
      if (!agentByIdRef.current.has(ev.agent_id)) return;
      setLive(true);
      // Live activity takes the canvas over from a replay.
      if (replayTimers.current.length) stopReplay();
      fire(senderOf(lastDeskEventRef.current, ev), ev);
      lastDeskEventRef.current = ev;
    });
    return () => { cancelled = true; unsub(); };
  }, [fire, stopReplay]);

  // Plays the last run's real events back at a fixed pace.
  function toggleReplay() {
    if (replayTimers.current.length) {
      stopReplay();
      return;
    }
    const steps = run;
    steps.forEach((ev, i) => {
      replayTimers.current.push(setTimeout(() => {
        fire(senderOf(steps[i - 1], ev), ev);
        if (i < steps.length - 1) {
          setReplay({ at: i + 1, n: steps.length });
        } else {
          replayTimers.current = [];
          setReplay(null);
        }
      }, i * REPLAY_STEP_MS));
    });
    setReplay({ at: 0, n: steps.length });
  }

  const clusterById = useMemo(
    () => new Map(list.map((c) => [c.id, c.name])),
    [list],
  );

  // Build cluster anchors: largest clusters claim the first slots.
  const clusterAnchors: ClusterAnchor[] = useMemo(() => {
    const ranked = list.slice().sort((a, b) => b.agents - a.agents);
    const slots = anchorSlots(ranked.length);
    return ranked.map((c, i) => ({
      id: c.id,
      themeId: c.themeId,
      name: c.name,
      x: slots[i].x * W,
      y: slots[i].y * H,
      count: c.agents,
    }));
  }, [list]);

  const feed = deskEvents.slice(0, 8);
  const totalAgents = agents.length || list.reduce((s, c) => s + c.agents, 0);
  const activeThreads = agents.filter((a) => a.status !== "idle" && a.status !== "killed").length;
  const anomalies = feed.filter((e) => e.kind === "alert").length;

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
            synapses={synapses}
            fires={fires}
            replay={replay}
            canReplay={run.length > 1}
            onReplay={toggleReplay}
          />
        </div>
      </div>

      <Panel title="Activity Stream" meta={live ? "↓ live" : "↓ idle"} bodyClassName="tight">
        <SwarmFeed events={feed} live={live} clusterById={clusterById} agentById={agentById} />
      </Panel>
    </div>
  );
}
