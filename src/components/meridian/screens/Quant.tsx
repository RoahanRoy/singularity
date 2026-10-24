"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Panel, Tag } from "../primitives";
import { useMarket } from "../MarketContext";
import { listQuantHeads, listQuantCycle, subscribeQuantReports, QUANT_HEAD_AGENTS } from "@/lib/appwrite/queries";
import type { Market, QuantReport, QuantReportPayload } from "@/lib/appwrite/schema";
import { QUANT_AGENTS, STAGES, type AgentSpec, type Stage } from "@/lib/quant/roster";

/**
 * The quant desk: one agent per method (valuation, time series, stochastic,
 * factor, technical, ML, fundamentals, qualitative, backtest), each writing a
 * report to `quant_reports` as the desk loop runs it. Left: the names the desk
 * has measured. Centre: every agent's report for the selected name's newest
 * cycle, live. Right: the evidence-weighted ensemble, fair-value band and VaR.
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

// ── Formatting ───────────────────────────────────────────────────────────────

function fmtAgo(iso: string, now: number): string {
  const s = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

const signed = (n: number, dp = 0) => `${n > 0 ? "+" : ""}${n.toFixed(dp)}`;
const toneOf = (score: number | null) => (score == null ? "var(--ink-3)" : score >= 15 ? "var(--green)" : score <= -15 ? "var(--red)" : "var(--ink-2)");
const money = (n: number, ccy: string | null) => `${ccy === "INR" ? "₹" : ccy === "USD" || !ccy ? "$" : `${ccy} `}${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

const STATUS_TAG: Record<Status, { label: string; tone?: "amber" | "cyan" | "green" | "red" }> = {
  done: { label: "done", tone: "green" },
  stopped: { label: "screen fail", tone: "red" },
  running: { label: "running", tone: "amber" },
  incomplete: { label: "partial" },
};

/** The practical workflow step each stage serves. */
const STAGE_NOTE: Record<Stage, string> = {
  "Market Data": "Inputs: prices, statements, news, options, factors, rates, peers",
  Screen: "Step 1 · Screen with ratios and scores",
  Valuation: "Step 2 · Value with DCF and multiples",
  Qualitative: "Step 3 · Moat, management, governance, industry, macro, sentiment",
  "Time Series": "Step 4 · Model risk: time-series models",
  Stochastic: "Step 4 · Model risk: Monte Carlo and stochastic models",
  Factors: "Factor models: CAPM, Fama-French, Carhart, APT",
  Timing: "Step 5 · Time entry with momentum and technicals",
  "Machine Learning": "Machine learning, validated out of sample",
  Workflow: "Step 6 · Backtest properly, then combine",
};

const label = (text: ReactNode) => (
  <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--ink-3)", margin: "16px 0 8px" }}>
    {text}
  </div>
);

// ── Pieces ───────────────────────────────────────────────────────────────────

function ScoreBar({ score }: { score: number | null }) {
  const w = score == null ? 0 : Math.min(50, (Math.abs(score) / 100) * 50);
  return (
    <div className="q-bar" aria-hidden>
      <span className="q-bar-mid" />
      {score != null && (
        <i style={{ width: `${w}%`, left: score >= 0 ? "50%" : `${50 - w}%`, background: toneOf(score) }} />
      )}
    </div>
  );
}

function AgentCard({ spec, report, pendingNote }: { spec: AgentSpec; report?: QuantReport; pendingNote: string }) {
  const p = report ? parsePayload(report) : null;
  const ev = p?.evidence ?? null;
  const method = p?.method ?? null;
  const llm = spec.kind === "llm";
  return (
    <div className={"q-card" + (report ? "" : " pending")} title={spec.does}>
      <div className="q-card-head">
        <span className="q-name">{spec.name}</span>
        <span className="q-kind" style={{ color: llm ? "var(--md-accent)" : "var(--cyan)" }}>
          {llm ? (method?.replace(/^LLM \((.*)\)$/, "LLM · $1") ?? "LLM") : "code"}
        </span>
        <span className="q-score" style={{ color: toneOf(report?.score ?? null) }}>
          {report ? (report.score == null ? "no view" : signed(report.score)) : "—"}
        </span>
      </div>
      <ScoreBar score={report?.score ?? null} />
      <div className="q-summary">{report ? report.summary : pendingNote}</div>
      {report && (ev || (method && !llm)) && (
        <div className="q-foot">
          {ev && (
            <span style={{ color: ev.passed ? "var(--green)" : "var(--ink-3)" }}>
              {ev.passed ? "✓ validated" : "✗ not validated"} · {ev.test} · t {ev.t.toFixed(2)}
            </span>
          )}
          {!ev && method && !llm && <span>{method}</span>}
        </div>
      )}
      {report && p?.data != null && (
        <details className="q-data">
          <summary>data</summary>
          <pre>{JSON.stringify(p.data, null, 1)}</pre>
        </details>
      )}
    </div>
  );
}

function Verdict({ ens, head, now }: { ens: EnsembleView | null; head: Head | null; now: number }) {
  if (!head) return <div className="q-empty">Select a name.</div>;
  if (head.status === "stopped") {
    return (
      <div className="q-empty" style={{ color: "var(--red)" }}>
        The fundamentals screener failed this name (two or more red flags on most of the data), so the desk stopped
        before valuation and no memo was written. See the Screen stage for the flags.
      </div>
    );
  }
  if (!ens) {
    return <div className="q-empty">{head.status === "running" ? "Agents are still reporting…" : "This cycle did not reach the ensemble."}</div>;
  }
  const voting = ens.inputs.filter((c) => c.score != null && c.weight > 0);
  const maxAbs = Math.max(1, ...voting.map((c) => Math.abs(c.contribution)));
  const validatedPct = ens.totalWeight ? (100 * (ens.validatedWeight ?? 0)) / ens.totalWeight : null;
  return (
    <div style={{ padding: "14px 16px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
        <span style={{ fontFamily: "var(--serif)", fontSize: 44, lineHeight: 1, color: toneOf(ens.composite) }}>{signed(ens.composite)}</span>
        <Tag tone={ens.direction === "long" ? "green" : ens.direction === "short" ? "red" : undefined}>{ens.direction}</Tag>
        <span style={{ marginLeft: "auto", fontFamily: "var(--mono)", fontSize: 10, color: "var(--ink-3)" }}>{fmtAgo(head.lastAt, now)} ago</span>
      </div>
      <div className="q-stats">
        <span>confidence</span><b>{ens.confidence?.toFixed(2) ?? "—"}</b>
        <span>agreement</span><b>{ens.agreement?.toFixed(2) ?? "—"}</b>
        <span>validated weight</span><b>{validatedPct != null ? `${validatedPct.toFixed(0)}%` : "—"}</b>
        <span>voting agents</span><b>{voting.length}</b>
      </div>

      {label("Fair value (DCF · DDM · residual income · multiples)")}
      {ens.blend ? (
        <div className="q-stats">
          <span>band</span><b>{money(ens.blend.low, ens.currency)} – {money(ens.blend.high, ens.currency)}</b>
          <span>price</span><b>{ens.price != null ? money(ens.price, ens.currency) : "—"}</b>
          <span>upside</span><b style={{ color: toneOf(ens.blend.upsidePct * 3) }}>{signed(ens.blend.upsidePct, 1)}%</b>
          <span>verdict</span><b><Tag tone={ens.blend.verdict === "cheap" ? "green" : ens.blend.verdict === "rich" ? "red" : undefined}>{ens.blend.verdict}</Tag></b>
          <span>method</span><b>{ens.blend.method}</b>
        </div>
      ) : (
        <div className="q-note">No blended band on this report: no model applied, or the run predates the band being stored.</div>
      )}

      {ens.dailyVar && (
        <>
          {label("Risk")}
          <div className="q-stats">
            <span>1-day VaR 95%</span><b>{(ens.dailyVar.value * 100).toFixed(2)}% of price</b>
            <span>source</span><b>{ens.dailyVar.source}</b>
          </div>
        </>
      )}

      {label("What moved the composite")}
      {voting.slice(0, 10).map((c) => (
        <div key={c.agent} className="q-contrib" title={c.basis}>
          <span className="q-contrib-name">{c.validated ? "✓ " : ""}{c.label}</span>
          <div className="q-bar small">
            <span className="q-bar-mid" />
            <i style={{
              width: `${(Math.abs(c.contribution) / maxAbs) * 50}%`,
              left: c.contribution >= 0 ? "50%" : `${50 - (Math.abs(c.contribution) / maxAbs) * 50}%`,
              background: toneOf(c.contribution * 5),
            }} />
          </div>
          <span className="q-contrib-v">{signed(c.contribution, 1)}</span>
        </div>
      ))}
      <div className="q-note">
        ✓ = passed its own out-of-sample test and is weighted by that evidence. The rest carry small fixed priors, counted at
        half weight toward confidence.
      </div>
      {ens.notes.length > 0 && (
        <>
          {label("Notes")}
          {ens.notes.map((n, i) => <div key={i} className="q-note">{n}</div>)}
        </>
      )}

      {label("Reality check")}
      <div className="q-note">
        Short-term prices are close to random and no model predicts them reliably. These agents estimate value, ranges and
        probabilities; the edge comes from combining them, weighted by evidence that held up out of sample.
      </div>
    </div>
  );
}

// ── Screen ───────────────────────────────────────────────────────────────────

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

export function QuantScreen() {
  return <QuantView {...useQuantDesk()} />;
}

/** The screen's render, kept free of data loading. */
export function QuantView({ market, loaded, list, head, byAgent, now, onSelect }: {
  market: Market;
  loaded: boolean;
  list: Head[];
  head: Head | null;
  byAgent: Map<string, QuantReport>;
  now: number;
  onSelect: (ticker: string) => void;
}) {
  const ens = ensembleView(byAgent.get("ensemble-combiner"));
  const pendingNote = head?.status === "running" ? "waiting…" : head?.status === "stopped" ? "not run: the screen stopped this cycle" : "no report this cycle";

  return (
    <div className="quant">
      <Panel title="Measured names" meta={loaded ? `${list.length} · ${market === "IN" ? "India" : "US"}` : "loading…"} bodyClassName="tight">
        {loaded && list.length === 0 && (
          <div className="q-empty">
            No quant runs on this desk yet. The quant desk measures every name the desk loop analyses, right after the
            filing is parsed, so reports appear here on the loop&apos;s next cycle with a new disclosure.
          </div>
        )}
        {list.map((h) => (
          <div key={h.ticker} className={"doc " + (h.ticker === head?.ticker ? "sel" : "")} onClick={() => onSelect(h.ticker)}>
            <div className="row">
              <span className="src"><Tag tone={STATUS_TAG[h.status].tone}>{STATUS_TAG[h.status].label}</Tag></span>
              <span className="tk mono">{h.ticker}</span>
            </div>
            <div className="row" style={{ fontFamily: "var(--mono)", fontSize: 10.5 }}>
              <span style={{ color: toneOf(h.composite) }}>
                {h.composite != null ? `composite ${signed(h.composite)} · ${h.direction ?? ""}` : "no composite"}
              </span>
              <span style={{ marginLeft: "auto", color: "var(--ink-3)" }}>{fmtAgo(h.lastAt, now)}</span>
            </div>
          </div>
        ))}
      </Panel>

      <Panel
        title={head ? `${head.ticker} · quant desk` : "Quant desk"}
        meta={head ? `${byAgent.size}/${QUANT_AGENTS.length} agents reported` : `${QUANT_AGENTS.length} agents`}
      >
        {STAGES.map((stage) => {
          const specs = QUANT_AGENTS.filter((a) => a.stage === stage);
          return (
            <section key={stage} style={{ marginBottom: 18 }}>
              <div className="q-stage">
                <span>{stage}</span>
                <span className="q-stage-note">{STAGE_NOTE[stage]}</span>
              </div>
              <div className="q-grid">
                {specs.map((spec) => (
                  <AgentCard key={spec.slug} spec={spec} report={head ? byAgent.get(spec.slug) : undefined} pendingNote={head ? pendingNote : spec.does} />
                ))}
              </div>
            </section>
          );
        })}
      </Panel>

      <Panel title="Ensemble verdict" meta={head?.cycleId ?? ""} bodyClassName="tight">
        <Verdict ens={ens} head={head} now={now} />
      </Panel>
    </div>
  );
}
