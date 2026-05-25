"use client";

import { ReactNode, useEffect, useRef } from "react";
import { Panel } from "../primitives";

type Msg = { who: "user" | "ai"; name: string; body: ReactNode };

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

function ConsoleChat() {
  const feedRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight;
  }, []);
  return (
    <div className="chat">
      <div className="chat-feed" ref={feedRef}>
        {sessionLog.map((m, i) => (
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
          <input placeholder="Direct intelligence  —  e.g. show emerging vol-of-vol regime shifts across asset classes" />
          <button className="send">↵ send</button>
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
        <h5>Active Agents · Session</h5>
        <div className="mono" style={{ fontSize: 11, lineHeight: 1.9 }}>
          <div><span className="amber">●</span> earnings/4f-118 <span className="dim">· TSM forensics</span></div>
          <div><span className="amber">●</span> earnings/4f-9   <span className="dim">· supplier graph</span></div>
          <div><span className="amber">●</span> macro/m-44      <span className="dim">· cross-asset</span></div>
          <div><span className="amber">●</span> risk/r-04       <span className="dim">· dissenter</span></div>
          <div><span className="cyan">●</span> exec/x-19       <span className="dim">· pacing optimizer</span></div>
          <div><span className="cyan">●</span> alt/d-310       <span className="dim">· diesel divergence</span></div>
          <div className="dim" style={{ marginTop: 8 }}>+ 8 spawned (forensic burst)</div>
        </div>
      </div>
      <div className="gov">
        <h5>Session Budget</h5>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr auto",
            gap: "6px 10px",
            fontFamily: "var(--mono)",
            fontSize: 11,
          }}
        >
          <span className="dim">Inference spend</span><span style={{ color: "var(--ink-0)" }}>$1,284</span>
          <span className="dim">Cap</span><span className="amber">$5,000</span>
          <span className="dim">Open positions</span><span style={{ color: "var(--ink-0)" }}>1,418</span>
          <span className="dim">Pending orders</span><span className="amber">7</span>
        </div>
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
