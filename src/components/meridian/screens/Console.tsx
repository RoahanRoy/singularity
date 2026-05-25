"use client";

import { ReactNode, useEffect, useRef, useState } from "react";
import { Panel } from "../primitives";
import {
  listOperatorMessages,
  sendOperatorMessage,
  subscribeOperatorMessages,
  listGovernanceEvents,
  listBudgetLedger,
} from "@/lib/appwrite/queries";
import type { OperatorMessage, GovernanceEvent, BudgetLedger } from "@/lib/appwrite/schema";

type Msg = { who: "user" | "ai"; name: string; body: ReactNode };
const THREAD = "default";

const sessionLog: Msg[] = [
  {
    who: "user",
    name: "Operator · K. Park",
    body: <p>Show me all high-conviction positions derived from post-earnings supplier dislocations in the last 72 hours.</p>,
  },
  {
    who: "ai",
    name: "Meridian · synthesizer",
    body: (
      <div>
        <p>
          Surfacing <span className="h">7 positions</span> that meet the criteria. Three are derived from the TSM call
          (supplier-side); the remaining four trace to AVGO and the CHRG/EV cluster. Median conviction{" "}
          <span className="h">0.74</span>, median horizon <span className="h">11 days</span>.
        </p>
        <div className="action-card">
          <div className="head"><span className="lbl">positions</span> · post-earnings supplier dislocation</div>
          <div className="grid">
            <span className="k">Long</span><span className="v">SOXX · 0.62%</span>
            <span className="k">Long</span><span className="v">ASML · 0.30%</span>
            <span className="k">Short</span><span className="v">TSM 1M ATM call spread · 0.40%</span>
            <span className="k">Pair</span><span className="v">AVGO / MRVL · 0.18% / −0.18%</span>
            <span className="k">Long</span><span className="v">CHRG 2W puts · 0.12%</span>
            <span className="k">Hedge</span><span className="v">VIX 1M call spread · 0.20%</span>
            <span className="k">Long</span><span className="v">SMCI · 0.14%</span>
            <span className="k">Sharpe (port)</span><span className="v">1.82</span>
          </div>
        </div>
      </div>
    ),
  },
  {
    who: "user",
    name: "Operator · K. Park",
    body: <p>Reduce China-linked semiconductor exposure by 15%. Preserve idiosyncratic alpha. Run pre-trade through the new risk overlay.</p>,
  },
  {
    who: "ai",
    name: "Meridian · portfolio orchestrator",
    body: (
      <div>
        <p>
          Modeled three execution paths. Path B preserves <span className="h">87%</span> of idiosyncratic alpha while
          reducing China-linked semi exposure from <span className="h">9.4%</span> to <span className="h">8.0%</span>{" "}
          (−15.0%). Pre-trade risk overlay passes. <span className="amber">28 sub-agents</span> participated; 2
          dissented and requested human review.
        </p>
        <div className="quote">
          &ldquo;Dissent · risk/topology-04 — the proposed unwind is correlated with our SOXX long; consider pacing over
          2 sessions to avoid book-internal hedging cost.&rdquo;
        </div>
        <div className="action-card">
          <div className="head"><span className="lbl">proposed orders</span> · path B · staged 2-session</div>
          <div className="grid">
            <span className="k">Reduce</span><span className="v">TSM ADR · −0.62%</span>
            <span className="k">Reduce</span><span className="v">SMIC HK · −0.31%</span>
            <span className="k">Reduce</span><span className="v">SOXX (paced)</span>
            <span className="k">Preserve</span><span className="v">ASML, AVGO, NVDA</span>
            <span className="k">Slippage est.</span><span className="v">2.4bp</span>
            <span className="k">Alpha preserved</span><span className="v">87%</span>
            <span className="k">Risk Δ VaR</span><span className="v">−0.08%</span>
            <span className="k">Time to fill</span><span className="v">~46 min</span>
          </div>
          <div className="ctrls">
            <button className="btn primary">Authorize Execution</button>
            <button className="btn">Spawn Dissent Review</button>
            <button className="btn">Show Path A · C</button>
          </div>
        </div>
      </div>
    ),
  },
  {
    who: "user",
    name: "Operator · K. Park",
    body: <p>Spawn deeper forensic agents on the TSM filing anomaly. Limit at 8 agents, budget $480 in inference.</p>,
  },
  {
    who: "ai",
    name: "Meridian · agent orchestrator",
    body: (
      <div>
        <p>
          Spawned <span className="h">8 forensic agents</span> across language, tone, supplier graph, options skew,
          patent activity, and management history dimensions. Budget capped at <span className="h">$480</span>{" "}
          (<span className="dim">$61 expected median spend</span>). Findings will route into the TSM memo as numbered
          sub-reports. ETA <span className="h">~7 minutes</span>.
        </p>
      </div>
    ),
  },
];

function opMsgToMsg(m: OperatorMessage): Msg {
  return {
    who: m.role === "operator" ? "user" : "ai",
    name: m.role === "operator" ? "Operator · K. Park" : m.role === "assistant" ? "Meridian · live" : "system",
    body: <p>{m.content}</p>,
  };
}

function ConsoleChat() {
  const feedRef = useRef<HTMLDivElement>(null);
  const [live, setLive] = useState<OperatorMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    listOperatorMessages(THREAD, 50)
      .then((rows) => {
        if (!cancelled) setLive(rows);
      })
      .catch(() => {});
    const unsub = subscribeOperatorMessages(THREAD, (m) => {
      if (cancelled) return;
      setLive((prev) => (prev.some((x) => x.$id === m.$id) ? prev : [...prev, m]));
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  useEffect(() => {
    if (feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight;
  }, [live.length]);

  async function onSend() {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setDraft("");
    try {
      await sendOperatorMessage(text);
    } catch {
      setDraft(text);
    } finally {
      setSending(false);
    }
  }

  const allMsgs: Msg[] = [...sessionLog, ...live.map(opMsgToMsg)];

  return (
    <div className="chat">
      <div className="chat-feed" ref={feedRef}>
        {allMsgs.map((m, i) => (
          <div key={i} className={"msg " + m.who}>
            <div className="av">{m.who === "user" ? "KP" : "M"}</div>
            <div>
              <div className="who">{m.name}</div>
              <div className="body">{m.body}</div>
            </div>
          </div>
        ))}
      </div>

      <div className="composer">
        <div className="bar">
          <span style={{ color: "var(--ink-3)", fontFamily: "var(--mono)" }}>›</span>
          <input
            placeholder="Direct intelligence  —  e.g. show emerging vol-of-vol regime shifts across asset classes"
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
          <span className="h">+ spawn agent</span>
          <span className="h">+ governance constraint</span>
          <span className="h">+ replay scenario</span>
          <span className="h">+ attach filing</span>
          <span style={{ marginLeft: "auto", color: "var(--ink-4)" }}>
            voice <span className="kbd">⌘ V</span>
          </span>
        </div>
      </div>
    </div>
  );
}

const FALLBACK_GOV: GovernanceEvent[] = [
  { $id: "g-0", $createdAt: "", $updatedAt: "", kind: "approval", actor: "K. Park",   target: "trade:NVDA buy 4200", reason: "within auto-execute cap", occurred_at: new Date().toISOString() },
  { $id: "g-1", $createdAt: "", $updatedAt: "", kind: "block",    actor: "risk/r-04", target: "trade:TSM call spread", reason: "VaR breach projected",    occurred_at: new Date().toISOString() },
];

const GOV_KIND_COLOR: Record<GovernanceEvent["kind"], string> = {
  approval: "var(--green)",
  block: "var(--red)",
  override: "var(--amber)",
  policy_change: "var(--cyan)",
};

function GovernanceFeed() {
  const [events, setEvents] = useState<GovernanceEvent[]>(FALLBACK_GOV);
  useEffect(() => {
    let cancelled = false;
    listGovernanceEvents(10)
      .then((rows) => {
        if (!cancelled && rows.length > 0) setEvents(rows);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
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

function SessionBudget() {
  const [rows, setRows] = useState<BudgetLedger[]>([]);
  useEffect(() => {
    let cancelled = false;
    listBudgetLedger(100)
      .then((r) => {
        if (!cancelled) setRows(r);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  const inferenceSpend = rows.filter((r) => r.category === "llm").reduce((s, r) => s + r.amount_usd, 0);
  const totalSpend = rows.reduce((s, r) => s + r.amount_usd, 0);
  const fmt = (n: number) => "$" + n.toLocaleString(undefined, { maximumFractionDigits: 0 });
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
      <span className="dim">Inference spend</span><span style={{ color: "var(--ink-0)" }}>{rows.length ? fmt(inferenceSpend) : "$1,284"}</span>
      <span className="dim">Total spend</span><span style={{ color: "var(--ink-0)" }}>{rows.length ? fmt(totalSpend) : "$1,932"}</span>
      <span className="dim">Cap</span><span className="amber">$5,000</span>
      <span className="dim">Ledger entries</span><span style={{ color: "var(--ink-0)" }}>{rows.length || 7}</span>
    </div>
  );
}

function Governance() {
  const rules = [
    { on: true,  text: "Max single-name NAV ≤ 1.2%" },
    { on: true,  text: "China-linked semi ≤ 10.0%" },
    { on: true,  text: "Net leverage ≤ 2.8×" },
    { on: true,  text: "VaR(99,1d) ≤ 1.8% NAV" },
    { on: true,  text: "Auto-execute < $5M notional" },
    { on: false, text: "Voice-trade permission" },
    { on: true,  text: "Two-agent dissent → human review" },
    { on: false, text: "Overnight power: PM only" },
  ];
  return (
    <>
      <div className="gov">
        <h5>Governance Overlays</h5>
        {rules.map((r, i) => (
          <div key={i} className={"rule " + (r.on ? "on" : "")}>
            <span className="sw" />
            <span>{r.text}</span>
          </div>
        ))}
      </div>
      <div className="gov">
        <h5>Governance Events · Recent</h5>
        <GovernanceFeed />
      </div>
      <div className="gov">
        <h5>Session Budget</h5>
        <SessionBudget />
      </div>
    </>
  );
}

export function ConsoleScreen() {
  return (
    <div className="console-grid">
      <div className="panel" style={{ borderTop: 0, borderBottom: 0, borderLeft: 0 }}>
        <div className="panel-head">
          <span className="title">Operator Console · session #2,841</span>
          <span className="meta">K. Park (PM) · supervised · last action 12s ago</span>
        </div>
        <div className="panel-body tight" style={{ overflow: "hidden", display: "flex", minHeight: 0 }}>
          <ConsoleChat />
        </div>
      </div>

      <Panel title="Governance & Telemetry" bodyClassName="tight">
        <Governance />
      </Panel>
    </div>
  );
}
