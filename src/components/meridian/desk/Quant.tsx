"use client";

import { useDesk } from "../Shell";
import { ensembleView, parsePayload, useQuantDesk, type EnsembleView, type Head, type Status } from "../screens/Quant";
import type { QuantReport } from "@/lib/appwrite/schema";
import { QUANT_AGENTS, STAGES, type Stage } from "@/lib/quant/roster";

/**
 * The quant desk on the v2 layout: measured names, every agent's report for
 * the selected name's newest cycle by stage, and the ensemble verdict. Data
 * and parsing are shared with the legacy screen (screens/Quant.tsx).
 */

const STATUS: Record<Status, [string, string]> = {
  done: ["done", "up"],
  stopped: ["screen fail", "down"],
  running: ["running", "warn"],
  incomplete: ["partial", ""],
};

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

const signed = (n: number, dp = 0) => `${n > 0 ? "+" : ""}${n.toFixed(dp)}`;
const tone = (s: number | null) => (s == null ? "var(--ink-3)" : s >= 15 ? "var(--up)" : s <= -15 ? "var(--down)" : "var(--ink-2)");
const dirTag = (d: string | null) => (d === "long" ? "up" : d === "short" ? "down" : "");
const money = (n: number, ccy: string | null) =>
  `${ccy === "INR" ? "₹" : ccy === "USD" || !ccy ? "$" : `${ccy} `}${n.toLocaleString(ccy === "INR" ? "en-IN" : "en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function short(iso: string, now: number): string {
  const s = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** A centred bar: positive grows right of the midline, negative left. */
function CBar({ v, scale, color }: { v: number | null; scale: number; color: string }) {
  const w = v == null ? 0 : Math.min(50, (Math.abs(v) / scale) * 50);
  return (
    <span className="m-cbar" style={{ display: "block", height: 4 }} aria-hidden>
      {v != null && <i style={{ left: v < 0 ? `${50 - w}%` : "50%", width: `${w}%`, background: color }} />}
    </span>
  );
}

function AgentCard({ name, llm, report, pending }: { name: string; llm: boolean; report?: QuantReport; pending: string }) {
  const p = report ? parsePayload(report) : null;
  const ev = p?.evidence ?? null;
  const method = p?.method ?? null;
  const score = report?.score ?? null;
  return (
    <div className="m-card" style={{ padding: "12px 14px", opacity: report ? 1 : 0.55, display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 600, minWidth: 0 }}>{name}</span>
        <span className="m-mono m-ink3" style={{ fontSize: 10 }}>
          {llm ? (method?.replace(/^LLM \((.*)\)$/, "LLM · $1") ?? "LLM") : "code"}
        </span>
        <span style={{ marginLeft: "auto", fontSize: 14, fontWeight: 600, fontVariantNumeric: "tabular-nums", color: tone(score), whiteSpace: "nowrap" }}>
          {report ? (score == null ? "no view" : signed(score)) : "—"}
        </span>
      </div>
      <CBar v={report ? score : null} scale={100} color={tone(score)} />
      <div className="m-ink2" style={{ fontSize: 12.5, lineHeight: 1.45, textWrap: "pretty" }}>
        {report ? report.summary : pending}
      </div>
      {report && ev && (
        <div className="m-mono" style={{ fontSize: 11, color: ev.passed ? "var(--up)" : "var(--ink-3)" }}>
          {ev.passed ? "✓ validated" : "✗ not validated"} · {ev.test} · t {ev.t.toFixed(2)}
        </div>
      )}
      {report && !ev && method && !llm && (
        <div className="m-mono m-ink3" style={{ fontSize: 11 }}>
          {method}
        </div>
      )}
    </div>
  );
}

function Verdict({ ens, head, now }: { ens: EnsembleView | null; head: Head | null; now: number }) {
  if (!head) return <p className="m-sub" style={{ marginTop: 10 }}>Select a name.</p>;
  if (!ens)
    return (
      <p style={{ margin: "10px 0 0", fontSize: 13, lineHeight: 1.55, color: head.status === "stopped" ? "var(--down)" : "var(--ink-2)", textWrap: "pretty" }}>
        {head.status === "stopped"
          ? "The fundamentals screener failed this name (two or more red flags on most of the data), so the desk stopped before valuation and no memo was written. See the Screen stage for the flags."
          : head.status === "running"
            ? "Agents are still reporting…"
            : "This cycle did not reach the ensemble."}
      </p>
    );

  const voting = ens.inputs.filter((c) => c.score != null && c.weight > 0);
  const top = [...voting].sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution)).slice(0, 8);
  const maxAbs = Math.max(1e-9, ...voting.map((c) => Math.abs(c.contribution)));
  const validatedPct = ens.totalWeight ? (100 * (ens.validatedWeight ?? 0)) / ens.totalWeight : null;
  const stats: [string, string][] = [
    ["Confidence", ens.confidence?.toFixed(2) ?? "—"],
    ["Agreement", ens.agreement?.toFixed(2) ?? "—"],
    ["Validated weight", validatedPct != null ? `${validatedPct.toFixed(0)}%` : "—"],
    ["Voting agents", String(voting.length)],
  ];
  const b = ens.blend;
  const fair: [string, string, string?][] = b
    ? [
        ["Band", `${money(b.low, ens.currency)} – ${money(b.high, ens.currency)}`],
        ["Price", ens.price != null ? money(ens.price, ens.currency) : "—"],
        ["Upside", `${signed(b.upsidePct, 1)}%`, tone(b.upsidePct * 3)],
        ["Verdict", b.verdict, b.verdict === "cheap" ? "var(--up)" : b.verdict === "rich" ? "var(--down)" : undefined],
        ...(b.method ? ([["Method", b.method]] as [string, string][]) : []),
      ]
    : [];
  if (ens.dailyVar) fair.push(["1-day VaR 95%", `${(ens.dailyVar.value * 100).toFixed(2)}% of price`]);

  const row = (k: string, v: string, color?: string) => (
    <div key={k} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "8px 0", borderBottom: "1px solid var(--line)", fontSize: 13 }}>
      <span className="m-ink2">{k}</span>
      <span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: color ?? "var(--ink)" }}>{v}</span>
    </div>
  );
  const sub = (t: string) => <div style={{ margin: "20px 0 4px", fontSize: 12, fontWeight: 600, color: "var(--ink-2)" }}>{t}</div>;

  return (
    <>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, margin: "10px 0 12px" }}>
        <span style={{ fontFamily: "var(--m-serif)", fontSize: 52, lineHeight: 1, fontVariantNumeric: "tabular-nums", color: tone(ens.composite) }}>
          {signed(ens.composite)}
        </span>
        <span className={`m-tag ${dirTag(ens.direction)}`}>{ens.direction}</span>
        <span className="m-meta" style={{ marginLeft: "auto" }}>
          {short(head.lastAt, now)} ago
        </span>
      </div>
      {stats.map(([k, v]) => row(k, v))}
      {sub("Fair value · DCF, residual income, multiples")}
      {b ? (
        fair.map(([k, v, c]) => row(k, v, c))
      ) : (
        <>
          <p className="m-sub" style={{ fontSize: 12, margin: "4px 0 0" }}>
            No blended band on this report: no model applied, or the run predates the band being stored.
          </p>
          {fair.map(([k, v, c]) => row(k, v, c))}
        </>
      )}
      {sub("What moved the composite")}
      {top.map((c) => (
        <div
          key={c.agent}
          title={c.basis}
          style={{ display: "grid", gridTemplateColumns: "minmax(0,1.3fr) minmax(50px,1fr) 40px", gap: 10, alignItems: "center", padding: "6px 0", fontSize: 12.5 }}
        >
          <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {c.validated ? "✓ " : ""}
            {c.label}
          </span>
          <CBar v={c.contribution} scale={maxAbs} color={tone(c.contribution * 5)} />
          <span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: tone(c.contribution * 5) }}>{signed(c.contribution, 1)}</span>
        </div>
      ))}
      <p className="m-ink3" style={{ margin: "10px 0 0", fontSize: 12, lineHeight: 1.55 }}>
        ✓ = passed its own out-of-sample test and is weighted by that evidence. The rest carry small fixed priors, counted at half weight toward
        confidence.
      </p>
      {ens.notes.length > 0 && (
        <>
          {sub("Notes")}
          {ens.notes.map((n, i) => (
            <p key={i} className="m-ink3" style={{ margin: "0 0 6px", fontSize: 12, lineHeight: 1.55 }}>
              {n}
            </p>
          ))}
        </>
      )}
    </>
  );
}

export function QuantView() {
  const { full, showFull } = useDesk();
  const { market, loaded, list, head, byAgent, now, onSelect } = useQuantDesk();
  const ens = ensembleView(byAgent.get("ensemble-combiner"));
  const pending = head?.status === "running" ? "waiting…" : head?.status === "stopped" ? "not run: the screen stopped this cycle" : "no report this cycle";

  return (
    <div className="m-split3">
      <div style={{ minWidth: 0 }}>
        <div className="m-shead" style={{ marginBottom: 6 }}>
          <h2 className="m-h3">Measured names</h2>
          <span className="m-meta">{loaded ? `${list.length} · ${market === "IN" ? "India" : "US"}` : "Loading…"}</span>
        </div>
        {loaded && list.length === 0 && (
          <p className="m-empty">
            No quant runs on this desk yet. The quant desk measures every name the desk loop analyses, right after the filing is parsed, so
            reports appear here on the loop&apos;s next cycle.
          </p>
        )}
        {list.map((h) => {
          const [label, t] = STATUS[h.status];
          return (
            <button key={h.ticker} className="m-pick" aria-current={h.ticker === head?.ticker} onClick={() => onSelect(h.ticker)}>
              <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span style={{ fontSize: 14, fontWeight: 600 }}>{h.ticker}</span>
                <span className={`m-tag ${t}`} style={{ fontSize: 11 }}>
                  {label}
                </span>
                <span className="m-meta" style={{ marginLeft: "auto", fontSize: 11 }}>
                  {short(h.lastAt, now)}
                </span>
              </span>
              <span className="m-mono" style={{ display: "block", fontSize: 12, marginTop: 3, color: tone(h.composite) }}>
                {h.composite != null ? `composite ${signed(h.composite)} · ${h.direction ?? ""}` : "no composite"}
              </span>
            </button>
          );
        })}
      </div>

      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "baseline", gap: 8, marginBottom: 14 }}>
          <h2 className="m-h2" style={{ margin: 0, fontSize: 24 }}>
            {head ? `${head.ticker} · quant desk` : "Quant desk"}
          </h2>
          <span className="m-meta">
            {head ? `${byAgent.size} of ${QUANT_AGENTS.length} agents reported` : `${QUANT_AGENTS.length} agents`}
          </span>
        </div>
        {STAGES.map((stage) => {
          const specs = QUANT_AGENTS.filter((a) => a.stage === stage);
          const reps = head ? specs.map((s) => byAgent.get(s.slug)).filter((r): r is QuantReport => !!r) : [];
          const scored = reps.filter((r) => r.score != null);
          const avg = scored.length ? Math.round(scored.reduce((a, r) => a + (r.score ?? 0), 0) / scored.length) : null;
          return (
            <section key={stage} style={{ marginBottom: 22 }}>
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  alignItems: "baseline",
                  gap: "2px 10px",
                  paddingBottom: 8,
                  marginBottom: full ? 10 : 0,
                  borderBottom: "1px solid var(--line)",
                }}
              >
                <span style={{ fontSize: 14, fontWeight: 600 }}>{stage}</span>
                <span className="m-meta">{STAGE_NOTE[stage]}</span>
                <span className="m-ink2" style={{ marginLeft: "auto", fontSize: 12, fontVariantNumeric: "tabular-nums" }}>
                  {reps.length}/{specs.length} reported{avg != null ? ` · avg ${signed(avg)}` : ""}
                </span>
              </div>
              {full && (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(min(100%,230px),1fr))", gap: 10 }}>
                  {specs.map((s) => (
                    <AgentCard
                      key={s.slug}
                      name={s.name}
                      llm={s.kind === "llm"}
                      report={head ? byAgent.get(s.slug) : undefined}
                      pending={head ? pending : s.does}
                    />
                  ))}
                </div>
              )}
            </section>
          );
        })}
        {!full && (
          <button className="m-link" onClick={showFull} style={{ fontSize: 13 }}>
            Show every agent&apos;s report (Full detail) →
          </button>
        )}
      </div>

      <aside style={{ minWidth: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
          <h2 className="m-h2" style={{ margin: 0, fontSize: 22 }}>
            Ensemble verdict
          </h2>
          <span className="m-mono m-ink3" style={{ fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {head?.cycleId ?? ""}
          </span>
        </div>
        <Verdict ens={ens} head={head} now={now} />
        <p className="m-ink3" style={{ margin: "20px 0 0", paddingTop: 12, borderTop: "1px solid var(--line)", fontSize: 12, lineHeight: 1.55, textWrap: "pretty" }}>
          Short-term prices are close to random and no model predicts them reliably. These agents estimate value, ranges and probabilities; the
          edge comes from combining them, weighted by evidence that held up out of sample.
        </p>
      </aside>
    </div>
  );
}
