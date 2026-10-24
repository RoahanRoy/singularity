"use client";

import { ReactNode, createContext, useCallback, useContext, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { exchangeStatus, type ExchangeStatus } from "./primitives";
import { useOperator } from "./AuthGate";
import { useMarket } from "./MarketContext";
import { signOutOperator } from "@/lib/auth/operator";
import { listHeldMemos, subscribeMemos } from "@/lib/appwrite/queries";
import type { Memo } from "@/lib/appwrite/schema";
import type { Market } from "@/lib/meridian/format";
import { useTheme } from "@/lib/meridian/theme";

export type ScreenId = "today" | "book" | "risk" | "research" | "agents" | "console" | "log";
export type ResearchView = "filings" | "quant";

// group, then [id, label, Material Symbols glyph]
const NAV: [string, [ScreenId, string, string][]][] = [
  ["Monitor", [["today", "Today", "today"], ["book", "Book", "account_balance"], ["risk", "Risk", "shield"]]],
  ["Decide", [["research", "Research", "description"]]],
  ["Operate", [["agents", "Agents", "hub"], ["console", "Console", "forum"]]],
  ["Record", [["log", "Audit log", "history"]]],
];
// Old screen ids (and links that still use them) land on their new home.
const ALIAS: Record<string, ScreenId> = { portfolio: "book", swarm: "agents", compute: "agents", quant: "research" };
const TABS: [ScreenId, string, string][] = [
  ["today", "Today", "today"],
  ["book", "Book", "account_balance"],
  ["research", "Research", "description"],
  ["agents", "Agents", "hub"],
];
const MORE: [ScreenId, string, string][] = [
  ["risk", "Risk", "shield"],
  ["console", "Console", "forum"],
  ["log", "Audit log", "history"],
];

const SCREEN_KEY = "meridian-desk-screen-v3";
const DETAIL_KEY = "meridian-desk-detail";

export function resolveScreen(raw: string | null | undefined): ScreenId | null {
  if (!raw) return null;
  const id = ALIAS[raw] ?? raw;
  return NAV.some(([, items]) => items.some(([s]) => s === id)) ? (id as ScreenId) : null;
}

type DeskState = {
  screen: ScreenId;
  /** Navigate; accepts old ids too (`quant` opens Research on the Quant tab). */
  go: (raw: string) => void;
  full: boolean;
  showFull: () => void;
  researchView: ResearchView;
  setResearchView: (v: ResearchView) => void;
  /** A memo to open on Research (set from a Today decision's thesis link). */
  focusMemo: Memo | null;
  setFocusMemo: (m: Memo | null) => void;
  /** Memos holding an order: awaiting a decision (`review`) or approved and not yet executed. */
  held: Memo[] | null;
  reloadHeld: () => void;
};

const DeskCtx = createContext<DeskState | null>(null);

export function useDesk(): DeskState {
  const v = useContext(DeskCtx);
  if (!v) throw new Error("useDesk outside the desk shell");
  return v;
}

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, v: string) {
  try {
    window.localStorage.setItem(key, v);
  } catch {
    /* storage blocked: the choice just doesn't persist */
  }
}

export function Icon({ name, size, fill }: { name: string; size?: number; fill?: boolean }) {
  return (
    <span
      className="m-icon"
      aria-hidden
      style={{ fontSize: size, fontVariationSettings: fill ? "'FILL' 1, 'wght' 300" : undefined }}
    >
      {name}
    </span>
  );
}

function MarketSeg() {
  const { market, setMarket } = useMarket();
  return (
    <div className="m-seg" role="group" aria-label="Desk">
      {(["US", "IN"] as const).map((m) => (
        <button key={m} aria-pressed={market === m} onClick={() => setMarket(m)}>
          {m === "US" ? "US" : "India"}
        </button>
      ))}
    </div>
  );
}

const STATUS: Record<ExchangeStatus, [string, string]> = {
  open: ["Market open", "var(--up)"],
  pre: ["Pre-open", "var(--warn)"],
  after: ["After hours", "var(--warn)"],
  closed: ["Market closed", "var(--ink-3)"],
};

/** Local exchange time: ET for NYSE, IST for NSE (NYSE taken as EDT, like exchangeStatus). */
function exchangeClock(market: Market, now: Date): string {
  const l = new Date(now.getTime() + (market === "IN" ? 330 : -240) * 60_000);
  const z = (n: number) => String(n).padStart(2, "0");
  return `${z(l.getUTCHours())}:${z(l.getUTCMinutes())}:${z(l.getUTCSeconds())} ${market === "IN" ? "IST" : "ET"}`;
}

function MarketStatus({ market }: { market: Market }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  const [label, dot] = STATUS[exchangeStatus(market, now)];
  return (
    <div className="m-status">
      <span className="m-dot" style={{ background: dot }} />
      <span>
        {label} · {market === "IN" ? "NSE" : "NYSE"}
      </span>
      <span className="m-mono m-ink3">{exchangeClock(market, now)}</span>
    </div>
  );
}

function Footer({ theme, toggleTheme }: { theme: string; toggleTheme: () => void }) {
  const op = useOperator();
  const router = useRouter();
  const initials =
    (op?.name || op?.email || "OP")
      .split(/[\s@.]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((s) => s[0]?.toUpperCase() || "")
      .join("") || "OP";
  async function signOut() {
    await signOutOperator();
    router.replace("/sign-in");
  }
  return (
    <div className="m-foot">
      <span className="m-avatar">{initials}</span>
      <div className="who">
        <div>{op?.name || op?.email || "Operator"}</div>
        <button className="m-link" onClick={signOut}>
          Sign out
        </button>
      </div>
      <ThemeButton theme={theme} toggle={toggleTheme} />
    </div>
  );
}

function ThemeButton({ theme, toggle }: { theme: string; toggle: () => void }) {
  return (
    <button className="m-sq" onClick={toggle} aria-label={theme === "dark" ? "Switch to light" : "Switch to dark"}>
      <Icon name={theme === "dark" ? "light_mode" : "dark_mode"} />
    </button>
  );
}

/** Held orders for the active desk, kept live off the memos channel. */
function useHeld(market: Market): [Memo[] | null, () => void] {
  const [held, setHeld] = useState<Memo[] | null>(null);
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  useEffect(() => {
    let cancelled = false;
    listHeldMemos(25, market)
      .then((m) => !cancelled && setHeld(m))
      .catch(() => !cancelled && setHeld([]));
    return () => {
      cancelled = true;
    };
  }, [market, nonce]);
  useEffect(() => subscribeMemos(() => reload()), [reload]);
  return [held, reload];
}

export function Shell({ children }: { children: (screen: ScreenId) => ReactNode }) {
  const { market } = useMarket();
  const [theme, toggleTheme] = useTheme("light");
  // AuthGate mounts the shell only on the client, so the last screen and
  // detail level can be read straight from storage (a `?screen=` link wins).
  const [initial] = useState(() => new URLSearchParams(window.location.search).get("screen") ?? read(SCREEN_KEY));
  const [screen, setScreen] = useState<ScreenId>(() => resolveScreen(initial) ?? "today");
  const [full, setFull] = useState(() => read(DETAIL_KEY) === "full");
  const [researchView, setResearchView] = useState<ResearchView>(initial === "quant" ? "quant" : "filings");
  const [focusMemo, setFocusMemo] = useState<Memo | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [held, reloadHeld] = useHeld(market);

  const go = useCallback((raw: string) => {
    const id = resolveScreen(raw);
    if (!id) return;
    if (raw === "quant") setResearchView("quant");
    setScreen(id);
    setMoreOpen(false);
    write(SCREEN_KEY, id);
    window.scrollTo(0, 0);
  }, []);
  const setDetail = (f: boolean) => {
    setFull(f);
    write(DETAIL_KEY, f ? "full" : "essentials");
  };

  const pending = (held ?? []).filter((m) => m.status === "review").length;
  const [crumb, items] = NAV.find(([, it]) => it.some(([s]) => s === screen))!;
  const title = items.find(([s]) => s === screen)![1];
  const moreOn = MORE.some(([s]) => s === screen);

  const ctx: DeskState = {
    screen,
    go,
    full,
    showFull: () => setDetail(true),
    researchView,
    setResearchView,
    focusMemo,
    setFocusMemo,
    held,
    reloadHeld,
  };

  return (
    <DeskCtx.Provider value={ctx}>
      <div className="mx" data-theme={theme}>
        <aside className="m-side">
          <div className="m-brand">
            <span className="m-mark" aria-hidden />
            <Link href="/">Meridian</Link>
          </div>
          <MarketSeg />
          <nav className="m-nav" aria-label="Desk sections">
            {NAV.map(([label, its]) => (
              <div className="grp" key={label}>
                <div className="m-label">{label}</div>
                {its.map(([id, lab, icon]) => (
                  <button key={id} onClick={() => go(id)} aria-current={screen === id ? "page" : undefined}>
                    <Icon name={icon} />
                    <span style={{ flex: 1 }}>{lab}</span>
                    {id === "today" && pending > 0 && <span className="m-badge">{pending}</span>}
                  </button>
                ))}
              </div>
            ))}
          </nav>
          <Footer theme={theme} toggleTheme={toggleTheme} />
        </aside>

        <div className="m-top">
          <span className="name">Meridian</span>
          <MarketSeg />
          <ThemeButton theme={theme} toggle={toggleTheme} />
        </div>

        <main className="m-main">
          <header className="m-head">
            <div className="m-head-in">
              <div style={{ minWidth: 0, marginRight: "auto" }}>
                <div className="m-meta">{crumb}</div>
                <h1>{title}</h1>
              </div>
              <MarketStatus market={market} />
              <div className="m-seg" role="group" aria-label="Detail level">
                <button aria-pressed={!full} onClick={() => setDetail(false)}>
                  Essentials
                </button>
                <button aria-pressed={full} onClick={() => setDetail(true)}>
                  Full detail
                </button>
              </div>
            </div>
          </header>
          <div className="m-body">{children(screen)}</div>
        </main>

        {moreOpen && (
          <>
            <button className="m-more-bg" aria-label="Close menu" onClick={() => setMoreOpen(false)} />
            <div className="m-more" role="menu">
              {MORE.map(([id, label, icon]) => (
                <button key={id} role="menuitem" onClick={() => go(id)}>
                  <Icon name={icon} />
                  {label}
                </button>
              ))}
            </div>
          </>
        )}
        <nav className="m-tabbar" aria-label="Desk sections">
          {TABS.map(([id, label, icon]) => (
            <button key={id} onClick={() => go(id)} aria-current={screen === id ? "page" : undefined}>
              <Icon name={icon} />
              <span>{label}</span>
              {id === "today" && pending > 0 && <span className="m-badge">{pending}</span>}
            </button>
          ))}
          <button
            onClick={() => setMoreOpen((o) => !o)}
            aria-current={moreOn ? "page" : undefined}
            aria-expanded={moreOpen}
          >
            <Icon name="more_horiz" />
            <span>More</span>
          </button>
        </nav>
      </div>
    </DeskCtx.Provider>
  );
}
