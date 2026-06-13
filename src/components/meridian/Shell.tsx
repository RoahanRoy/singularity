"use client";

import { ReactNode, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { MarketTicker, ExchangeClock, exchangeStatus, type ExchangeStatus } from "./primitives";
import { useOperator } from "./AuthGate";
import { useMarket } from "./MarketContext";
import { signOutOperator } from "@/lib/auth/operator";
import { listPositions, listIbkrAccounts, listFundSnapshots } from "@/lib/appwrite/queries";
import { fmtFullMoney } from "@/lib/meridian/format";

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

type UsBook = {
  nav: number;
  cash: number;
  leverage: number;
  cashPct: number;
  var99: number | null;
  count: number;
  connected: boolean;
};

/**
 * Live US-desk rail stats, derived from the real IBKR book — NAV/cash from the
 * connected account, leverage & cash% from the live positions, and a 99%/1d
 * historical VaR from the fund's NAV return series (— until there's history).
 */
function useUsBook(market: string): UsBook | null {
  const [book, setBook] = useState<UsBook | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (market !== "US") {
      // Clear off the render path to avoid a synchronous cascading update.
      Promise.resolve().then(() => {
        if (!cancelled) setBook(null);
      });
      return () => {
        cancelled = true;
      };
    }
    Promise.all([listPositions(50, "US"), listIbkrAccounts(10), listFundSnapshots(200, "US")])
      .then(([pos, accts, snaps]) => {
        if (cancelled) return;
        const cash = accts.reduce((s, a) => s + (a.equity_cash || 0), 0);
        const grossMV = pos.reduce((s, p) => s + Math.abs(p.market_value || 0), 0);
        const netMV = pos.reduce((s, p) => s + (p.market_value || 0), 0);
        const nav = netMV + cash;
        const navs = snaps.map((s) => s.nav_usd);
        const rets: number[] = [];
        for (let i = 1; i < navs.length; i++) if (navs[i - 1]) rets.push(navs[i] / navs[i - 1] - 1);
        let var99: number | null = null;
        if (rets.length >= 2) {
          const sorted = [...rets].sort((a, b) => a - b);
          var99 = Math.abs(sorted[Math.floor(0.01 * sorted.length)] ?? sorted[0]);
        }
        setBook({
          nav,
          cash,
          leverage: nav ? grossMV / nav : 0,
          cashPct: nav ? cash / nav : 0,
          var99,
          count: pos.length,
          connected: accts.some((a) => a.ibkr_account_id),
        });
      })
      .catch(() => {
        if (!cancelled) setBook(null);
      });
    return () => {
      cancelled = true;
    };
  }, [market]);
  return book;
}

function Rail({ active, setActive }: { active: ScreenId; setActive: (id: ScreenId) => void }) {
  const { market } = useMarket();
  const usBook = useUsBook(market);
  return (
    <aside className="rail">
      <div className="rail-brand">
        <div className="mark" />
        <div>
          <div className="name">MERIDIAN</div>
          <div className="sub">{market === "IN" ? "INDIA DESK · NSE / BSE" : "AUTONOMOUS CAPITAL INTELLIGENCE"}</div>
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
        {market === "IN" ? (
          <>
            <div><span className="amber">●</span> India Fund · KITE</div>
            <div><span className="amber">●</span> NSE Equities · live</div>
            <div style={{ color: "var(--ink-4)" }}>connect a Kite account →</div>
          </>
        ) : usBook?.connected ? (
          <>
            <div><span className="amber">●</span> IBKR Fund · {fmtFullMoney(usBook.nav, "US")}</div>
            <div><span className="amber">●</span> US Equities · {usBook.count} live</div>
            <div style={{ color: "var(--ink-4)" }}>cash {fmtFullMoney(usBook.cash, "US")}</div>
          </>
        ) : (
          <>
            <div><span className="amber">●</span> US Fund · IBKR</div>
            <div style={{ color: "var(--ink-4)" }}>connect an IBKR account →</div>
          </>
        )}
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
        {market === "US" && !usBook?.connected ? (
          <div style={{ color: "var(--ink-4)" }}>— no live book —</div>
        ) : (
          <>
            <div>
              Net leverage{" "}
              <span style={{ color: "var(--ink-0)" }}>
                {usBook ? usBook.leverage.toFixed(2) + "×" : "—"}
              </span>
            </div>
            <div>
              VaR (99,1d){" "}
              <span style={{ color: "var(--ink-0)" }}>
                {usBook?.var99 != null ? (usBook.var99 * 100).toFixed(2) + "%" : "—"}
              </span>
            </div>
            <div>
              Cash{" "}
              <span style={{ color: "var(--ink-0)" }}>
                {usBook ? (usBook.cashPct * 100).toFixed(1) + "%" : "—"}
              </span>
            </div>
          </>
        )}
      </div>

      <RailFoot />
    </aside>
  );
}

function RailFoot() {
  const op = useOperator();
  const router = useRouter();
  const initials = (op?.name || op?.email || "OP")
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase() || "")
    .join("") || "OP";

  async function handleSignOut() {
    await signOutOperator();
    router.replace("/sign-in");
  }

  return (
    <div className="rail-foot">
      <div className="avatar">{initials}</div>
      <div className="who">
        <div className="name">{op?.name || op?.email || "Operator"}</div>
        <div className="role" style={{ display: "flex", gap: 10 }}>
          <Link href="/guided" style={{ color: "var(--ink-3)", textDecoration: "none" }}>
            ↗ Guided tour
          </Link>
          <button
            onClick={handleSignOut}
            style={{
              background: "transparent",
              border: 0,
              padding: 0,
              color: "var(--ink-3)",
              cursor: "pointer",
              font: "inherit",
            }}
          >
            ↩ Sign out
          </button>
        </div>
      </div>
    </div>
  );
}

function MarketToggle() {
  const { market, setMarket } = useMarket();
  const base: React.CSSProperties = {
    background: "transparent",
    border: 0,
    padding: "3px 9px",
    font: "inherit",
    fontFamily: "var(--mono)",
    fontSize: 11,
    letterSpacing: "0.08em",
    cursor: "pointer",
    color: "var(--ink-3)",
    borderRadius: 4,
  };
  const on: React.CSSProperties = { ...base, color: "var(--ink-0)", background: "var(--line-soft)" };
  return (
    <div
      role="group"
      aria-label="Market"
      style={{
        display: "inline-flex",
        border: "1px solid var(--line-strong)",
        borderRadius: 6,
        padding: 1,
        gap: 1,
      }}
    >
      <button style={market === "US" ? on : base} onClick={() => setMarket("US")} aria-pressed={market === "US"}>
        🇺🇸 US
      </button>
      <button style={market === "IN" ? on : base} onClick={() => setMarket("IN")} aria-pressed={market === "IN"}>
        🇮🇳 IN
      </button>
    </div>
  );
}

const STATUS_LABEL: Record<ExchangeStatus, string> = {
  open: "MARKETS OPEN",
  pre: "PRE-OPEN",
  after: "AFTER HOURS",
  closed: "MARKETS CLOSED",
};

function MarketsPill({ market }: { market: "US" | "IN" }) {
  // Recompute on the client every 30s so the pill flips as sessions open/close.
  // SSR renders nothing; the effect hydrates the real status.
  const [status, setStatus] = useState<ExchangeStatus | null>(null);
  useEffect(() => {
    const tick = () => setStatus(exchangeStatus(market));
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, [market]);
  const exch = market === "IN" ? "NSE" : "NYSE";
  if (!status) {
    return (
      <span className="pill" suppressHydrationWarning>
        <span className="pulse" />· {exch}
      </span>
    );
  }
  const cls = status === "open" ? "pill" : `pill ${status}`;
  return (
    <span className={cls} suppressHydrationWarning>
      <span className="pulse" />
      {STATUS_LABEL[status]} · {exch}
    </span>
  );
}

function TopBar({ active }: { active: ScreenId }) {
  const [a, b] = CRUMBS[active];
  const { market } = useMarket();
  return (
    <header className="topbar">
      <div className="crumbs">
        <span>{a}</span>
        <span className="sep">/</span>
        <span className="cur">{b}</span>
      </div>
      <MarketTicker />
      <div className="topbar-right">
        <MarketToggle />
        <MarketsPill market={market} />
        <span className="mono">
          <ExchangeClock market={market} />
        </span>
      </div>
    </header>
  );
}

function StatusBar() {
  const op = useOperator();
  const operatorName = op?.name || op?.email || "—";
  return (
    <footer className="status">
      <div className="cell"><span className="k">Session</span><span className="v mono">#2,841</span></div>
      <div className="cell"><span className="k">Operator</span><span className="v">{operatorName}</span></div>
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
