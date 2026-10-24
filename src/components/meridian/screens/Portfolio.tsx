"use client";

import { useEffect, useMemo, useState } from "react";
import { Panel } from "../primitives";
import { useMarket } from "../MarketContext";
import { IbkrAccountsPanel } from "../IbkrAccounts";
import { FundMandatePanel } from "../FundMandate";
import { HorizonSourcePanel, useHorizonStatus } from "../HorizonSource";
import { BenchmarkPanel } from "../Benchmark";
import { fmtMoney, fmtFullMoney } from "@/lib/meridian/format";
import { operatorFetch } from "@/lib/auth/operator-fetch";
import {
  listFundPositions,
  listAdvisoryPositions,
  listHeldMemos,
  subscribeMemos,
  listFundSnapshots,
  listScenarios,
  latestConstructionPlan,
} from "@/lib/appwrite/queries";
import type {
  Position,
  Memo,
  FundSnapshot,
  Scenario,
  FactorExposure,
  ScenarioBranch,
  Market,
  ConstructionPlan,
  ConstructionPlanPayload,
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

function PositionsList({ rows, loaded, market, empty = "No positions on the book." }: { rows: Position[]; loaded: boolean; market: Market; empty?: string }) {
  if (loaded && rows.length === 0) {
    return (
      <div className="dim" style={{ fontFamily: "var(--mono)", fontSize: 11, padding: "12px 16px" }}>
        {empty}
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

// ── Construction plan (the desk's stored plan per book) ───────────────────────

type MandateCash = { cash: number };

type PlanRow = { row: ConstructionPlan; payload: ConstructionPlanPayload | null };

const pctOf = (x: number | null | undefined, d = 1) => (x == null ? "—" : `${(x * 100).toFixed(d)}%`);
const BINDING: Record<ConstructionPlan["binding"], string> = {
  target: "at target TE",
  bounds: "inside target · bounds bind",
  floor: "above target · floor binds",
};

function PlanPanel({ market, book, targetTe }: { market: Market; book: ConstructionPlan["book"]; targetTe: number | null }) {
  // The desk writes one plan per book and exchange session (construct step);
  // the screen only reads it. Tagged with the desk it was read for, so a
  // market switch shows "reading" until that desk's row lands.
  const [loaded, setLoaded] = useState<{ market: Market; plan: PlanRow | null } | null>(null);
  const [open, setOpen] = useState<"fixed" | "skipped" | null>(null);
  const current = loaded?.market === market ? loaded : null;

  useEffect(() => {
    let cancelled = false;
    latestConstructionPlan(market, book)
      .catch(() => null)
      .then((row) => {
        if (cancelled) return;
        let payload: ConstructionPlanPayload | null = null;
        try {
          payload = row ? (JSON.parse(row.plan_json) as ConstructionPlanPayload) : null;
        } catch {
          payload = null;
        }
        setLoaded({ market, plan: row ? { row, payload } : null });
      });
    return () => { cancelled = true; };
  }, [market, book]);

  const mono = { fontFamily: "var(--mono)", fontSize: 11 } as const;
  if (!current) return <div className="dim" style={{ ...mono, padding: "12px 16px" }}>Reading the {book} construction plan…</div>;
  if (!current.plan) {
    return (
      <div className="dim" style={{ ...mono, padding: "12px 16px", lineHeight: 1.5 }}>
        {targetTe == null
          ? `No ${market} risk budget set: the plan is sized to its target tracking error. Set one in the fund mandate panel.`
          : `No ${market} ${book} plan stored yet: the desk's construct step writes one each session.`}
      </div>
    );
  }

  const { row, payload } = current.plan;
  const lines = (payload?.lines ?? []).filter((l) => l.shares != null && l.shares !== 0);
  const fixed = payload?.fixed ?? [];
  const skipped = payload?.skipped ?? [];
  const skippedCount = payload?.skipped_count ?? skipped.length;
  const buy = lines.filter((l) => (l.value ?? 0) > 0).reduce((s, l) => s + (l.value ?? 0), 0);
  const sell = lines.filter((l) => (l.value ?? 0) < 0).reduce((s, l) => s - (l.value ?? 0), 0);
  const shares = (n: number) => Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: market === "IN" ? 0 : 2 });
  const beta = (x: number | null) => (x == null ? "—" : x.toFixed(2));

  // `from` → `to` for a before/after figure; `to` alone otherwise.
  const stat = (k: string, from: string | null, to: string, sub?: string) => (
    <div style={{ padding: "8px 12px", borderRight: "1px solid var(--line-soft)" }}>
      <div style={{ fontSize: 9.5, color: "var(--ink-3)", letterSpacing: "0.12em", textTransform: "uppercase" }}>{k}</div>
      <div style={{ color: "var(--ink-0)", marginTop: 2 }}>
        {from != null && <><span style={{ color: "var(--ink-2)" }}>{from}</span> → </>}{to}
      </div>
      {sub && <div className="dim" style={{ fontSize: 9.5, marginTop: 2 }}>{sub}</div>}
    </div>
  );
  const toggle = (key: "fixed" | "skipped", label: string, items: { ticker: string; reason: string; label?: string | null }[]) => (
    <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--line-soft)" }}>
      <button type="button" onClick={() => setOpen((o) => (o === key ? null : key))} style={{ all: "unset", cursor: "pointer", color: "var(--ink-2)" }}>
        {open === key ? "▾" : "▸"} {label}
      </button>
      {open === key && items.map((u) => (
        <div key={u.ticker} className="dim" style={{ fontSize: 10, marginTop: 4 }} title={u.label ?? undefined}>
          {u.ticker}{u.label ? ` · ${u.label}` : ""} — {u.reason}
        </div>
      ))}
    </div>
  );

  return (
    <div style={mono}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", borderBottom: "1px solid var(--line-soft)" }}>
        {stat("Tracking error", pctOf(row.te_before), pctOf(row.te_after), `target ${pctOf(row.target_te)} · ${BINDING[row.binding] ?? row.binding}`)}
        {stat("Beta", beta(row.beta_before), beta(row.beta_after), payload?.index ? `vs ${payload.index}` : undefined)}
        {stat("VaR 95 · 1d", pctOf(row.var95_before, 2), pctOf(row.var95_after, 2),
          row.var95_after == null ? undefined : `${fmtMoney(row.var95_after * row.nav, market)} of ${fmtMoney(row.nav, market)}`)}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", borderBottom: "1px solid var(--line-soft)" }}>
        {stat("Sell", null, fmtMoney(sell, market))}
        {stat("Buy", null, fmtMoney(buy, market))}
        {stat("Expected α", null, pctOf(row.alpha, 2), "confidence × upside, weighted")}
      </div>

      {lines.length === 0 && (
        <div className="dim" style={{ padding: "12px 16px" }}>
          {fixed.length && !(payload?.lines ?? []).length
            ? "No trades: the plan holds every name as it is (why below)."
            : "No trades: the book already sits at the plan's weights."}
        </div>
      )}
      {lines.map((l) => (
        <div key={l.ticker} style={{ padding: "8px 12px", borderBottom: "1px solid var(--line-soft)" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 44px 70px 80px 92px", gap: 8, alignItems: "baseline" }}>
            <span style={{ color: "var(--ink-0)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={l.label ?? undefined}>
              {l.ticker}{l.role === "core" ? " · core" : ""}
            </span>
            <span style={{ color: (l.shares ?? 0) > 0 ? "var(--green)" : "var(--red)", letterSpacing: "0.12em", textTransform: "uppercase" }}>
              {(l.shares ?? 0) > 0 ? "buy" : "sell"}
            </span>
            <span style={{ color: "var(--ink-2)", textAlign: "right" }}>{shares(l.shares ?? 0)} sh</span>
            <span style={{ color: "var(--ink-1)", textAlign: "right" }}>{fmtMoney(Math.abs(l.value ?? 0), market)}</span>
            <span style={{ color: "var(--ink-3)", textAlign: "right" }}>
              {pctOf(l.from)}→{pctOf(l.toRounded)}
            </span>
          </div>
          <div className="dim" style={{ fontSize: 10, marginTop: 3, lineHeight: 1.4 }}>{l.why}</div>
        </div>
      ))}

      {fixed.length > 0 && toggle("fixed", `${fixed.length} held as they are`, fixed.map((f) => ({ ...f, reason: `${pctOf(f.weight)} · ${f.reason}` })))}
      {skippedCount > 0 && (skipped.length
        ? toggle("skipped", `${skippedCount} left out`, skipped)
        : <div className="dim" style={{ padding: "8px 12px", borderBottom: "1px solid var(--line-soft)" }}>{skippedCount} left out (reasons not stored)</div>)}

      <div className="dim" style={{ padding: "8px 12px", fontSize: 10, lineHeight: 1.5 }}>
        Session {row.session} · {new Date(row.captured_at).toLocaleString()}{payload?.marks ? ` · marks: ${payload.marks}` : ""}.{" "}
        {book === "fund"
          ? `The PM sizes each buy to its line; the broker trades the ${payload?.core ?? "index"} core to the plan once a session.`
          : "Advisory only: nothing is sent to a broker."}
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
  // Two books, never summed: the fund's own (mandate cash + the desk's paper
  // positions) and the advisory book (the operator's holdings via Horizon/IBKR).
  const [positions, setPositions] = useState<Position[]>([]);
  const [advisory, setAdvisory] = useState<Position[]>([]);
  const [snapshots, setSnapshots] = useState<FundSnapshot[]>([]);
  const [advisorySnaps, setAdvisorySnaps] = useState<FundSnapshot[]>([]);
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [posLoaded, setPosLoaded] = useState(false);
  // The fund mandate's undeployed cash (null with no mandate: no fund). Part
  // of fund NAV, so a fresh fund shows its capital base before it deploys.
  const [mandate, setMandate] = useState<MandateCash | null>(null);
  const mandateCash = mandate?.cash ?? null;
  // The desk's target tracking error (risk_budgets), null until the operator sets one.
  const [targetTe, setTargetTe] = useState<number | null>(null);
  // Bumped after a Horizon sync so the book re-reads without a market switch.
  const [reloadKey, setReloadKey] = useState(0);
  const { status: horizon, refresh: refreshHorizon } = useHorizonStatus();

  useEffect(() => {
    let cancelled = false;
    setPosLoaded(false);
    setPositions([]);
    setAdvisory([]);
    setSnapshots([]);
    setAdvisorySnaps([]);
    setScenarios([]);
    setMandate(null);
    setTargetTe(null);
    Promise.allSettled([listFundPositions(200, market), listAdvisoryPositions(200, market)]).then(([f, a]) => {
      if (cancelled) return;
      if (f.status === "fulfilled") setPositions(f.value);
      if (a.status === "fulfilled") setAdvisory(market === "IN" ? normalizeWeights(a.value) : a.value);
      setPosLoaded(true);
    });
    listFundSnapshots(200, market, "fund")
      .then((s) => { if (!cancelled) setSnapshots(s); })
      .catch(() => {});
    listFundSnapshots(200, market, "advisory")
      .then((s) => { if (!cancelled) setAdvisorySnaps(s); })
      .catch(() => {});
    listScenarios(12, market)
      .then((s) => { if (!cancelled) setScenarios(s); })
      .catch(() => {});
    operatorFetch("/api/fund/onboard", { cache: "no-store" })
      .then((r) => r.json())
      .then((j: { mandates?: Record<string, MandateCash | null>; budgets?: Record<string, { target_te: number } | null> }) => {
        if (cancelled) return;
        setMandate(j.mandates?.[market] ?? null);
        setTargetTe(j.budgets?.[market]?.target_te ?? null);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [market, reloadKey]);

  // Fund NAV = its positions' market value + undeployed mandate cash. With no
  // mandate there is no fund (positions without one never fill).
  const navUsd = useMemo(
    () => (mandateCash == null ? 0 : positions.reduce((s, p) => s + (p.market_value || 0), 0) + mandateCash),
    [positions, mandateCash],
  );
  const advisoryMV = useMemo(() => advisory.reduce((s, p) => s + (p.market_value || 0), 0), [advisory]);

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
          <span className="title">Fund Book · Live</span>
          <span className="meta">NAV · mandate cash + {positions.length} positions</span>
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

      <Panel title="Fund Book · Positions" meta="the desk's paper fills · ranked by MV" bodyClassName="tight">
        <PositionsList
          rows={positions}
          loaded={posLoaded}
          market={market}
          empty={mandate ? "Nothing deployed yet: the fund is all mandate cash." : "No fund mandate on this desk: set one to open the fund book."}
        />
      </Panel>

      <Panel title="Construction Plan · Fund" meta="this session's target book · Δ risk" bodyClassName="tight">
        <PlanPanel market={market} book="fund" targetTe={targetTe} />
      </Panel>

      <Panel title="Held Orders · Awaiting Approval" meta="broker · operator gate" bodyClassName="tight">
        <HeldOrders market={market} />
      </Panel>

      <Panel
        title="Fund Mandate · From Scratch"
        meta="capital base · risk budget · deployment"
        bodyClassName="tight"
      >
        <FundMandatePanel market={market} />
      </Panel>

      <Panel
        title="Scenario Tree · 24h"
        meta={scenarios.length ? `${scenarios.length} scenarios` : "no runs"}
        bodyClassName="tight"
      >
        <ScenarioTree scenarios={scenarios} />
      </Panel>

      <Panel
        title={`Advisory Book vs ${market === "IN" ? "Nifty 50" : "S&P 500"}`}
        meta="the operator's holdings · the index to beat"
        className="span-col-2"
        bodyClassName="tight"
      >
        <BenchmarkPanel positions={advisory} market={market} snapshots={advisorySnaps} />
      </Panel>

      <Panel title="Factor Exposures · Advisory" meta="weighted across the operator's holdings" bodyClassName="tight">
        <Exposures positions={advisory} />
      </Panel>

      <Panel
        title="Advisory Book · Holdings"
        meta={`${advisory.length} holdings · ${advisoryMV ? fmtMoney(advisoryMV, market) : "—"} · read-only`}
        bodyClassName="tight"
      >
        <PositionsList rows={advisory} loaded={posLoaded} market={market} empty="No holdings synced from Horizon or IBKR." />
      </Panel>

      <Panel title="Rebalance · Advisory" meta="the desk's construction plan · operator's holdings" bodyClassName="tight">
        <PlanPanel market={market} book="advisory" targetTe={targetTe} />
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
