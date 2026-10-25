"use client";

import { useEffect, useState } from "react";
import { useDesk } from "../Shell";
import { useMarket } from "../MarketContext";
import {
  listAgents,
  listBudgetSince,
  listClusters,
  listRecentEvents,
  listRecentTrades,
  subscribeAgentEvents,
  subscribeAgents,
} from "@/lib/appwrite/queries";
import type { Agent, AgentEvent } from "@/lib/appwrite/schema";
import { ago, startOfToday, useLoad } from "./data";

/**
 * The agent fleet on the v2 layout: what the desk's agents are doing now, by
 * cluster, and what they last said. Agents, clusters, events, the spend
 * ledger and trades are all live rows; there is no spawn or per-cluster pause
 * endpoint, so the design's spawn form and toggles are left out (the worker
 * controls live on Console).
 */

const HISTORY = 200;
const ACTIVE: Agent["status"][] = ["thinking", "executing"];

const STATE: Record<Agent["status"], [string, string]> = {
  executing: ["Executing", "var(--accent)"],
  thinking: ["Thinking", "var(--accent)"],
  blocked: ["Blocked", "var(--down)"],
  killed: ["Stopped", "var(--ink-3)"],
  idle: ["Idle", "var(--ink-3)"],
};

const KIND: Record<AgentEvent["kind"], [string, string]> = {
  alert: ["Alert", "var(--down)"],
  handoff: ["Handoff", "var(--accent)"],
  memo: ["Memo", "var(--accent)"],
  trade: ["Trade", "var(--up)"],
  tool_call: ["Tool", "var(--ink-3)"],
  thought: ["Thought", "var(--ink-2)"],
};

/** Event summaries can carry inline markup; the trace shows them as text. */
const plain = (s: string) => s.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');

/** claude-opus-5-5 → Opus 5.5; anything else as stored. */
function modelLabel(model: string): string {
  const m = model.trim().match(/^claude-(opus|sonnet|haiku|fable)-([\d-]+)$/i);
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2].replace(/-/g, ".")}` : model;
}

export function AgentsScreen() {
  const { market } = useMarket();
  const { full, go } = useDesk();
  const [sel, setSel] = useState<string | null>(null);

  const base = useLoad(
    () => Promise.all([listClusters(market), listAgents(200, market)]),
    [market],
    [[], []] as [Awaited<ReturnType<typeof listClusters>>, Agent[]],
  );
  const spend = useLoad(
    () => listBudgetSince(startOfToday()).then((r) => ({ hit: r as Awaited<ReturnType<typeof listBudgetSince>> | null })),
    [],
    { hit: null },
  );
  const trades = useLoad(() => (full ? listRecentTrades(200) : Promise.resolve([])), [full], []);
  const events0 = useLoad(() => listRecentEvents(HISTORY), [], []);

  // Live rows on top of the loads: agent status changes and new events.
  const [liveAgents, setLiveAgents] = useState<{ market: string; byId: Record<string, Agent> }>({ market, byId: {} });
  const [liveEvents, setLiveEvents] = useState<AgentEvent[]>([]);
  useEffect(
    () =>
      subscribeAgents((a) => {
        if ((a.market ?? "US") !== market) return;
        setLiveAgents((l) => ({ market, byId: { ...(l.market === market ? l.byId : {}), [a.$id]: a } }));
      }),
    [market],
  );
  useEffect(() => subscribeAgentEvents((ev) => setLiveEvents((l) => [ev, ...l].slice(0, HISTORY))), []);

  const [clusters, agents0] = base ?? [[], []];
  const patch = liveAgents.market === market ? liveAgents.byId : {};
  const agents = [...agents0.map((a) => patch[a.$id] ?? a), ...Object.values(patch).filter((a) => !agents0.some((x) => x.$id === a.$id))];
  const agentById = new Map(agents.map((a) => [a.$id, a]));
  const clusterName = new Map(clusters.map((c) => [c.$id, c.name]));

  // The event stream is shared by both desks; keep this desk's.
  const seen = new Set<string>();
  const events = [...liveEvents, ...(events0 ?? [])]
    .filter((e) => agentById.has(e.agent_id) && !seen.has(e.$id) && (seen.add(e.$id), true))
    .sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : -1));

  const byCluster = new Map<string, Agent[]>();
  for (const a of agents) if (a.cluster_id) byCluster.set(a.cluster_id, [...(byCluster.get(a.cluster_id) ?? []), a]);
  const active = agents.filter((a) => ACTIVE.includes(a.status));
  const blocked = agents.filter((a) => a.status === "blocked");
  const lastAct = agents.reduce<string | null>((m, a) => (a.last_action_at && (!m || a.last_action_at > m) ? a.last_action_at : m), null);

  const selCluster = sel && clusters.find((c) => c.$id === sel) ? sel : null;
  const trace = events
    .filter((e) => !selCluster || (e.cluster_id ?? agentById.get(e.agent_id)?.cluster_id) === selCluster)
    .slice(0, full ? 40 : 12);

  const llm = spend?.hit?.rows ?? [];
  const spendUsd = llm.reduce((s, r) => s + r.amount_usd, 0);
  const tokens = llm.reduce((s, r) => s + (r.tokens ?? 0), 0);
  const partial = spend?.hit != null && spend.hit.total > spend.hit.rows.length;

  const models = new Map<string, { n: number; active: number }>();
  for (const a of agents) {
    const m = models.get(a.model) ?? { n: 0, active: 0 };
    m.n++;
    if (ACTIVE.includes(a.status)) m.active++;
    models.set(a.model, m);
  }
  const venues = new Map<string, number>();
  for (const t of trades ?? []) if (t.venue && (t.market ?? "US") === market) venues.set(t.venue, (venues.get(t.venue) ?? 0) + 1);

  const kv = (k: string, v: string, color?: string) => (
    <div key={k} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "8px 0", borderBottom: "1px solid var(--line)", fontSize: 13 }}>
      <span className="m-ink2">{k}</span>
      <span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: color ?? "var(--ink)" }}>{v}</span>
    </div>
  );

  return (
    <>
      <div className="m-card" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "12px 24px", padding: "14px 18px", marginBottom: 36 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span
            className={`m-dot${active.length ? " m-pulse" : ""}`}
            style={{ background: blocked.length ? "var(--down)" : active.length ? "var(--up)" : "var(--ink-3)" }}
          />
          <span style={{ fontWeight: 600 }}>
            {base == null
              ? "Loading…"
              : active.length
                ? `${active.length} agent${active.length === 1 ? "" : "s"} working`
                : agents.length
                  ? "Agents idle"
                  : "No agents on this desk"}
          </span>
        </div>
        <span className="m-sub" style={{ fontSize: 13 }}>
          {agents.length} agents in {clusters.length} clusters
          {blocked.length ? ` · ${blocked.length} blocked` : ""}
          {lastAct ? ` · last action ${ago(lastAct)} ago` : ""}
        </span>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginLeft: "auto", fontSize: 13 }}>
          <span className="m-ink2">Model spend today</span>
          <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>
            {spend == null ? "…" : spend.hit == null ? "—" : `${partial ? "≥ " : ""}$${spendUsd.toFixed(2)}`}
          </span>
          <span className="m-meta">both desks</span>
        </div>
        <button className="m-btn2" onClick={() => go("console")}>
          Agent controls
        </button>
      </div>

      <div className="m-cols2">
        <div className="m-stack" style={{ minWidth: 0 }}>
          <section>
            <div className="m-shead">
              <h2 className="m-h2">Clusters</h2>
              <span className="m-meta">{agents.length} agents</span>
            </div>
            {base != null && clusters.length === 0 && <p className="m-empty">No clusters registered on this desk yet.</p>}
            {clusters.length > 0 && (
              <div
                className="m-meta"
                style={{ display: "grid", gridTemplateColumns: "minmax(0,1.6fr) 70px minmax(60px,1fr) 70px", gap: 12, padding: "8px 0", borderBottom: "1px solid var(--line-2)" }}
              >
                <span>Cluster</span>
                <span style={{ textAlign: "right" }}>Agents</span>
                <span>Working now</span>
                <span style={{ textAlign: "right" }}>Last act</span>
              </div>
            )}
            {clusters.map((c) => {
              const members = byCluster.get(c.$id) ?? [];
              const working = members.filter((a) => ACTIVE.includes(a.status)).length;
              const blk = members.filter((a) => a.status === "blocked").length;
              const last = members.reduce<string | null>((m, a) => (a.last_action_at && (!m || a.last_action_at > m) ? a.last_action_at : m), null);
              const on = selCluster === c.$id;
              return (
                <div
                  key={c.$id}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "minmax(0,1.6fr) 70px minmax(60px,1fr) 70px",
                    gap: 12,
                    alignItems: "center",
                    padding: "6px 0",
                    borderBottom: "1px solid var(--line)",
                    fontSize: 13,
                    background: on ? "var(--sunk)" : undefined,
                  }}
                >
                  <button
                    aria-pressed={on}
                    onClick={() => setSel(on ? null : c.$id)}
                    style={{ minWidth: 0, border: 0, background: "transparent", padding: "6px 0", textAlign: "left", cursor: "pointer", color: "inherit" }}
                  >
                    <span style={{ display: "block", fontWeight: 600 }}>{c.name}</span>
                    <span className="m-meta">
                      {c.theme} · {blk ? `${blk} blocked` : working ? "working" : "idle"}
                    </span>
                  </button>
                  <span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{members.length}</span>
                  <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span className="m-bar" style={{ flex: 1 }}>
                      <i style={{ width: members.length ? `${(working / members.length) * 100}%` : "0%" }} />
                    </span>
                    <span style={{ fontVariantNumeric: "tabular-nums", fontSize: 12 }}>{working}</span>
                  </span>
                  <span className="m-meta" style={{ textAlign: "right" }}>
                    {last ? ago(last) : "—"}
                  </span>
                </div>
              );
            })}
          </section>

          <section>
            <div className="m-shead" style={{ flexWrap: "wrap", gap: "4px 12px" }}>
              <h2 className="m-h2">{selCluster ? `${clusterName.get(selCluster)} activity` : "Recent activity"}</h2>
              {selCluster ? (
                <button className="m-link" onClick={() => setSel(null)}>
                  Show all clusters
                </button>
              ) : (
                <span className="m-meta">{liveEvents.length ? "live" : events0 == null ? "Loading…" : ""}</span>
              )}
            </div>
            {events0 != null && trace.length === 0 && (
              <p className="m-empty">{selCluster ? "No recent events from this cluster." : "No agent activity recorded on this desk yet."}</p>
            )}
            {trace.map((e) => {
              const a = agentById.get(e.agent_id);
              const cid = e.cluster_id ?? a?.cluster_id ?? null;
              const [label, color] = KIND[e.kind] ?? KIND.thought;
              return (
                <div
                  key={e.$id}
                  style={{ display: "grid", gridTemplateColumns: "86px minmax(0,1fr) auto", gap: 12, alignItems: "start", padding: "11px 0", borderTop: "1px solid var(--line)", fontSize: 13 }}
                >
                  <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color }}>
                    <span className="m-dot" style={{ width: 6, height: 6, background: color }} />
                    {label}
                  </span>
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: "block", textWrap: "pretty" }}>{plain(e.summary)}</span>
                    <span className="m-mono m-ink3" style={{ fontSize: 12 }}>
                      {a?.name ?? `agent/${e.agent_id.slice(-6)}`}
                      {cid && clusterName.get(cid) ? ` · ${clusterName.get(cid)}` : ""}
                    </span>
                  </span>
                  <span className="m-meta" style={{ whiteSpace: "nowrap" }}>
                    {ago(e.occurred_at)}
                  </span>
                </div>
              );
            })}
          </section>
        </div>

        <aside className="m-aside" style={{ minWidth: 0 }}>
          <section className="m-card" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <h2 className="m-h2" style={{ fontSize: 22, marginBottom: 6 }}>
              Fleet
            </h2>
            {kv("Agents", String(agents.length))}
            {kv("Working now", String(active.length), active.length ? "var(--up)" : undefined)}
            {kv("Blocked", String(blocked.length), blocked.length ? "var(--down)" : undefined)}
            {kv("Models in rotation", String(models.size))}
            {kv("Model calls today", spend?.hit ? `${partial ? "≥ " : ""}${llm.length.toLocaleString()}` : "—")}
            {kv("Tokens today", spend?.hit && tokens ? `${partial ? "≥ " : ""}${tokens.toLocaleString()}` : "—")}
            <p className="m-note" style={{ margin: "8px 0 0" }}>
              Spend and calls come from the budget ledger, which every model call writes; it covers both desks.
            </p>
          </section>
        </aside>
      </div>

      {full && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,280px),1fr))", gap: 40, marginTop: 48 }}>
          <section>
            <div className="m-shead">
              <h2 className="m-h2" style={{ fontSize: 22 }}>
                Model routing
              </h2>
              <span className="m-meta">agents · working</span>
            </div>
            {[...models.entries()]
              .sort((a, b) => b[1].n - a[1].n)
              .map(([m, s]) => (
                <div
                  key={m}
                  style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 60px 56px", gap: 12, alignItems: "center", padding: "9px 0", borderBottom: "1px solid var(--line)", fontSize: 13 }}
                >
                  <span className="m-mono" style={{ fontSize: 12, minWidth: 0 }}>
                    {modelLabel(m)}
                  </span>
                  <span className="m-bar">
                    <i style={{ width: `${(s.n / Math.max(1, agents.length)) * 100}%` }} />
                  </span>
                  <span className="m-ink2" style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                    {s.n} · {s.active}
                  </span>
                </div>
              ))}
          </section>
          <section>
            <div className="m-shead">
              <h2 className="m-h2" style={{ fontSize: 22 }}>
                Agents
              </h2>
              <span className="m-meta">by status</span>
            </div>
            {[...agents]
              .sort((a, b) => Number(ACTIVE.includes(b.status)) - Number(ACTIVE.includes(a.status)) || (b.last_action_at ?? "").localeCompare(a.last_action_at ?? ""))
              .map((a) => (
                <div key={a.$id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 0", borderBottom: "1px solid var(--line)", fontSize: 13 }}>
                  <span className={`m-dot${ACTIVE.includes(a.status) ? " m-pulse" : ""}`} style={{ width: 6, height: 6, background: STATE[a.status][1] }} />
                  <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.name}</span>
                  <span className="m-meta" style={{ marginLeft: "auto", whiteSpace: "nowrap" }}>
                    {a.role} · {STATE[a.status][0].toLowerCase()}
                    {a.last_action_at ? ` · ${ago(a.last_action_at)}` : ""}
                  </span>
                </div>
              ))}
          </section>
          <section>
            <div className="m-shead">
              <h2 className="m-h2" style={{ fontSize: 22 }}>
                Venues
              </h2>
              <span className="m-meta">recent orders</span>
            </div>
            {trades != null && venues.size === 0 && <p className="m-empty">No orders routed from this desk yet.</p>}
            {[...venues.entries()]
              .sort((a, b) => b[1] - a[1])
              .map(([v, n]) => (
                <div key={v} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 0", borderBottom: "1px solid var(--line)", fontSize: 13 }}>
                  <span>{v}</span>
                  <span className="m-mono m-ink3" style={{ marginLeft: "auto", fontSize: 12 }}>
                    {n} order{n === 1 ? "" : "s"}
                  </span>
                </div>
              ))}
          </section>
        </div>
      )}
    </>
  );
}
