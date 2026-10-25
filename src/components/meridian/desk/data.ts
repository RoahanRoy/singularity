"use client";

import { useEffect, useState } from "react";
import { listFundPositions, listFundSnapshots } from "@/lib/appwrite/queries";
import type { FundSnapshot, Memo, Position } from "@/lib/appwrite/schema";
import { operatorFetch } from "@/lib/auth/operator-fetch";
import type { Market } from "@/lib/meridian/format";

/**
 * Run `load` whenever `deps` change; null until it resolves, `fallback` if it
 * throws. A response for older deps is never shown.
 */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[], fallback: T): T | null {
  const key = JSON.stringify(deps);
  const [got, setGot] = useState<{ key: string; v: T } | null>(null);
  useEffect(() => {
    let cancelled = false;
    load()
      .then((v) => !cancelled && setGot({ key, v }))
      .catch(() => !cancelled && setGot({ key, v: fallback }));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return got && got.key === key ? got.v : null;
}

/** Local midnight, as an ISO stamp. */
export function startOfToday(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

export type MandateCash ={ cash: number; capital_base: number; status?: string };
export type Onboard = {
  mandates: Record<Market, MandateCash | null>;
  budgets: Record<Market, { target_te: number; set_at?: string } | null>;
};

/** The fund mandates and risk budgets for both desks (null where unset). */
export function useOnboard(nonce = 0): Onboard | null {
  return useLoad<Onboard>(
    () =>
      operatorFetch("/api/fund/onboard", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => ({
          mandates: { US: j?.mandates?.US ?? null, IN: j?.mandates?.IN ?? null },
          budgets: { US: j?.budgets?.US ?? null, IN: j?.budgets?.IN ?? null },
        })),
    [nonce],
    { mandates: { US: null, IN: null }, budgets: { US: null, IN: null } },
  );
}

export type FundBook = {
  positions: Position[];
  snapshots: FundSnapshot[];
  /** null: no mandate on this desk, so there is no fund. */
  cash: number | null;
  nav: number;
  /** The last mark's day P&L and its share of the prior NAV; null before a mark. */
  dayPnl: number | null;
  dayPct: number | null;
};

/**
 * The fund's own book: NAV is its positions' market value plus the mandate's
 * undeployed cash; the day's move is the latest snapshot's pnl_daily.
 */
export function useFundBook(market: Market, onboard: Onboard | null): FundBook | null {
  const rows = useLoad(
    () => Promise.all([listFundPositions(100, market), listFundSnapshots(400, market, "fund")]),
    [market],
    [[], []] as [Position[], FundSnapshot[]],
  );
  if (!rows || !onboard) return null;
  const [positions, snapshots] = rows;
  const cash = onboard.mandates[market]?.cash ?? null;
  const nav = cash == null ? 0 : positions.reduce((s, p) => s + (p.market_value || 0), 0) + cash;
  const last = snapshots[snapshots.length - 1];
  const dayPnl = last ? last.pnl_daily : null;
  const prior = last ? last.nav_usd - last.pnl_daily : 0;
  return { positions, snapshots, cash, nav, dayPnl, dayPct: dayPnl != null && prior > 0 ? dayPnl / prior : null };
}

export type Quote = { price: number; changePct: number };

/** Yahoo symbol for a desk ticker. */
export const yahoo = (t: string, market: Market) => (market === "IN" && !t.includes(".") && !t.startsWith("^") ? `${t}.NS` : t);

/** Live quotes keyed by the symbols passed in, refreshed every 30s. */
export function useQuotes(symbols: string[]): Record<string, Quote> {
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const key = symbols.join(",");
  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    const pull = () =>
      operatorFetch(`/api/market?symbols=${encodeURIComponent(key)}`, { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : { quotes: {} }))
        .then((j: { quotes?: Record<string, Quote> }) => !cancelled && setQuotes(j.quotes ?? {}))
        .catch(() => {});
    pull();
    const id = setInterval(pull, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [key]);
  return key ? quotes : {};
}

/** The sized order a held memo carries (scripts/agents/nodes.ts broker). Always a buy. */
export type HeldOrder = {
  qty: number;
  weight_pct: number | null;
  venue: string | null;
  algo: string | null;
  conviction: number | null;
  arrival: { price: number; at: string } | null;
  /** What each gate measured (nodes.ts stagedOrder); absent on orders staged before it was stored. */
  checks?: {
    te_before: number | null;
    te_after: number | null;
    target_te: number | null;
    var95_after_pct: number | null;
    critic: { verdict: "pass" | "revise" | "reject"; score: number | null } | null;
    valuation: { verdict: "rich" | "fair" | "cheap"; upside_pct: number | null; low: number; high: number } | null;
    compliance_flags: string[];
  };
};

export function heldOrder(m: Pick<Memo, "pending_exec_json">): HeldOrder | null {
  if (!m.pending_exec_json) return null;
  try {
    const p = JSON.parse(m.pending_exec_json);
    return p && typeof p === "object" && Number(p.qty) > 0 ? (p as HeldOrder) : null;
  } catch {
    return null;
  }
}

export async function decideMemo(memoId: string, action: "approve" | "reject" | "undo"): Promise<string | null> {
  const res = await operatorFetch("/api/memos/approve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ memoId, action }),
  });
  if (res.ok) return null;
  const j = await res.json().catch(() => ({}));
  return (j as { error?: string }).error ?? `HTTP ${res.status}`;
}

/** "4m", "3h", "2d": the compact age of an ISO time. */
export function ago(iso: string | null | undefined, now = Date.now()): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "—";
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** "14:32" local time of an ISO stamp, or the date when it isn't today. */
export function clockOrDate(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "—";
  const today = new Date();
  if (d.toDateString() === today.toDateString())
    return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Signed percent from a fraction: "+1.24%", "−0.80%", "—". */
export function pct(x: number | null | undefined, dp = 2, signed = false): string {
  if (x == null || !Number.isFinite(x)) return "—";
  const sign = x < 0 ? "−" : signed && x > 0 ? "+" : "";
  return sign + Math.abs(x * 100).toFixed(dp) + "%";
}

/** The design's money style: ₹ Cr / L on India, $B / $M on US. */
export function money(v: number, market: Market): string {
  const a = Math.abs(v);
  const s = v < 0 ? "−" : "";
  if (market === "IN")
    return a >= 1e7
      ? `${s}₹${(a / 1e7).toLocaleString("en-IN", { maximumFractionDigits: 2 })} Cr`
      : `${s}₹${(a / 1e5).toFixed(2)} L`;
  return a >= 1e9
    ? `${s}$${(a / 1e9).toFixed(2)}B`
    : a >= 1e6
      ? `${s}$${(a / 1e6).toFixed(2)}M`
      : `${s}$${Math.round(a).toLocaleString("en-US")}`;
}

export function fullMoney(v: number, market: Market): string {
  return (v < 0 ? "−" : "") + (market === "IN" ? "₹" : "$") + Math.round(Math.abs(v)).toLocaleString(market === "IN" ? "en-IN" : "en-US");
}

export const toneOf = (x: number | null | undefined) =>
  x == null || x === 0 ? "var(--ink-2)" : x > 0 ? "var(--up)" : "var(--down)";
