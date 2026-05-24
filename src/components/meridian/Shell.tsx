"use client";

import { ReactNode, useState } from "react";
import { MarketTicker, UTCClock } from "./primitives";

export type ScreenId = "swarm" | "research" | "portfolio" | "console" | "compute";

const SCREENS: { id: ScreenId; num: string; label: string }[] = [
  { id: "swarm",     num: "01", label: "Swarm Command" },
  { id: "research",  num: "02", label: "Research Engine" },
  { id: "portfolio", num: "03", label: "Portfolio OS" },
  { id: "console",   num: "04", label: "Operator Console" },
  { id: "compute",   num: "05", label: "Compute Layer" },
];

const CRUMBS: Record<ScreenId, [string, string]> = {
  swarm:     ["Intelligence", "Swarm Command"],
  research:  ["Intelligence", "Research Engine"],
  portfolio: ["Capital", "Portfolio OS"],
  console:   ["Operator", "Console"],
  compute:   ["System", "Compute Layer"],
};

function Rail({ active, setActive }: { active: ScreenId; setActive: (id: ScreenId) => void }) {
  return (
    <aside className="rail">
      <div className="rail-brand">
        <div className="mark" />
        <div>
          <div className="name">MERIDIAN</div>
          <div className="sub">AUTONOMOUS CAPITAL INTELLIGENCE</div>
        </div>
      </div>

      <div className="rail-section">Workspaces</div>
      <nav className="rail-nav">
        {SCREENS.map((s) => (
          <button
            key={s.id}
            className={active === s.id ? "active" : ""}
            onClick={() => setActive(s.id)}
          >
            <span className="dot" />
            <span>{s.label}</span>
            <span className="num">{s.num}</span>
          </button>
        ))}
      </nav>

      <div className="rail-section">Books</div>
      <div
        style={{
          padding: "4px 16px 0",
          fontFamily: "var(--mono)",
          fontSize: 11,
          color: "var(--ink-2)",
          letterSpacing: "0.04em",
          lineHeight: 1.95,
        }}
      >
        <div><span className="amber">●</span> Flagship · $1.28B</div>
        <div><span className="amber">●</span> Macro Overlay · $0.41B</div>
        <div><span className="amber">●</span> Vol Arbitrage · $0.18B</div>
        <div style={{ color: "var(--ink-4)" }}>+ 2 paused</div>
      </div>

      <div className="rail-section">Posture</div>
      <div
        style={{
          padding: "4px 16px 14px",
          fontFamily: "var(--mono)",
          fontSize: 11,
          color: "var(--ink-2)",
          lineHeight: 1.95,
        }}
      >
        <div>Net leverage <span style={{ color: "var(--ink-0)" }}>2.14×</span></div>
        <div>VaR (99,1d) <span style={{ color: "var(--ink-0)" }}>1.12%</span></div>
        <div>Cash <span style={{ color: "var(--ink-0)" }}>4.8%</span></div>
      </div>

      <div className="rail-foot">
        <div className="avatar">KP</div>
        <div className="who">
          <div className="name">K. Park</div>
          <div className="role">Portfolio Manager</div>
        </div>
      </div>
    </aside>
  );
}

function TopBar({ active }: { active: ScreenId }) {
  const [a, b] = CRUMBS[active];
  return (
    <header className="topbar">
      <div className="crumbs">
        <span>{a}</span>
        <span className="sep">/</span>
        <span className="cur">{b}</span>
      </div>
      <MarketTicker />
      <div className="topbar-right">
        <span className="pill">
          <span className="pulse" />
          MARKETS OPEN · NYSE
        </span>
        <span className="mono">
          <UTCClock />
        </span>
      </div>
    </header>
  );
}

function StatusBar() {
  return (
    <footer className="status">
      <div className="cell"><span className="k">Session</span><span className="v mono">#2,841</span></div>
      <div className="cell"><span className="k">Operator</span><span className="v">K. Park</span></div>
      <div className="cell"><span className="k">Net</span><span className="v mono">+$10.45M</span><span className="ok">▲ 0.82%</span></div>
      <div className="cell"><span className="k">Agents</span><span className="v mono">4,552 / 6,128</span></div>
      <div className="cell"><span className="k">Inference</span><span className="v mono">48,221 /s</span></div>
      <div className="cell"><span className="k">Risk</span><span className="ok">●</span><span className="v">within bounds</span></div>
      <div className="cell"><span className="k">Build</span><span className="v mono">v4.7.21 · stable</span></div>
    </footer>
  );
}

export function Shell({
  active,
  setActive,
  children,
}: {
  active: ScreenId;
  setActive: (id: ScreenId) => void;
  children: ReactNode;
}) {
  return (
    <div className="meridian-root">
      <div className="app">
        <Rail active={active} setActive={setActive} />
        <TopBar active={active} />
        <main className="main">{children}</main>
        <StatusBar />
      </div>
    </div>
  );
}

export { SCREENS };

export function useScreenState(initial: ScreenId = "swarm") {
  return useState<ScreenId>(initial);
}
