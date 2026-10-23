"use client";

import { useEffect, useMemo, useState } from "react";
import { Panel } from "../primitives";
import { useMarket } from "../MarketContext";
import { IbkrAccountsPanel } from "../IbkrAccounts";
import { FundMandatePanel } from "../FundMandate";
import { HorizonSourcePanel, useHorizonStatus } from "../HorizonSource";
import { fmtMoney, fmtFullMoney } from "@/lib/meridian/format";
import { operatorFetch } from "@/lib/auth/operator-fetch";
import {
  listPositions,
  listHeldMemos,
  subscribeMemos,
  listFundSnapshots,
  listScenarios,
  listEnsembleVerdicts,
} from "@/lib/appwrite/queries";
import { planRebalance, verdictOf, type RebalanceAction, type Verdict } from "@/lib/fund/rebalance";
import type {
  Position,
  Memo,
  FundSnapshot,
  Scenario,
  FactorExposure,
  ScenarioBranch,
  Market,
} from "@/lib/appwrite/schema";

// ── helpers ────────────────────────────────────────────────────────────────

function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = xs.reduce((s, x) => s + x, 0) / xs.length;
  const v = xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
}

// ── PnL chart (driven by fund_snapshots) ─────────────────────────────────────

function PnLChart({ snapshots }: { snapshots: FundSnapshot[] }) {
  const data = useMemo(() => {
    if (snapshots.length === 0) return [0];
    const base = snapshots[0].nav_usd || 1;
    // cumulative % return vs. the first snapshot
    return snapshots.map((s) => (s.nav_usd / base - 1) * 100);
  }, [snapshots]);

  const w = 600, h = 180;
  const min = Math.min(...data), max = Math.max(...data);
  const range = max - min || 1;
  const pts = data.map((v, i) => [
    (i / Math.max(1, data.length - 1)) * w,
    h - ((v - min) / range) * (h - 20) - 10,
  ] as const);
  const d = pts.map(([x, y], i) => (i ? "L" : "M") + x.toFixed(2) + "," + y.toFixed(2)).join(" ");
  const zeroY = h - ((0 - min) / range) * (h - 20) - 10;
  const last = pts[pts.length - 1];
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ width: "100%", height: 180 }}>
      <defs>
        <linearGradient id="pnlFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--md-accent)" stopOpacity="0.30" />
          <stop offset="100%" stopColor="var(--md-accent)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <g stroke="var(--line-soft)" strokeWidth="0.5">
        {[0.25, 0.5, 0.75].map((p, i) => (
          <line key={i} x1="0" y1={h * p} x2={w} y2={h * p} />
        ))}
      </g>
      <line x1="0" y1={zeroY} x2={w} y2={zeroY} stroke="var(--ink-4)" strokeDasharray="2 3" strokeWidth="0.6" />
      <path d={d + ` L${w},${h} L0,${h} Z`} fill="url(#pnlFill)" />
      <path d={d} fill="none" stroke="var(--md-accent)" strokeWidth="1.4" vectorEffect="non-scaling-stroke" />
      {last && <circle cx={last[0]} cy={last[1]} r="2.2" fill="var(--md-accent)" />}
    </svg>
  );
}

// ── Factor exposures (aggregated from positions.factor_exposures_json) ────────

const FACTOR_LABELS: Record<string, string> = {
  US_LARGE: "US LARGE-CAP",
  US_SMALL: "US SMALL-CAP",
  EU_EQ: "EU EQUITIES",
  JP_EQ: "JP EQUITIES",
  EM_EQ: "EM EQUITIES",
  IG_CREDIT: "INV-GRADE CR",
  HY_CREDIT: "HIGH YIELD",
  RATES_2_5Y: "RATES 2-5Y",
  RATES_10Y: "RATES 10Y+",
  FX_USD: "FX · USD",
  GOLD: "GOLD",
  OIL: "OIL / ENERGY",
  VOL_VIX: "VOL (VIX)",
  // India desk (betas vs free Yahoo proxies)
  NIFTY_MKT: "NIFTY (MKT)",
  IN_BANKS: "NIFTY BANK",
  IN_IT: "NIFTY IT",
  FX_USDINR: "FX · USDINR",
};
const FACTOR_ORDER = Object.keys(FACTOR_LABELS);

// Each sync computes `weight` relative to the rows it wrote, so with several
// sources on one desk (a broker sync plus the paper book) the per-row weights no
// longer sum to 1. Recompute them book-globally from market value so weight% and
// the weighted factor exposures stay correct however many sources feed the book.
function normalizeWeights(positions: Position[]): Position[] {
  const total = positions.reduce((s, p) => s + Math.abs(p.market_value || 0), 0);
  if (total <= 0) return positions;
  return positions.map((p) => ({ ...p, weight: (p.market_value || 0) / total }));
}

function aggregateExposures(positions: Position[]): { factor: string; v: number }[] {
  const net: Record<string, number> = {};
  for (const p of positions) {
    if (!p.factor_exposures_json) continue;
    let factors: FactorExposure[];
    try {
      factors = JSON.parse(p.factor_exposures_json);
    } catch {
      continue;
    }
    if (!Array.isArray(factors)) continue;
    for (const f of factors) {
      if (!f || typeof f.beta !== "number") continue;
      net[f.factor] = (net[f.factor] || 0) + (p.weight || 0) * f.beta;
    }
  }
  const keys = Object.keys(net).sort(
    (a, b) => (FACTOR_ORDER.indexOf(a) + 1 || 99) - (FACTOR_ORDER.indexOf(b) + 1 || 99),
  );
  return keys.map((k) => ({ factor: k, v: net[k] }));
}

function Exposures({ positions }: { positions: Position[] }) {
  const rows = useMemo(() => aggregateExposures(positions), [positions]);
  const maxAbs = useMemo(() => Math.max(0.0001, ...rows.map((r) => Math.abs(r.v))), [rows]);

  if (rows.length === 0) {
    return (
      <div className="dim" style={{ fontFamily: "var(--mono)", fontSize: 11, padding: "12px 16px" }}>
        No factor exposures on the book.
      </div>
    );
  }
  return (
    <div>
      {rows.map((r, i) => {
        const pct = (r.v / maxAbs) * 50; // bar width relative to largest exposure
        return (
          <div key={i} className="exposure-row">
            <span style={{ color: "var(--ink-2)", letterSpacing: "0.08em" }}>
              {FACTOR_LABELS[r.factor] ?? r.factor}
            </span>
            <div className="b">
              <span className="zero" />
              {r.v >= 0 ? (
                <i className="pos" style={{ width: Math.abs(pct) + "%" }} />
              ) : (
                <i className="neg" style={{ width: Math.abs(pct) + "%" }} />
              )}
            </div>
            <span style={{ color: r.v >= 0 ? "var(--green)" : "var(--red)", textAlign: "right" }}>
              {(r.v >= 0 ? "+" : "") + (r.v * 100).toFixed(1)}%
            </span>
            <span style={{ color: "var(--ink-3)", textAlign: "right", fontSize: 10 }}>
              β {r.v.toFixed(2)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ── Scenario tree (driven by scenarios collection) ───────────────────────────

const FALLBACK_SCENARIO_NOTE = "No stress scenarios have been run yet.";

function fmtDelta(d: number): string {
  return (d >= 0 ? "+" : "−") + Math.abs(d * 100).toFixed(2) + "%";
}

function ScenarioTree({ scenarios }: { scenarios: Scenario[] }) {
  if (scenarios.length === 0) {
    return (
      <div className="scenario-tree">
        <div className="dim">{FALLBACK_SCENARIO_NOTE}</div>
      </div>
    );
  }
  return (
    <div className="scenario-tree">
      <div><span className="p">root</span></div>
      {scenarios.map((s, si) => {
        let branches: ScenarioBranch[] = [];
        try {
          branches = JSON.parse(s.shocks_json || "[]");
        } catch {
          branches = [];
        }
        const isLastScenario = si === scenarios.length - 1;
        const stem = isLastScenario ? "└─" : "├─";
        const cont = isLastScenario ? "   " : "│  ";
        const totalProb = branches.reduce((acc, b) => acc + (b.prob || 0), 0);
        return (
          <span key={s.$id} style={{ display: "contents" }}>
            <div>
              {stem} <span className="n">{s.name}</span>{" "}
              <span className="p">p={totalProb >= 0.999 ? "1.00" : totalProb.toFixed(2)}</span>
            </div>
            {branches.map((b, bi) => {
              const lastBranch = bi === branches.length - 1;
              const bstem = lastBranch ? "└─" : "├─";
              const neg = b.delta < 0;
              return (
                <div key={bi}>
                  {cont}{bstem} <span className="n">{b.label}</span>{" "}
                  <span className="p">{(b.prob || 0).toFixed(2)}</span> →{" "}
                  <span className={neg ? "neg" : "v"}>{fmtDelta(b.delta)}</span>
                  {typeof b.hedged_delta === "number" && (
                    <span className="p"> (hedged: {fmtDelta(b.hedged_delta)})</span>
                  )}
                </div>
              );
            })}
          </span>
        );
      })}
    </div>
  );
}

// ── Held orders (sized and cleared by the desk, waiting on the operator) ─────

type Held = { qty?: number; weight_pct?: number | null; venue?: string | null; algo?: string | null };

function parseHeld(raw: string | null | undefined): Held | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw);
    return p && typeof p === "object" ? (p as Held) : null;
  } catch {
    return null;
  }
}

function HeldOrders({ market }: { market: Market }) {
  const [items, setItems] = useState<Memo[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      listHeldMemos(8, market)
        .then((rows) => {
          if (cancelled) return;
          setItems(rows);
          setLoaded(true);
        })
        .catch(() => {
          if (!cancelled) setLoaded(true);
        });
    load();
    const unsub = subscribeMemos(() => {
      if (!cancelled) load();
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [market]);

  async function act(memoId: string, action: "approve" | "reject") {
    setBusyId(memoId);
    try {
      const res = await operatorFetch("/api/memos/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memoId, action }),
      });
      const j = (await res.json().catch(() => ({}))) as { status?: string; error?: string };
      if (res.ok) {
        const next = (j.status ?? (action === "approve" ? "approved" : "rejected")) as Memo["status"];
        setItems((prev) => prev.flatMap((m) => (m.$id !== memoId ? [m] : next === "rejected" ? [] : [{ ...m, status: next }])));
      } else {
        console.warn("memo action failed:", j.error);
      }
    } finally {
      setBusyId(null);
    }
  }

  if (loaded && items.length === 0) {
    return (
      <div className="dim" style={{ fontFamily: "var(--mono)", fontSize: 11, padding: "12px 16px" }}>
        No orders held for approval.
      </div>
    );
  }

  const button = (color: string, filled: boolean, busy: boolean) => ({
    fontFamily: "var(--mono)", fontSize: 9.5, letterSpacing: "0.12em", textTransform: "uppercase" as const,
    padding: "3px 8px", cursor: busy ? "wait" : "pointer",
    color: filled ? "var(--bg-0)" : color, background: filled ? color : "transparent", border: `1px solid ${color}`,
    opacity: busy ? 0.6 : 1,
  });

  return (
    <div>
      {items.map((m) => {
        const h = parseHeld(m.pending_exec_json);
        const busy = busyId === m.$id;
        return (
          <div
            key={m.$id}
            title={m.title}
            style={{
              display: "grid",
              gridTemplateColumns: "80px 1fr 60px auto",
              gap: 10,
              padding: "8px 12px",
              borderBottom: "1px solid var(--line-soft)",
              fontFamily: "var(--mono)",
              fontSize: 11,
              alignItems: "center",
            }}
          >
            <span style={{ color: "var(--ink-0)" }}>{m.ticker ?? "—"}</span>
            <span style={{ color: "var(--ink-2)" }}>
              <span style={{ color: "var(--green)", letterSpacing: "0.12em" }}>BUY</span> {h?.qty ?? "?"}
              {h?.weight_pct != null ? ` · ${Number(h.weight_pct).toFixed(2)}%` : ""}
              {h?.venue ? ` · ${h.venue}` : ""}
            </span>
            <span style={{ color: "var(--ink-1)", textAlign: "right" }} title="analyst conviction">
              {m.conviction.toFixed(2)}
            </span>
            {m.status === "approved" ? (
              <span className="dim" style={{ fontSize: 9.5, letterSpacing: "0.12em", textTransform: "uppercase" }}>
                approved · next cycle fills
              </span>
            ) : (
              <span style={{ display: "flex", gap: 6 }}>
                <button onClick={() => act(m.$id, "approve")} disabled={busy} style={button("var(--md-accent)", true, busy)}>
                  {busy ? "…" : "Approve"}
                </button>
                <button onClick={() => act(m.$id, "reject")} disabled={busy} style={button("var(--red)", false, busy)}>
                  Reject
                </button>
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Positions list ───────────────────────────────────────────────────────────

function PositionsList({ rows, loaded, market }: { rows: Position[]; loaded: boolean; market: Market }) {
  if (loaded && rows.length === 0) {
    return (
      <div className="dim" style={{ fontFamily: "var(--mono)", fontSize: 11, padding: "12px 16px" }}>
        No positions on the book.
      </div>
    );
  }
  return (
    <div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "70px 1fr 90px 90px 70px",
          gap: 10,
          padding: "6px 12px",
          fontFamily: "var(--mono)",
          fontSize: 10,
          color: "var(--ink-3)",
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          borderBottom: "1px solid var(--line-soft)",
        }}
      >
        <span>Ticker</span>
        <span>Qty</span>
        <span style={{ textAlign: "right" }}>MV</span>
        <span style={{ textAlign: "right" }}>uPnL</span>
        <span style={{ textAlign: "right" }}>Wt</span>
      </div>
      {rows.map((p) => (
        <div
          key={p.$id}
          style={{
            display: "grid",
            gridTemplateColumns: "70px 1fr 90px 90px 70px",
            gap: 10,
            padding: "8px 12px",
            borderBottom: "1px solid var(--line-soft)",
            fontFamily: "var(--mono)",
            fontSize: 11,
            alignItems: "center",
          }}
        >
          <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }} title={p.label ?? undefined}>
            <span style={{ color: "var(--ink-0)" }}>{p.ticker}</span>
            {/* A fund's ticker is a scheme code; its name is what says what it is. */}
            {p.label && (
              <span
                className="dim"
                style={{ fontSize: 9.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
              >
                {p.label}
              </span>
            )}
          </span>
          <span style={{ color: "var(--ink-2)" }}>{p.qty.toLocaleString()}</span>
          <span style={{ color: "var(--ink-1)", textAlign: "right" }}>{fmtMoney(p.market_value, market)}</span>
          <span
            style={{
              color: p.unrealized_pnl >= 0 ? "var(--green)" : "var(--red)",
              textAlign: "right",
            }}
          >
            {p.unrealized_pnl >= 0 ? "+" : "−"}{fmtMoney(Math.abs(p.unrealized_pnl), market)}
          </span>
          <span style={{ color: "var(--ink-2)", textAlign: "right" }}>
            {(p.weight * 100).toFixed(2)}%
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Rebalance (advisory, from the quant desk's ensemble verdicts) ─────────────

type MandateCaps = { cash: number; max_names: number; max_name_weight_pct: number };

// Desks without an onboarded mandate plan against the balanced posture's caps
// (POSTURE_CAPS in src/lib/fund/mandate.ts, which is server-side only).
const DEFAULT_CAPS: MandateCaps = { cash: 0, max_names: 20, max_name_weight_pct: 9 };

const ACTION_COLOR: Record<RebalanceAction, string> = {
  trim: "var(--red)",
  add: "var(--green)",
  buy: "var(--green)",
};

function RebalancePanel({ positions, mandate, market }: { positions: Position[]; mandate: MandateCaps | null; market: Market }) {
  // Tagged with the desk they were read for, so a market switch shows "reading"
  // until that desk's verdicts land instead of planning against the other desk's.
  const [loaded, setLoaded] = useState<{ market: Market; verdicts: Verdict[] } | null>(null);
  const [showUnrated, setShowUnrated] = useState(false);
  const verdicts = loaded?.market === market ? loaded.verdicts : null;

  useEffect(() => {
    let cancelled = false;
    listEnsembleVerdicts(market)
      .then((rows) => {
        if (!cancelled) setLoaded({ market, verdicts: rows.map(verdictOf).filter((v): v is Verdict => v !== null) });
      })
      .catch(() => { if (!cancelled) setLoaded({ market, verdicts: [] }); });
    return () => { cancelled = true; };
  }, [market]);

  const plan = useMemo(() => {
    if (!verdicts) return null;
    const caps = mandate ?? DEFAULT_CAPS;
    // Advice is for the real book; paper rows the desk loop may have written are left out.
    const real = positions.filter((p) => p.horizon_source || p.ibkr_account_id || p.kite_account_id);
    return planRebalance({
      holdings: real.map((p) => ({
        ticker: p.ticker,
        label: p.label,
        marketValue: p.market_value || 0,
        qty: p.qty,
        isFund: p.ticker.startsWith("MF:"),
      })),
      verdicts,
      cash: caps.cash,
      maxNames: caps.max_names,
      maxNameWeightPct: caps.max_name_weight_pct,
      currency: market === "IN" ? "INR" : "USD",
      wholeShares: market === "IN",
    });
  }, [positions, mandate, verdicts, market]);

  const mono = { fontFamily: "var(--mono)", fontSize: 11 } as const;
  if (!plan) {
    return <div className="dim" style={{ ...mono, padding: "12px 16px" }}>Reading quant verdicts…</div>;
  }

  const stat = (k: string, v: string, color = "var(--ink-0)") => (
    <div style={{ padding: "8px 12px", borderRight: "1px solid var(--line-soft)" }}>
      <div style={{ fontSize: 9.5, color: "var(--ink-3)", letterSpacing: "0.12em", textTransform: "uppercase" }}>{k}</div>
      <div style={{ color, marginTop: 2 }}>{v}</div>
    </div>
  );
  const shares = (n: number | null) =>
    n == null ? "—" : n.toLocaleString(undefined, { maximumFractionDigits: market === "IN" ? 0 : 2 });

  return (
    <div style={mono}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", borderBottom: "1px solid var(--line-soft)" }}>
        {stat("Capital", fmtMoney(plan.capital, market))}
        {stat("Sell", fmtMoney(plan.sellProceeds, market), "var(--red)")}
        {stat("Buy", fmtMoney(plan.buyCost, market), "var(--green)")}
        {stat("Cash after", fmtMoney(plan.cashAfter, market))}
      </div>

      {plan.trades.length === 0 && (
        <div className="dim" style={{ padding: "12px 16px" }}>
          Nothing to change: no held name is shorted or over its cap, and no fresh long fits the book.
        </div>
      )}
      {plan.trades.map((t) => (
        <div key={t.ticker} style={{ padding: "8px 12px", borderBottom: "1px solid var(--line-soft)" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 44px 70px 80px 92px", gap: 8, alignItems: "baseline" }}>
            <span style={{ color: "var(--ink-0)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={t.label ?? undefined}>
              {t.ticker}
            </span>
            <span style={{ color: ACTION_COLOR[t.action], letterSpacing: "0.12em", textTransform: "uppercase" }}>{t.action}</span>
            <span style={{ color: "var(--ink-2)", textAlign: "right" }}>{shares(t.shares)} sh</span>
            <span style={{ color: "var(--ink-1)", textAlign: "right" }}>{fmtMoney(t.value, market)}</span>
            <span style={{ color: "var(--ink-3)", textAlign: "right" }}>
              {(t.fromWeight * 100).toFixed(1)}→{(t.toWeight * 100).toFixed(1)}%
            </span>
          </div>
          <div className="dim" style={{ fontSize: 10, marginTop: 3, lineHeight: 1.4 }}>{t.reason}</div>
        </div>
      ))}

      {plan.notes.map((n) => (
        <div key={n} style={{ padding: "8px 12px", color: "var(--md-accent)", borderBottom: "1px solid var(--line-soft)", lineHeight: 1.5 }}>
          {n}
        </div>
      ))}

      {plan.unrated.length > 0 && (
        <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--line-soft)" }}>
          <button
            type="button"
            onClick={() => setShowUnrated((s) => !s)}
            style={{ all: "unset", cursor: "pointer", color: "var(--ink-2)" }}
          >
            {showUnrated ? "▾" : "▸"} {plan.unrated.length} held without a quant view
          </button>
          {showUnrated && plan.unrated.map((u) => (
            <div key={u.ticker} className="dim" style={{ fontSize: 10, marginTop: 4 }} title={u.label ?? undefined}>
              {u.ticker}{u.label ? ` · ${u.label}` : ""} — {u.reason}
            </div>
          ))}
        </div>
      )}

      <div className="dim" style={{ padding: "8px 12px", fontSize: 10, lineHeight: 1.5 }}>
        Advisory only: nothing is sent to a broker. Shorts trim by half, no name above{" "}
        {(mandate ?? DEFAULT_CAPS).max_name_weight_pct}%, new longs fill open slots under{" "}
        {(mandate ?? DEFAULT_CAPS).max_names} names, mandate cash counts as new money.
      </div>
    </div>
  );
}

// ── KPI derivation ────────────────────────────────────────────────────────────

type Kpi = [string, string, "up" | "down" | ""];

function deriveKpis(snapshots: FundSnapshot[], positions: Position[], navUsd: number): Kpi[] {
  const navs = snapshots.map((s) => s.nav_usd);
  const returns: number[] = [];
  for (let i = 1; i < navs.length; i++) {
    if (navs[i - 1]) returns.push(navs[i] / navs[i - 1] - 1);
  }

  const last = navs[navs.length - 1] || navUsd;

  // YTD / MTD anchored to the first snapshot in the current year / month
  const now = new Date();
  const yearStart = new Date(now.getFullYear(), 0, 1).getTime();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const navAtOrBefore = (t: number) => {
    let chosen = navs[0];
    for (const s of snapshots) {
      if (Date.parse(s.captured_at) <= t) chosen = s.nav_usd;
      else break;
    }
    return chosen;
  };
  const ytd = navs.length ? last / navAtOrBefore(yearStart) - 1 : 0;
  const mtd = navs.length ? last / navAtOrBefore(monthStart) - 1 : 0;

  const dailyVol = std(returns);
  const annVol = dailyVol * Math.sqrt(252);
  const meanRet = returns.length ? returns.reduce((s, x) => s + x, 0) / returns.length : 0;
  const sharpe = dailyVol ? (meanRet / dailyVol) * Math.sqrt(252) : 0;
  const downside = std(returns.filter((r) => r < 0));
  const sortino = downside ? (meanRet / downside) * Math.sqrt(252) : 0;

  // max drawdown over the nav series
  let peak = navs[0] || 0;
  let maxDD = 0;
  for (const v of navs) {
    if (v > peak) peak = v;
    if (peak) maxDD = Math.min(maxDD, v / peak - 1);
  }

  // exposures from the live book
  const grossMV = positions.reduce((s, p) => s + Math.abs(p.market_value || 0), 0);
  const netMV = positions.reduce((s, p) => s + (p.market_value || 0), 0);
  const nav = navUsd || last || 1;
  const grossExp = grossMV / nav;
  const netExp = netMV / nav;

  const pct = (x: number) => (x >= 0 ? "+" : "−") + Math.abs(x * 100).toFixed(2) + "%";

  // Series-derived KPIs need a return series; without one, show "—" rather than
  // a misleading 0.00. Net/Gross exposure come from the live book and always show.
  const hasHistory = returns.length >= 2;
  const series = (label: string, value: string, tone: "up" | "down" | ""): Kpi =>
    hasHistory ? [label, value, tone] : [label, "—", ""];

  return [
    series("YTD", pct(ytd), ytd >= 0 ? "up" : "down"),
    series("MTD", pct(mtd), mtd >= 0 ? "up" : "down"),
    series("Sharpe", sharpe.toFixed(2), ""),
    series("Sortino", sortino.toFixed(2), ""),
    series("Max DD", pct(maxDD), "down"),
    series("Vol (ann)", (annVol * 100).toFixed(1) + "%", ""),
    ["Net Exp", (netExp * 100).toFixed(0) + "%", ""],
    ["Gross Exp", (grossExp * 100).toFixed(0) + "%", ""],
  ];
}

// ── Screen ────────────────────────────────────────────────────────────────────

export function PortfolioScreen() {
  const { market } = useMarket();
  const [positions, setPositions] = useState<Position[]>([]);
  const [snapshots, setSnapshots] = useState<FundSnapshot[]>([]);
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [posLoaded, setPosLoaded] = useState(false);
  // Undeployed cash of a from-scratch fund mandate (null when the desk runs an
  // attached brokerage book instead). Folded into NAV so a freshly-onboarded
  // fund shows its capital base, not "—", before it has deployed anything.
  const [mandate, setMandate] = useState<MandateCaps | null>(null);
  const mandateCash = mandate?.cash ?? null;
  // Bumped after a Horizon sync so the book re-reads without a market switch.
  const [reloadKey, setReloadKey] = useState(0);
  const { status: horizon, refresh: refreshHorizon } = useHorizonStatus();

  useEffect(() => {
    let cancelled = false;
    setPosLoaded(false);
    setPositions([]);
    setSnapshots([]);
    setScenarios([]);
    setMandate(null);
    listPositions(200, market)
      .then((p) => {
        if (cancelled) return;
        setPositions(market === "IN" ? normalizeWeights(p) : p);
        setPosLoaded(true);
      })
      .catch(() => { if (!cancelled) setPosLoaded(true); });
    listFundSnapshots(200, market)
      .then((s) => { if (!cancelled) setSnapshots(s); })
      .catch(() => {});
    listScenarios(12, market)
      .then((s) => { if (!cancelled) setScenarios(s); })
      .catch(() => {});
    operatorFetch("/api/fund/onboard", { cache: "no-store" })
      .then((r) => r.json())
      .then((j: { mandates?: Record<string, MandateCaps | null> }) => {
        if (!cancelled) setMandate(j.mandates?.[market] ?? null);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [market, reloadKey]);

  // NAV = deployed market value + undeployed mandate cash. For an attached
  // brokerage book (no mandate) mandateCash is null and NAV is just the book MV.
  const navUsd = useMemo(
    () => positions.reduce((s, p) => s + (p.market_value || 0), 0) + (mandateCash ?? 0),
    [positions, mandateCash],
  );

  const lastSnap = snapshots[snapshots.length - 1];
  const todayPnl = lastSnap?.pnl_daily ?? 0;
  const navForDisplay = navUsd || lastSnap?.nav_usd || 0;
  const todayPct = lastSnap && lastSnap.nav_usd - todayPnl
    ? todayPnl / (lastSnap.nav_usd - todayPnl)
    : 0;

  const kpis = useMemo(
    () => deriveKpis(snapshots, positions, navUsd),
    [snapshots, positions, navUsd],
  );

  const sessionsCount = Math.max(0, snapshots.length - 1);

  return (
    <div className="portfolio">
      <div className="panel span-row-2" style={{ borderTop: 0, borderBottom: 0, borderLeft: 0 }}>
        <div className="panel-head">
          <span className="title">Fund · Live</span>
          <span className="meta">NAV · Mark-to-Market · {positions.length} positions</span>
        </div>
        <div className="panel-body tight" style={{ overflow: "auto" }}>
          <div className="bigstat">
            <span className="k">Net Asset Value</span>
            <span className="v">{navForDisplay ? fmtFullMoney(navForDisplay, market) : "—"}</span>
            <span className={"d " + (todayPnl >= 0 ? "up" : "down")}>
              {todayPnl >= 0 ? "+" : "−"}{Math.abs(todayPct * 100).toFixed(2)}% today ·{" "}
              {todayPnl >= 0 ? "+" : "−"}{fmtMoney(Math.abs(todayPnl), market)}
            </span>
          </div>
          <div style={{ padding: "10px 16px" }}>
            <div
              className="mono"
              style={{
                fontSize: 10,
                color: "var(--ink-3)",
                letterSpacing: "0.16em",
                textTransform: "uppercase",
                marginBottom: 8,
              }}
            >
              P&amp;L · {sessionsCount} sessions
            </div>
            <PnLChart snapshots={snapshots} />
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 0,
              borderTop: "1px solid var(--line-soft)",
            }}
          >
            {kpis.map(([k, v, c], i) => (
              <div
                key={i}
                style={{
                  padding: "12px 16px",
                  borderRight: i % 2 === 0 ? "1px solid var(--line-soft)" : 0,
                  borderBottom: i < 6 ? "1px solid var(--line-soft)" : 0,
                  fontFamily: "var(--mono)",
                }}
              >
                <div
                  style={{
                    fontSize: 10,
                    color: "var(--ink-3)",
                    letterSpacing: "0.12em",
                    textTransform: "uppercase",
                  }}
                >
                  {k}
                </div>
                <div
                  style={{
                    fontSize: 18,
                    color: c === "up" ? "var(--green)" : c === "down" ? "var(--red)" : "var(--ink-0)",
                    marginTop: 4,
                  }}
                >
                  {v}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <Panel title="Factor Exposures · Net" meta="weighted across book" bodyClassName="tight">
        <Exposures positions={positions} />
      </Panel>

      <Panel
        title="Scenario Tree · 24h"
        meta={scenarios.length ? `${scenarios.length} scenarios` : "no runs"}
        bodyClassName="tight"
      >
        <ScenarioTree scenarios={scenarios} />
      </Panel>

      <Panel title="Held Orders · Awaiting Approval" meta="broker · operator gate" bodyClassName="tight">
        <HeldOrders market={market} />
      </Panel>

      <Panel title="Positions · Live" meta="ranked by MV" bodyClassName="tight">
        <PositionsList rows={positions} loaded={posLoaded} market={market} />
      </Panel>

      <Panel title="Rebalance · Advisory" meta="quant verdicts · real book" bodyClassName="tight">
        <RebalancePanel positions={positions} mandate={mandate} market={market} />
      </Panel>

      <Panel
        title="Fund Mandate · From Scratch"
        meta="capital base · risk posture · deployment"
        bodyClassName="tight"
      >
        <FundMandatePanel market={market} />
      </Panel>

      {/* Horizon, when configured, supersedes the direct brokerage links. */}
      {horizon?.configured && (
        <Panel title="Horizon · Real Book" meta="source of record · read-only" bodyClassName="tight">
          <HorizonSourcePanel
            market={market}
            status={horizon}
            onSynced={() => {
              refreshHorizon();
              setReloadKey((k) => k + 1);
            }}
          />
        </Panel>
      )}

      {horizon && !horizon.configured && market === "IN" && (
        <Panel title="Horizon · Real Book" meta="not configured" bodyClassName="tight">
          <div className="dim" style={{ padding: "10px 14px", fontFamily: "var(--mono)", fontSize: 11, lineHeight: 1.6 }}>
            The India book comes from Horizon. Set HORIZON_URL and HORIZON_EXPORT_TOKEN on the server,
            then sync from here.
          </div>
        </Panel>
      )}

      {horizon && !horizon.configured && market === "US" && (
        <Panel title="IBKR Accounts · US" meta="Interactive Brokers · real holdings" bodyClassName="tight">
          <IbkrAccountsPanel />
        </Panel>
      )}
    </div>
  );
}
