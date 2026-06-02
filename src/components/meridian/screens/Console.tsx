"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Panel } from "../primitives";
import { useOperator } from "../AuthGate";
import { useMarket } from "../MarketContext";
import { fmtMoney } from "@/lib/meridian/format";
import {
  listOperatorMessages,
  sendOperatorMessage,
  subscribeOperatorMessages,
  listGovernanceEvents,
  listBudgetLedger,
  listPositions,
  listAgentStatus,
  subscribeAgentStatus,
  enqueueAgentCommand,
} from "@/lib/appwrite/queries";
import type {
  OperatorMessage,
  GovernanceEvent,
  BudgetLedger,
  Position,
  AgentStatusDoc,
} from "@/lib/appwrite/schema";

const THREAD_US = "default";
const THREAD_IN = "default-IN";
function threadFor(market: "US" | "IN"): string {
  return market === "IN" ? THREAD_IN : THREAD_US;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "??";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function relTime(iso: string | null | undefined, now: number): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function ConsoleChat({
  operatorName,
  operatorInitials,
  onActivity,
  thread,
}: {
  operatorName: string;
  operatorInitials: string;
  onActivity: (iso: string) => void;
  thread: string;
}) {
  const feedRef = useRef<HTMLDivElement>(null);
  const [msgs, setMsgs] = useState<OperatorMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const cancelled = { v: false };
    setMsgs([]);
    setLoaded(false);
    listOperatorMessages(thread, 200)
      .then((rows) => {
        if (cancelled.v) return;
        setMsgs(rows);
        setLoaded(true);
        const last = rows[rows.length - 1];
        if (last) onActivity(last.$createdAt);
      })
      .catch(() => {
        if (!cancelled.v) setLoaded(true);
      });
    const unsub = subscribeOperatorMessages(thread, (m) => {
      if (cancelled.v) return;
      setMsgs((prev) => (prev.some((x) => x.$id === m.$id) ? prev : [...prev, m]));
      onActivity(m.$createdAt);
    });
    return () => {
      cancelled.v = true;
      unsub();
    };
  }, [onActivity, thread]);

  useEffect(() => {
    if (feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight;
  }, [msgs.length]);

  async function onSend() {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setDraft("");
    try {
      await sendOperatorMessage(text, "operator", thread);
    } catch {
      setDraft(text);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="chat">
      <div className="chat-feed" ref={feedRef}>
        {loaded && msgs.length === 0 && (
          <div className="dim" style={{ fontFamily: "var(--mono)", fontSize: 12, textAlign: "center", padding: "40px 0" }}>
            No messages in this thread yet. Send a directive below to begin.
          </div>
        )}
        {msgs.map((m) => {
          const isOp = m.role === "operator";
          const name = isOp
            ? `Operator · ${operatorName}`
            : m.role === "assistant"
            ? "Meridian · assistant"
            : "system";
          return (
            <div key={m.$id} className={"msg " + (isOp ? "user" : "ai")}>
              <div className="av">{isOp ? operatorInitials : "M"}</div>
              <div>
                <div className="who">{name}</div>
                <div className="body">
                  <p style={{ whiteSpace: "pre-wrap" }}>{m.content}</p>
                </div>
              </div>
            </div>
          );
        })}
        {msgs.length > 0 && msgs[msgs.length - 1].role === "operator" && (
          <div className="msg ai">
            <div className="av">M</div>
            <div>
              <div className="who">Meridian · assistant</div>
              <div className="body">
                <p className="dim" style={{ fontFamily: "var(--mono)", fontSize: 12 }}>
                  thinking<span className="dim">…</span>
                </p>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="composer">
        <div className="bar">
          <span style={{ color: "var(--ink-3)", fontFamily: "var(--mono)" }}>›</span>
          <input
            placeholder="Direct intelligence — e.g. show emerging vol-of-vol regime shifts across asset classes"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                onSend();
              }
            }}
            disabled={sending}
          />
          <button className="send" onClick={onSend} disabled={sending || !draft.trim()}>
            ↵ send
          </button>
        </div>
        <div className="hints">
          <span className="h">thread · {thread}</span>
          <span style={{ marginLeft: "auto", color: "var(--ink-4)" }}>
            {msgs.length} message{msgs.length === 1 ? "" : "s"}
          </span>
        </div>
      </div>
    </div>
  );
}

const GOV_KIND_COLOR: Record<GovernanceEvent["kind"], string> = {
  approval: "var(--green)",
  block: "var(--red)",
  override: "var(--amber)",
  policy_change: "var(--cyan)",
};

function GovernanceFeed() {
  const [events, setEvents] = useState<GovernanceEvent[] | null>(null);
  useEffect(() => {
    const cancelled = { v: false };
    listGovernanceEvents(12)
      .then((rows) => {
        if (!cancelled.v) setEvents(rows);
      })
      .catch(() => {
        if (!cancelled.v) setEvents([]);
      });
    return () => { cancelled.v = true; };
  }, []);

  if (events === null) {
    return <div className="dim" style={{ fontFamily: "var(--mono)", fontSize: 11 }}>loading…</div>;
  }
  if (events.length === 0) {
    return <div className="dim" style={{ fontFamily: "var(--mono)", fontSize: 11 }}>No governance events recorded.</div>;
  }
  return (
    <div className="mono" style={{ fontSize: 11, lineHeight: 1.7 }}>
      {events.map((e) => (
        <div key={e.$id} style={{ marginBottom: 4 }}>
          <span style={{ color: GOV_KIND_COLOR[e.kind] ?? "var(--ink-2)" }}>●</span>{" "}
          <span style={{ color: "var(--ink-1)" }}>{e.actor}</span>{" "}
          <span className="dim">→ {e.target}</span>
          <div className="dim" style={{ paddingLeft: 14, fontSize: 10 }}>{e.reason}</div>
        </div>
      ))}
    </div>
  );
}

function PortfolioPosture() {
  const { market } = useMarket();
  const [positions, setPositions] = useState<Position[] | null>(null);
  useEffect(() => {
    const cancelled = { v: false };
    setPositions(null);
    listPositions(100, market)
      .then((r) => {
        if (!cancelled.v) setPositions(r);
      })
      .catch(() => {
        if (!cancelled.v) setPositions([]);
      });
    return () => { cancelled.v = true; };
  }, [market]);

  if (positions === null) {
    return <div className="dim" style={{ fontFamily: "var(--mono)", fontSize: 11 }}>loading…</div>;
  }
  if (positions.length === 0) {
    return <div className="dim" style={{ fontFamily: "var(--mono)", fontSize: 11 }}>No positions on the book.</div>;
  }

  const totalMV = positions.reduce((s, p) => s + (p.market_value || 0), 0);
  const totalPnL = positions.reduce((s, p) => s + (p.unrealized_pnl || 0), 0);
  const weights = positions.map((p) => Math.abs(p.weight || 0));
  const maxWeight = Math.max(...weights, 0);
  const maxIdx = weights.indexOf(maxWeight);
  const top = positions[maxIdx];

  const fmtUsd = (n: number) => fmtMoney(n, market);
  const fmtPct = (n: number) => `${(n * 100).toFixed(2)}%`;

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr auto",
        gap: "6px 10px",
        fontFamily: "var(--mono)",
        fontSize: 11,
      }}
    >
      <span className="dim">Positions</span>
      <span style={{ color: "var(--ink-0)" }}>{positions.length}</span>
      <span className="dim">Total market value</span>
      <span style={{ color: "var(--ink-0)" }}>{fmtUsd(totalMV)}</span>
      <span className="dim">Unrealized P&L</span>
      <span style={{ color: totalPnL >= 0 ? "var(--green)" : "var(--red)" }}>{fmtUsd(totalPnL)}</span>
      <span className="dim">Largest weight</span>
      <span style={{ color: "var(--ink-0)" }}>
        {top?.ticker ?? "—"} · {fmtPct(maxWeight)}
      </span>
    </div>
  );
}

function SessionBudget() {
  const [rows, setRows] = useState<BudgetLedger[] | null>(null);
  useEffect(() => {
    const cancelled = { v: false };
    listBudgetLedger(200)
      .then((r) => {
        if (!cancelled.v) setRows(r);
      })
      .catch(() => {
        if (!cancelled.v) setRows([]);
      });
    return () => { cancelled.v = true; };
  }, []);

  if (rows === null) {
    return <div className="dim" style={{ fontFamily: "var(--mono)", fontSize: 11 }}>loading…</div>;
  }
  if (rows.length === 0) {
    return <div className="dim" style={{ fontFamily: "var(--mono)", fontSize: 11 }}>No spend recorded.</div>;
  }

  const byCategory = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.category] = (acc[r.category] || 0) + r.amount_usd;
    return acc;
  }, {});
  const total = rows.reduce((s, r) => s + r.amount_usd, 0);
  const fmt = (n: number) => "$" + n.toLocaleString(undefined, { maximumFractionDigits: 0 });
  const order: Array<BudgetLedger["category"]> = ["llm", "data", "compute", "venue_fees"];
  const label: Record<BudgetLedger["category"], string> = {
    llm: "Inference",
    data: "Data",
    compute: "Compute",
    venue_fees: "Venue fees",
  };

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr auto",
        gap: "6px 10px",
        fontFamily: "var(--mono)",
        fontSize: 11,
      }}
    >
      {order
        .filter((k) => byCategory[k])
        .map((k) => (
          <span key={k} style={{ display: "contents" }}>
            <span className="dim">{label[k]}</span>
            <span style={{ color: "var(--ink-0)" }}>{fmt(byCategory[k])}</span>
          </span>
        ))}
      <span className="dim">Total spend</span>
      <span style={{ color: "var(--ink-0)" }}>{fmt(total)}</span>
      <span className="dim">Ledger entries</span>
      <span style={{ color: "var(--ink-0)" }}>{rows.length}</span>
    </div>
  );
}

function PolicyChanges() {
  const [events, setEvents] = useState<GovernanceEvent[] | null>(null);
  const [renderedAt, setRenderedAt] = useState(0);
  useEffect(() => {
    const cancelled = { v: false };
    listGovernanceEvents(50)
      .then((rows) => {
        if (cancelled.v) return;
        setEvents(rows.filter((e) => e.kind === "policy_change").slice(0, 8));
        setRenderedAt(Date.now());
      })
      .catch(() => {
        if (!cancelled.v) setEvents([]);
      });
    return () => { cancelled.v = true; };
  }, []);

  if (events === null) {
    return <div className="dim" style={{ fontFamily: "var(--mono)", fontSize: 11 }}>loading…</div>;
  }
  if (events.length === 0) {
    return <div className="dim" style={{ fontFamily: "var(--mono)", fontSize: 11 }}>No active policies recorded.</div>;
  }
  const now = renderedAt;
  return (
    <>
      {events.map((e) => {
        const recent = now - Date.parse(e.occurred_at) < 7 * 24 * 3600 * 1000;
        return (
          <div key={e.$id} className={"rule " + (recent ? "on" : "")}>
            <span className="sw" />
            <span>{e.target} — <span className="dim">{e.reason}</span></span>
          </div>
        );
      })}
    </>
  );
}

type WorkerName = "responder" | "tech" | "india";

const AGENT_LABEL: Record<WorkerName, string> = {
  responder: "Operator responder",
  tech: "Tech research loop",
  india: "India research loop",
};
const AGENT_ORDER: WorkerName[] = ["responder", "tech", "india"];

// The dispatcher republishes status every ~2s; if the freshest row is older
// than this, treat it as offline (nobody is home to run the agents).
const DISPATCHER_STALE_MS = 15_000;

/**
 * Drives the laptop dispatcher through Appwrite. Clicking a button enqueues a
 * command row (works even when this UI is served from Vercel); the dispatcher
 * — running where `claude login` lives — consumes it and publishes status back,
 * which arrives here over realtime.
 */
function AgentControls() {
  const [statuses, setStatuses] = useState<Record<string, AgentStatusDoc> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 3000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const cancelled = { v: false };
    listAgentStatus()
      .then((rows) => {
        if (cancelled.v) return;
        const map: Record<string, AgentStatusDoc> = {};
        for (const r of rows) map[r.name] = r;
        setStatuses(map);
      })
      .catch(() => {
        if (!cancelled.v) setStatuses({});
      });
    const unsub = subscribeAgentStatus((row) => {
      if (cancelled.v) return;
      setStatuses((prev) => ({ ...(prev ?? {}), [row.name]: row }));
    });
    return () => {
      cancelled.v = true;
      unsub();
    };
  }, []);

  async function send(name: WorkerName, action: "start" | "stop" | "restart") {
    setBusy(`${name}:${action}`);
    try {
      await enqueueAgentCommand(name, action);
    } catch {
      // Failure surfaces as the status simply not changing.
    } finally {
      // Give the dispatcher a beat to pick the command up before re-enabling.
      setTimeout(() => setBusy(null), 800);
    }
  }

  if (statuses === null) {
    return <div className="dim" style={{ fontFamily: "var(--mono)", fontSize: 11 }}>loading…</div>;
  }

  const freshest = Object.values(statuses).reduce(
    (max, s) => Math.max(max, Date.parse(s.updated_at || "") || 0),
    0,
  );
  const dispatcherOnline = freshest > 0 && now - freshest < DISPATCHER_STALE_MS;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div
        className="dim"
        style={{ fontFamily: "var(--mono)", fontSize: 10, display: "flex", alignItems: "center", gap: 6 }}
      >
        <span style={{ color: dispatcherOnline ? "var(--green)" : "var(--red)", fontSize: 12, lineHeight: 1 }}>●</span>
        {dispatcherOnline ? "dispatcher online" : "dispatcher offline — run npm run agents:dispatch on your host"}
      </div>
      {AGENT_ORDER.map((name) => {
        const s = statuses[name];
        const running = s?.running ?? false;
        const dotColor = running ? "var(--green)" : s?.exit_code != null ? "var(--red)" : "var(--ink-3)";
        const statusText = running
          ? `running · pid ${s?.pid ?? "—"}`
          : s?.exit_code != null
          ? `stopped · exit ${s.exit_code}`
          : "idle";
        const disabled = busy !== null || !dispatcherOnline;
        return (
          <div
            key={name}
            style={{
              display: "grid",
              gridTemplateColumns: "auto 1fr auto",
              alignItems: "center",
              gap: 8,
              fontFamily: "var(--mono)",
              fontSize: 11,
            }}
          >
            <span style={{ color: dotColor, fontSize: 14, lineHeight: 1 }}>●</span>
            <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
              <span style={{ color: "var(--ink-0)" }}>{AGENT_LABEL[name]}</span>
              <span className="dim" style={{ fontSize: 10 }}>{statusText}</span>
            </div>
            <div style={{ display: "flex", gap: 4 }}>
              {running ? (
                <>
                  <button
                    className="send"
                    style={{ fontSize: 10, padding: "2px 8px" }}
                    disabled={disabled}
                    onClick={() => send(name, "restart")}
                  >
                    ↻
                  </button>
                  <button
                    className="send"
                    style={{ fontSize: 10, padding: "2px 8px" }}
                    disabled={disabled}
                    onClick={() => send(name, "stop")}
                  >
                    stop
                  </button>
                </>
              ) : (
                <button
                  className="send"
                  style={{ fontSize: 10, padding: "2px 8px" }}
                  disabled={disabled}
                  onClick={() => send(name, "start")}
                >
                  start
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Governance() {
  return (
    <>
      <div className="gov">
        <h5>Agents</h5>
        <AgentControls />
      </div>
      <div className="gov">
        <h5>Portfolio Posture</h5>
        <PortfolioPosture />
      </div>
      <div className="gov">
        <h5>Governance Events · Recent</h5>
        <GovernanceFeed />
      </div>
      <div className="gov">
        <h5>Active Policies</h5>
        <PolicyChanges />
      </div>
      <div className="gov">
        <h5>Session Budget</h5>
        <SessionBudget />
      </div>
    </>
  );
}

export function ConsoleScreen() {
  const operator = useOperator();
  const { market } = useMarket();
  const thread = threadFor(market);
  const operatorName = operator?.name || operator?.email || "anonymous";
  const operatorInitials = useMemo(() => initials(operatorName), [operatorName]);

  const [lastActivity, setLastActivity] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);

  const lastLabel = lastActivity ? `last action ${relTime(lastActivity, now)}` : "no activity yet";

  return (
    <div className="console-grid">
      <div className="panel" style={{ borderTop: 0, borderBottom: 0, borderLeft: 0 }}>
        <div className="panel-head">
          <span className="title">Operator Console · thread {thread}</span>
          <span className="meta">{operatorName} · supervised · {lastLabel}</span>
        </div>
        <div className="panel-body tight" style={{ overflow: "hidden", display: "flex", minHeight: 0 }}>
          <ConsoleChat
            key={thread}
            operatorName={operatorName}
            operatorInitials={operatorInitials}
            onActivity={setLastActivity}
            thread={thread}
          />
        </div>
      </div>

      <Panel title="Governance & Telemetry" bodyClassName="tight">
        <Governance />
      </Panel>
    </div>
  );
}
