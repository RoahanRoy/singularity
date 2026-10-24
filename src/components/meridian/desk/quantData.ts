"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useMarket } from "../MarketContext";
import { listQuantHeads, listQuantCycle, subscribeQuantReports, QUANT_HEAD_AGENTS } from "@/lib/appwrite/queries";
import type { QuantReport, QuantReportPayload } from "@/lib/appwrite/schema";

/**
 * The quant desk's data: one agent per method writes a report to
 * `quant_reports` as the desk loop runs it. These parse the reports, group them
 * into each name's newest cycle and keep that cycle live.
 */

// ── Payload accessors (payload_json is untyped JSON) ─────────────────────────

export function parsePayload(r: QuantReport): QuantReportPayload {
  if (!r.payload_json) return {};
  try {
    const v: unknown = JSON.parse(r.payload_json);
    return v && typeof v === "object" ? (v as QuantReportPayload) : {};
  } catch {
    return {};
  }
}

function field(obj: unknown, key: string): unknown {
  return obj && typeof obj === "object" ? (obj as Record<string, unknown>)[key] : undefined;
}
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

type Contribution = { agent: string; label: string; score: number | null; weight: number; contribution: number; basis: string; validated: boolean };
type Blend = { low: number; high: number; mid: number; upsidePct: number; verdict: string; method: string };
export type EnsembleView = {
  composite: number;
  direction: string;
  confidence: number | null;
  agreement: number | null;
  totalWeight: number | null;
  validatedWeight: number | null;
  inputs: Contribution[];
  notes: string[];
  price: number | null;
  currency: string | null;
  blend: Blend | null;
  dailyVar: { value: number; source: string } | null;
};

export function ensembleView(r: QuantReport | undefined): EnsembleView | null {
  if (!r) return null;
  const d = parsePayload(r).data;
  const composite = num(field(d, "composite")) ?? r.score;
  if (composite == null) return null;
  const inputs = Array.isArray(field(d, "inputs")) ? (field(d, "inputs") as unknown[]) : [];
  const b = field(d, "blend");
  const low = num(field(b, "fairValueLow")), high = num(field(b, "fairValueHigh")), mid = num(field(b, "fairValueMid"));
  const up = num(field(b, "impliedUpsidePct"));
  const dv = field(d, "dailyVar");
  const dvValue = num(field(dv, "value"));
  return {
    composite,
    direction: str(field(d, "direction")) ?? "neutral",
    confidence: num(field(d, "confidence")),
    agreement: num(field(d, "agreement")),
    totalWeight: num(field(d, "totalWeight")),
    validatedWeight: num(field(d, "validatedWeight")),
    inputs: inputs.map((c) => ({
      agent: str(field(c, "agent")) ?? "",
      label: str(field(c, "label")) ?? "",
      score: num(field(c, "score")),
      weight: num(field(c, "weight")) ?? 0,
      contribution: num(field(c, "contribution")) ?? 0,
      basis: str(field(c, "basis")) ?? "",
      validated: field(c, "validated") === true,
    })),
    notes: (Array.isArray(field(d, "notes")) ? (field(d, "notes") as unknown[]) : []).map(str).filter((x): x is string => !!x),
    price: num(field(d, "price")),
    currency: str(field(d, "currency")),
    blend: low != null && high != null && mid != null && up != null
      ? { low, high, mid, upsidePct: up, verdict: str(field(b, "verdict")) ?? "fair", method: str(field(b, "method")) ?? "" }
      : null,
    dailyVar: dvValue != null ? { value: dvValue, source: str(field(dv, "source")) ?? "" } : null,
  };
}

// ── Cycles ────────────────────────────────────────────────────────────────────

export type Status = "done" | "stopped" | "running" | "incomplete";
export type Head = { ticker: string; cycleId: string; lastAt: string; composite: number | null; direction: string | null; status: Status };

const RUNNING_WINDOW_MS = 20 * 60 * 1000;

/** The newest cycle per ticker from the progress rows, newest first. */
export function groupHeads(rows: QuantReport[], now: number): Head[] {
  const cycles = new Map<string, QuantReport[]>();
  for (const r of rows) cycles.set(r.cycle_id, [...(cycles.get(r.cycle_id) ?? []), r]);
  const newest = new Map<string, { cycleId: string; lastAt: string; rows: QuantReport[] }>();
  for (const [cycleId, rs] of cycles) {
    const lastAt = rs.reduce((m, r) => (r.run_at > m ? r.run_at : m), "");
    const ticker = rs[0].ticker;
    const cur = newest.get(ticker);
    if (!cur || lastAt > cur.lastAt) newest.set(ticker, { cycleId, lastAt, rows: rs });
  }
  return [...newest.entries()]
    .map(([ticker, c]) => {
      const ens = c.rows.find((r) => r.agent === "ensemble-combiner");
      const screen = c.rows.find((r) => r.agent === "fundamentals-screener");
      const status: Status = ens ? "done"
        : screen?.summary.startsWith("FAIL") ? "stopped"
        : now - new Date(c.lastAt).getTime() < RUNNING_WINDOW_MS ? "running" : "incomplete";
      return {
        ticker,
        cycleId: c.cycleId,
        lastAt: c.lastAt,
        composite: ens?.score ?? null,
        direction: ens ? str(field(parsePayload(ens).data, "direction")) : null,
        status,
      };
    })
    .sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1));
}

export function mergeById(a: QuantReport[], b: QuantReport[]): QuantReport[] {
  const m = new Map<string, QuantReport>();
  for (const r of [...a, ...b]) m.set(r.$id, r);
  return [...m.values()];
}

/** The quant desk's live state: the measured names, the selected one, and its newest cycle's reports. */
export function useQuantDesk() {
  const { market } = useMarket();
  const [heads, setHeads] = useState<QuantReport[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  const [rows, setRows] = useState<QuantReport[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const cycleRef = useRef<string | null>(null);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    let cancelled = false;
    listQuantHeads(market)
      .then((r) => { if (!cancelled) { setHeads(r); setLoaded(true); } })
      .catch(() => { if (!cancelled) { setHeads([]); setLoaded(true); } });
    const unsub = subscribeQuantReports((r) => {
      if (cancelled || (r.market ?? "US") !== market) return;
      if ((QUANT_HEAD_AGENTS as readonly string[]).includes(r.agent)) setHeads((prev) => mergeById(prev, [r]));
      if (r.cycle_id === cycleRef.current) setRows((prev) => mergeById(prev, [r]));
    });
    return () => { cancelled = true; unsub(); };
  }, [market]);

  const list = useMemo(() => groupHeads(heads, now), [heads, now]);
  const head = list.find((h) => h.ticker === sel) ?? list[0] ?? null;
  const cycleId = head?.cycleId ?? null;

  useEffect(() => {
    cycleRef.current = cycleId;
    if (!cycleId) return;
    let cancelled = false;
    listQuantCycle(cycleId)
      .then((r) => { if (!cancelled) setRows((prev) => mergeById(prev.filter((x) => x.cycle_id === cycleId), r)); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [cycleId]);

  const byAgent = useMemo(() => {
    const m = new Map<string, QuantReport>();
    for (const r of rows) if (r.cycle_id === cycleId) m.set(r.agent, r);
    return m;
  }, [rows, cycleId]);

  return { market, loaded, list, head, byAgent, now, onSelect: setSel };
}
