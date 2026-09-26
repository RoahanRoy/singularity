"use client";

import { ReactNode, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { MarketTicker, ExchangeClock, exchangeStatus, type ExchangeStatus } from "./primitives";
import { useOperator } from "./AuthGate";
import { useMarket } from "./MarketContext";
import { signOutOperator } from "@/lib/auth/operator";
import { listPositions, listIbkrAccounts, listFundSnapshots } from "@/lib/appwrite/queries";
import type { Position } from "@/lib/appwrite/schema";
import { fmtFullMoney, type Market } from "@/lib/meridian/format";
import { useTheme } from "@/lib/meridian/theme";

export type ScreenId = "swarm" | "research" | "portfolio" | "console" | "compute";

// id, label, crumb, Material Symbols glyph
const SCREENS: { id: ScreenId; label: string; crumb: string; icon: string }[] = [
  { id: "portfolio", label: "Portfolio", crumb: "Capital", icon: "pie_chart" },
  { id: "swarm", label: "Swarm", crumb: "Intelligence", icon: "hub" },
  { id: "research", label: "Research", crumb: "Intelligence", icon: "description" },
  { id: "console", label: "Console", crumb: "Operator", icon: "forum" },
  { id: "compute", label: "Compute", crumb: "System", icon: "memory" },
];

type Posture = {
  nav: number;
  cash: number;
  leverage: number;
  cashPct: number;
  var99: number | null;
  connected: boolean;
};

type Book = { positions: Position[]; posture: Posture | null };

/**
 * The live book behind the sidebar: held positions for the active desk and,
 * on the US desk, posture derived from the real IBKR account — NAV/cash from
 * the connected account, leverage & cash% from the positions, and a 99%/1d
 * historical VaR from the fund's NAV return series (— until there's history).
 */
function useBook(market: Market): Book | null {
  const [book, setBook] = useState<Book | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<Book> => {
      if (market !== "US") return { positions: await listPositions(50, market), posture: null };
      const [pos, accts, snaps] = await Promise.all([
        listPositions(50, "US"),
        listIbkrAccounts(10),
        listFundSnapshots(200, "US"),
      ]);
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
      return {
        positions: pos,
        posture: {
          nav,
          cash,
          leverage: nav ? grossMV / nav : 0,
          cashPct: nav ? cash / nav : 0,
          var99,
          connected: accts.some((a) => a.ibkr_account_id),
        },
      };
    };
    load()
      .then((b) => !cancelled && setBook(b))
      .catch(() => !cancelled && setBook(null));
    return () => {
      cancelled = true;
    };
  }, [market]);
  return book;
}

function Icon({ name, fill = 0, size = 19 }: { name: string; fill?: number; size?: number }) {
  return (
    <span className="msr" aria-hidden style={{ fontSize: size, fontVariationSettings: `'FILL' ${fill}` }}>
      {name}
    </span>
  );
}

function MarketSeg() {
  const { market, setMarket } = useMarket();
  return (
    <div className="v2-seg" role="group" aria-label="Market">
      {(["US", "IN"] as const).map((m) => (
        <button key={m} className={market === m ? "on" : ""} aria-pressed={market === m} onClick={() => setMarket(m)}>
          {m === "US" ? "US" : "India"}
        </button>
      ))}
    </div>
  );
}

function Holdings({ book, market }: { book: Book | null; market: Market }) {
  const rows = [...(book?.positions ?? [])].sort((a, b) => Math.abs(b.market_value) - Math.abs(a.market_value));
  const locale = market === "IN" ? "en-IN" : "en-US";
  return (
    <>
      <div className="v2-hold-head">
        <span>Holdings</span>
        <span className="meta">{market === "IN" ? "India Fund · Kite" : "US Fund · IBKR"}</span>
      </div>
      <div className="v2-hold">
        {book && rows.length === 0 && (
          <div className="v2-empty">
            No positions yet. Connect {market === "IN" ? "a Kite account" : "IBKR"} from Portfolio.
          </div>
        )}
        {rows.map((p) => {
          const cost = p.market_value - p.unrealized_pnl;
          const pct = cost ? (p.unrealized_pnl / Math.abs(cost)) * 100 : 0;
          const px = p.qty ? p.market_value / p.qty : 0;
          const tone = pct >= 0 ? "up" : "down";
          return (
            <div key={p.$id} className="v2-hold-row" title="Unrealised P&L vs. average cost">
              <div className="who">
                <div className="sym">{p.ticker}</div>
                <div className="sub">
                  {p.qty.toLocaleString(locale)} sh · {(p.weight * 100).toFixed(1)}%
                </div>
              </div>
              <div className="px">
                <div>{px.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
                <span className={"chg " + tone}>
                  {(pct >= 0 ? "+" : "−") + Math.abs(pct).toFixed(2)}%
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

function PostureLine({ posture }: { posture: Posture | null }) {
  if (!posture?.connected) return null;
  return (
    <div className="v2-posture">
      <span>
        NAV <b>{fmtFullMoney(posture.nav, "US")}</b>
      </span>
      <span>
        Lev <b>{posture.leverage.toFixed(2)}×</b>
      </span>
      <span>
        VaR <b>{posture.var99 != null ? (posture.var99 * 100).toFixed(2) + "%" : "—"}</b>
      </span>
      <span>
        Cash <b>{(posture.cashPct * 100).toFixed(1)}%</b>
      </span>
    </div>
  );
}

function Operator() {
  const op = useOperator();
  const router = useRouter();
  const initials =
    (op?.name || op?.email || "OP")
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
    <div className="v2-foot">
      <div className="avatar">{initials}</div>
      <div className="who">
        <div className="name">{op?.name || op?.email || "Operator"}</div>
        <Link href="/guided" className="role">
          Guided tour
        </Link>
      </div>
      <button onClick={handleSignOut} className="out">
        Sign out
      </button>
    </div>
  );
}

const STATUS_LABEL: Record<ExchangeStatus, string> = {
  open: "Market open",
  pre: "Pre-open",
  after: "After hours",
  closed: "Market closed",
};

function MarketStatus({ market }: { market: Market }) {
  // Recompute on the client every 30s so the status flips as sessions open/close.
  // SSR renders nothing; the effect hydrates the real status.
  const [status, setStatus] = useState<ExchangeStatus | null>(null);
  useEffect(() => {
    const tick = () => setStatus(exchangeStatus(market));
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, [market]);
  if (!status) return null;
  return (
    <span className={"v2-status " + status}>
      <span className="ping" aria-hidden />
      {STATUS_LABEL[status]} · {market === "IN" ? "NSE" : "NYSE"}
    </span>
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
  const { market } = useMarket();
  const [theme, toggleTheme] = useTheme("dark");
  const book = useBook(market);
  const cur = SCREENS.find((s) => s.id === active)!;

  return (
    <div className="meridian-root mx-desk" data-theme={theme}>
      <div className="app v2">
        <aside className="v2-side mx-glass">
          <div className="v2-brand">
            <span className="mark" aria-hidden>
              <span />
            </span>
            <Link href="/" className="name">
              Meridian
            </Link>
            <button className="v2-round" onClick={toggleTheme} aria-label="Toggle appearance">
              <Icon name={theme === "dark" ? "light_mode" : "dark_mode"} size={18} />
            </button>
          </div>
          <MarketSeg />
          <nav className="v2-nav">
            {SCREENS.map((s) => (
              <button
                key={s.id}
                className={active === s.id ? "on" : ""}
                aria-current={active === s.id ? "page" : undefined}
                onClick={() => setActive(s.id)}
              >
                <Icon name={s.icon} fill={active === s.id ? 1 : 0} />
                {s.label}
              </button>
            ))}
          </nav>
          <Holdings book={book} market={market} />
          <PostureLine posture={market === "US" ? (book?.posture ?? null) : null} />
          <Operator />
        </aside>

        <header className="v2-head mx-glass">
          <div className="row">
            <span className="title">{cur.label}</span>
            <span className="crumb">{cur.crumb}</span>
            <div className="right">
              <MarketStatus market={market} />
              <span className="clock">
                <ExchangeClock market={market} />
              </span>
            </div>
          </div>
          <MarketTicker />
        </header>

        <main className="main">{children}</main>

        <nav className="v2-tabs mx-glass" aria-label="Screens">
          {SCREENS.map((s) => (
            <button key={s.id} className={active === s.id ? "on" : ""} onClick={() => setActive(s.id)}>
              <Icon name={s.icon} fill={active === s.id ? 1 : 0} size={26} />
              <span>{s.label}</span>
            </button>
          ))}
        </nav>
      </div>
    </div>
  );
}

export { SCREENS };

export function useScreenState(initial: ScreenId = "portfolio") {
  return useState<ScreenId>(initial);
}
