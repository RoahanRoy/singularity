"use client";

import { useEffect, useState } from "react";
import { Panel, Tag } from "../primitives";
import { useMarket } from "../MarketContext";
import { listFilings, subscribeFilings, getTopMemo, listMemosByFiling, listPositions } from "@/lib/appwrite/queries";
import type { Filing, Memo, MemoEntity } from "@/lib/appwrite/schema";
import type { Market } from "@/lib/meridian/format";

const FALLBACK_ENTITIES_US: MemoEntity[] = [
  { name: "Taiwan Semiconductor (TSM)", role: "subject",    weight: 1.0  },
  { name: "Apple (AAPL)",               role: "customer",   weight: 0.78 },
  { name: "NVIDIA (NVDA)",              role: "customer",   weight: 0.74 },
  { name: "ASML Holding (ASML)",        role: "supplier",   weight: 0.63 },
  { name: "Samsung Foundry",            role: "competitor", weight: 0.55 },
  { name: "Intel Foundry",              role: "competitor", weight: 0.44 },
  { name: "Mediatek (2454.TW)",         role: "peer",       weight: 0.41 },
  { name: "Sumco Corporation",          role: "input",      weight: 0.33 },
];

const FALLBACK_ENTITIES_IN: MemoEntity[] = [
  { name: "Reliance Industries (RELIANCE)", role: "subject",    weight: 1.0  },
  { name: "Jio Platforms",                  role: "subject",    weight: 0.82 },
  { name: "Reliance Retail",                role: "subject",    weight: 0.71 },
  { name: "BPCL / HPCL",                    role: "peer",       weight: 0.58 },
  { name: "TCS (TCS.NS)",                   role: "peer",       weight: 0.46 },
  { name: "Bharti Airtel (BHARTIARTL)",     role: "competitor", weight: 0.62 },
  { name: "Saudi Aramco",                   role: "input",      weight: 0.44 },
  { name: "RBI · MPC stance",               role: "input",      weight: 0.39 },
];

function parseEntities(raw: string | null | undefined): MemoEntity[] | null {
  if (!raw) return null;
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return null;
    const clean = arr
      .filter((e): e is MemoEntity =>
        e && typeof e.name === "string" && typeof e.role === "string" && typeof e.weight === "number"
      )
      .map((e) => ({ ...e, weight: Math.max(0, Math.min(1, e.weight)) }));
    return clean.length ? clean : null;
  } catch {
    return null;
  }
}

type Doc = { id: string; src: string; tk: string; ttl: string; when: string; held?: boolean };

const FALLBACK_DOCS_US: Doc[] = [
  { id: "f-0", src: "10-K",          tk: "NVDA", ttl: "Annual Report — segment commentary on China-restricted SKUs and supply mix.", when: "0.4s" },
  { id: "f-1", src: "EARNINGS CALL", tk: "TSM",  ttl: "Q4 2025 transcript — capex language softens; mgmt deflects two questions on inventory.", when: "12s" },
  { id: "f-2", src: "8-K",           tk: "AVGO", ttl: "Executive departure disclosure — CFO transition, no successor named.", when: "1m 4s" },
  { id: "f-3", src: "13F",           tk: "BX",   ttl: "Reported holdings reveal -$340M reduction in semiconductor names.", when: "3m 12s" },
  { id: "f-4", src: "S-1",           tk: "—",    ttl: "Newly filed: vertical-AI infra company, lead investors include sovereign vehicle.", when: "8m" },
];

const FALLBACK_DOCS_IN: Doc[] = [
  { id: "in-0", src: "Q-Results",   tk: "HDFCBANK", ttl: "Q4 FY26 results — NIM 3.52%, deposit-cost glide flagged, credit cost stable.", when: "0.6s" },
  { id: "in-1", src: "Bd-Meeting",  tk: "RELIANCE", ttl: "Outcome of Board Meeting — interim dividend declared, capex framework reaffirmed.", when: "18s" },
  { id: "in-2", src: "Press-Rel",   tk: "INFY",     ttl: "Large-deal TCV softens; FY27 revenue band guided in CC at 1.5–3.5%.", when: "2m 4s" },
  { id: "in-3", src: "PIT-Discl",   tk: "ICICIBANK", ttl: "Insider trading disclosure — designated person window-trade, 0.001% of float.", when: "4m 22s" },
  { id: "in-4", src: "Shareholding", tk: "ITC",     ttl: "Quarterly shareholding pattern — FII +18bps, BAT stake unchanged at 25.0%.", when: "11m" },
];

function fmtAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return s.toFixed(1) + "s";
  if (s < 3600) return Math.floor(s / 60) + "m " + Math.floor(s % 60) + "s";
  return Math.floor(s / 3600) + "h";
}

function summarizeSource(src: string): { primary: string; secondary: string | null } {
  try {
    const u = new URL(src);
    const segs = u.pathname.split("/").filter(Boolean);
    const tail = segs[segs.length - 1] ?? u.pathname;
    const host = u.hostname.replace(/^www\./, "");
    return { primary: tail.replace(/\.(htm|html|pdf|txt|xml|json)$/i, ""), secondary: host };
  } catch {
    return { primary: src, secondary: null };
  }
}

function filingToDoc(f: Filing): Doc {
  return {
    id: f.$id,
    src: f.form_type,
    tk: f.ticker,
    ttl: f.source_url,
    when: fmtAgo(f.$createdAt),
  };
}

function DocList({
  docs,
  selected,
  setSel,
}: {
  docs: Doc[];
  selected: string | null;
  setSel: (id: string) => void;
}) {
  return (
    <div>
      {docs.map((d) => {
        const s = summarizeSource(d.ttl);
        return (
          <div key={d.id} className={"doc " + (d.id === selected ? "sel" : "")} onClick={() => setSel(d.id)}>
            <div className="row">
              <span className="src">{d.src}</span>
              <span className="tk mono">
                {d.tk}
                {d.held && (
                  <span
                    style={{
                      marginLeft: 6,
                      color: "var(--md-accent)",
                      fontSize: 9,
                      letterSpacing: "0.14em",
                    }}
                    title="On the book"
                  >
                    ● HELD
                  </span>
                )}
              </span>
            </div>
            <div className="ttl mono" title={d.ttl}>{s.primary}</div>
            <div className="when">
              ingested {d.when} ago{s.secondary ? ` · ${s.secondary}` : ""}
            </div>
          </div>
        );
      })}
    </div>
  );
}

const STATUS_TONE: Record<Filing["status"], string> = {
  queued: "var(--ink-3)",
  parsing: "var(--md-accent)",
  indexed: "var(--cyan)",
  failed: "var(--red)",
};

function FilingDetail({ filing }: { filing: Filing }) {
  const [memos, setMemos] = useState<Memo[] | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    listMemosByFiling(filing.$id)
      .then((rows) => {
        if (cancelled) return;
        setMemos(rows);
        setLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setMemos([]);
        setLoaded(true);
      });
    return () => { cancelled = true; };
  }, [filing.$id]);

  const parsed = (() => {
    try { return new URL(filing.source_url); } catch { return null; }
  })();
  const tone = STATUS_TONE[filing.status] ?? "var(--ink-3)";

  return (
    <div style={{ padding: "22px 26px", maxWidth: 760, fontFamily: "var(--serif)", color: "var(--ink-1)", fontSize: 14, lineHeight: 1.6 }}>
      <div style={{ fontFamily: "var(--mono)", fontSize: 10, letterSpacing: "0.16em", textTransform: "uppercase", color: "var(--ink-3)", marginBottom: 8, display: "flex", gap: 10, alignItems: "center" }}>
        <span>{filing.form_type} · {filing.ticker} · filed {fmtAgo(filing.filed_at)} ago · ingested {fmtAgo(filing.$createdAt)} ago</span>
        <span style={{ color: tone, border: `1px solid ${tone}`, padding: "1px 6px", letterSpacing: "0.14em" }}>
          {filing.status}
        </span>
      </div>
      <h3 style={{ fontFamily: "var(--serif)", fontWeight: 500, fontSize: 18, margin: "0 0 12px", color: "var(--ink-0)" }}>
        {filing.ticker} — {filing.form_type}
      </h3>
      <div style={{ display: "grid", gridTemplateColumns: "120px 1fr", gap: "6px 16px", fontFamily: "var(--mono)", fontSize: 11.5, marginBottom: 18 }}>
        <span style={{ color: "var(--ink-3)" }}>Source</span>
        <a href={filing.source_url} target="_blank" rel="noreferrer" style={{ color: "var(--cyan)", wordBreak: "break-all" }}>{filing.source_url}</a>
        {parsed && (
          <>
            <span style={{ color: "var(--ink-3)" }}>Host</span>
            <span style={{ color: "var(--ink-1)" }}>{parsed.hostname.replace(/^www\./, "")}</span>
          </>
        )}
        <span style={{ color: "var(--ink-3)" }}>Filing ID</span>
        <span style={{ color: "var(--ink-4)" }}>{filing.$id}</span>
      </div>

      <div style={{ fontFamily: "var(--mono)", fontSize: 10, letterSpacing: "0.16em", textTransform: "uppercase", color: "var(--ink-3)", margin: "20px 0 10px" }}>
        Memos from this filing {loaded && memos ? `(${memos.length})` : ""}
      </div>

      {!loaded && (
        <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--ink-4)" }}>loading…</div>
      )}

      {loaded && memos && memos.length === 0 && (
        <div style={{ border: "1px dashed var(--line)", padding: "14px 16px", fontFamily: "var(--mono)", fontSize: 11, color: "var(--ink-3)", lineHeight: 1.55 }}>
          <div style={{ color: "var(--md-accent)", letterSpacing: "0.14em", textTransform: "uppercase", fontSize: 9.5, marginBottom: 6 }}>
            No memos linked yet
          </div>
          {filing.status === "indexed"
            ? "Filing is indexed but no analyst memo references it. Older memos may pre-date the filing_id link — re-run the analyst to backfill."
            : `Filing status is "${filing.status}". The analyst pipeline will produce a memo once parsing completes.`}
        </div>
      )}

      {loaded && memos && memos.map((m) => (
        <div key={m.$id} style={{ border: "1px solid var(--line)", background: "var(--bg-2)", padding: "12px 14px", marginBottom: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
            <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--md-accent)" }}>
              {m.status} memo
            </span>
            <span style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--ink-1)" }}>
              conv {m.conviction.toFixed(2)}
            </span>
          </div>
          <h4 style={{ fontFamily: "var(--serif)", fontWeight: 500, fontSize: 14.5, margin: "6px 0 6px", color: "var(--ink-0)" }}>
            {m.title}
          </h4>
          <p style={{ fontFamily: "var(--serif)", fontSize: 13, lineHeight: 1.55, color: "var(--ink-1)", margin: 0 }}>
            {m.thesis}
          </p>
        </div>
      ))}
    </div>
  );
}

function TranscriptViewUS() {
  return (
    <div className="transcript-grid">
      <div className="transcript">
        <div className="t-row">
          <div className="t-main">
            <div className="speaker">CFO · prepared remarks · 14:22 elapsed</div>
            <p>
              We continue to see <mark>solid demand</mark> across high-performance compute, with N-3 utilization remaining near
              historical peaks. However, our customers in the AI-accelerator segment are{" "}
              <mark className="cyan">re-pacing certain orders</mark> as they reconcile build schedules with downstream platform
              readiness. We view this as a timing matter, not a demand matter.
            </p>
          </div>
          <aside className="t-gutter">
            <div className="callout inline">
              <span className="lbl">Forensic · earnings/4f-118</span>
              <div>
                Phrase <span className="amber">&quot;solid demand&quot;</span> appears 14× this call vs. mean 4.1×. Hedging
                detected vs. last 8 prints. Confidence <b>0.82</b>.
              </div>
            </div>
          </aside>
        </div>

        <div className="t-row">
          <div className="t-main">
            <div className="speaker">Analyst — Morgan Stanley</div>
            <p>
              Could you help us understand the magnitude of that re-pacing? Specifically, is this concentrated in any
              customer or geography, and how should we think about Q1?
            </p>
          </div>
          <aside className="t-gutter" />
        </div>

        <div className="t-row">
          <div className="t-main">
            <div className="speaker">CFO</div>
            <p>
              We are <mark className="red">not in a position to disaggregate that today.</mark> What I can say is that the
              overall picture for the year remains consistent with the framework we shared in October. We expect{" "}
              <mark>capital expenditures in 2026 to be roughly in line with 2025</mark>, with some flex around equipment
              delivery timing.
            </p>
          </div>
          <aside className="t-gutter">
            <div className="callout inline">
              <span className="lbl">Tone delta · vs. Q2 2025</span>
              <div>
                Management certainty score <span className="amber">−0.31σ</span>. Two question deflections logged. Cross-ref
                TSM, ASML supply commentary.
              </div>
            </div>
          </aside>
        </div>

        <div className="t-row">
          <div className="t-main">
            <div className="speaker">CEO</div>
            <p>
              I want to add — we are extremely confident in the long-term trajectory. The conversations we are having
              with our largest customers are <mark className="cyan">as constructive as they have ever been.</mark>
            </p>
          </div>
          <aside className="t-gutter">
            <div className="callout inline">
              <span className="lbl">Trade thesis · auto-generated</span>
              <div>
                Pair: long <span className="amber">SOXX</span> / short <span className="amber">TSM 1M ATM call spread</span>.
                Sized 0.4% NAV. Awaits PM review.
              </div>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}

function TranscriptViewIN() {
  return (
    <div className="transcript-grid">
      <div className="transcript">
        <div className="t-row">
          <div className="t-main">
            <div className="speaker">CFO · HDFCBANK · Q4 FY26 earnings call · prepared remarks</div>
            <p>
              Net interest margin came in at <mark>3.52%</mark> for the quarter, broadly in line with our glide path.
              Deposit accretion remained <mark className="cyan">healthy at ₹1.42 lakh crore</mark>, and we continue to see
              the merged book&apos;s cost of funds normalise quarter on quarter. Credit cost was stable at 41 bps.
            </p>
          </div>
          <aside className="t-gutter">
            <div className="callout inline">
              <span className="lbl">Forensic · earnings/in-22</span>
              <div>
                Use of <span className="amber">&quot;broadly in line&quot;</span> 6× this call vs. mean 1.8×. Hedge
                pattern matches Q3 FY26 deposit-rate guidance. Confidence <b>0.79</b>.
              </div>
            </div>
          </aside>
        </div>

        <div className="t-row">
          <div className="t-main">
            <div className="speaker">Analyst — Kotak Institutional</div>
            <p>
              Could you quantify the impact of the latest <mark>RBI liquidity withdrawal</mark> on your deposit-cost glide
              over H1 FY27, and how should we think about NIM trajectory if the MPC stays on hold?
            </p>
          </div>
          <aside className="t-gutter" />
        </div>

        <div className="t-row">
          <div className="t-main">
            <div className="speaker">CFO</div>
            <p>
              We are <mark className="red">not in a position to put a precise number on it today.</mark> Directionally,
              we expect NIM to remain in the <mark>3.45–3.55%</mark> band through H1, with some sensitivity to the
              external benchmark repo if RBI moves. The retail book continues to re-price faster than the corporate book.
            </p>
          </div>
          <aside className="t-gutter">
            <div className="callout inline">
              <span className="lbl">Tone delta · vs. Q3 FY26</span>
              <div>
                Management certainty score <span className="amber">−0.18σ</span>. One deflection logged on MPC
                sensitivity. Cross-ref ICICIBANK, AXISBANK NIM commentary.
              </div>
            </div>
          </aside>
        </div>

        <div className="t-row">
          <div className="t-main">
            <div className="speaker">MD &amp; CEO</div>
            <p>
              I want to add — our <mark className="cyan">unsecured retail book quality remains the best in the system</mark>,
              and we are not seeing any of the stress that has been reported elsewhere in fintech-led personal loans.
            </p>
          </div>
          <aside className="t-gutter">
            <div className="callout inline">
              <span className="lbl">Trade thesis · auto-generated</span>
              <div>
                Pair: long <span className="amber">HDFCBANK</span> / short <span className="amber">BANKNIFTY 1M
                ATM call spread</span>. Sized 0.3% NAV. Awaits PM review.
              </div>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}

function TranscriptView({ market }: { market: Market }) {
  return market === "IN" ? <TranscriptViewIN /> : <TranscriptViewUS />;
}

function EntityPanel({ market }: { market: Market }) {
  const [memo, setMemo] = useState<Memo | null>(null);
  useEffect(() => {
    let cancelled = false;
    setMemo(null);
    getTopMemo(market)
      .then((m) => {
        if (!cancelled) setMemo(m);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [market]);

  const fallbackTitle = market === "IN"
    ? "RELIANCE — Q4 print, retail margin mix improving"
    : "TSM — Q4 print, demand softness signal";
  const fallbackThesis = market === "IN"
    ? "Three India-desk agents converged on a constructive read of Reliance Retail margin commentary, supported by Jio ARPU stability and easing O2C spreads. Suggested expression: long RELIANCE vs. short NIFTY 1M call spread. Risk-managed via INDIAVIX overlay."
    : "Three independent agents converged on a softening-demand interpretation of management's tone, supported by alt-data divergence in NA capex shipments and a thinning options skew on TSM 1M. Suggested expression: long SOXX vs. short TSM call spread. Risk-managed via VIX overlay.";
  const fallbackEntities = market === "IN" ? FALLBACK_ENTITIES_IN : FALLBACK_ENTITIES_US;

  const title = memo?.title ?? fallbackTitle;
  const conv = memo?.conviction ?? 0.74;
  const thesis = memo?.thesis ?? fallbackThesis;

  const pendingV = { color: "var(--ink-4)" } as const;
  const pendingHint = { color: "var(--ink-4)", fontSize: 9.5, marginLeft: 4 } as const;

  return (
    <div>
      <div className="memo">
        <Tag tone="amber">{memo ? `${memo.status.toUpperCase()} MEMO` : "DRAFT MEMO · v3"}</Tag>
        <h4 style={{ marginTop: 6 }}>{title}</h4>
        <div className="ks">
          <span className="k">Conviction</span><span className="v">{conv.toFixed(2)}</span>
          <span className="k">Horizon</span><span className="v" style={pendingV}>—<span style={pendingHint}>pending</span></span>
          <span className="k">Size (NAV)</span><span className="v" style={pendingV}>—<span style={pendingHint}>pending</span></span>
          <span className="k">Sharpe (est.)</span><span className="v" style={pendingV}>—<span style={pendingHint}>pending</span></span>
        </div>
        <p>{thesis}</p>
      </div>

      <div
        style={{
          padding: "6px 12px",
          fontFamily: "var(--mono)",
          fontSize: 10,
          color: "var(--ink-3)",
          letterSpacing: "0.16em",
          textTransform: "uppercase",
          display: "flex",
          justifyContent: "space-between",
        }}
      >
        <span>Entity Graph</span>
        <span style={{ color: "var(--ink-4)" }}>
          {parseEntities(memo?.entities_json) ? "from memo" : "sample"}
        </span>
      </div>
      {(parseEntities(memo?.entities_json) ?? fallbackEntities).map((e, i) => (
        <div key={i} className="entity">
          <div className="name">{e.name}</div>
          <div className="row">
            <span style={{ textTransform: "uppercase", letterSpacing: "0.12em" }}>{e.role}</span>
            <div className="bar"><i style={{ width: e.weight * 100 + "%" }} /></div>
            <span style={{ color: "var(--ink-1)" }}>{e.weight.toFixed(2)}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

export function ResearchScreen() {
  const { market } = useMarket();
  const [filings, setFilings] = useState<Filing[]>([]);
  const [heldTickers, setHeldTickers] = useState<Set<string>>(new Set());
  const [sel, setSel] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setFilings([]);
    setHeldTickers(new Set());
    setSel(null);
    listFilings(12, market)
      .then((rows) => {
        if (cancelled) return;
        setFilings(rows);
      })
      .catch(() => {});
    listPositions(200, market)
      .then((rows) => {
        if (cancelled) return;
        setHeldTickers(new Set(rows.map((p) => p.ticker.toUpperCase())));
      })
      .catch(() => {});
    const unsub = subscribeFilings((f) => {
      if (cancelled) return;
      setFilings((prev) => [f, ...prev.filter((p) => p.$id !== f.$id)].slice(0, 12));
    }, market);
    return () => {
      cancelled = true;
      unsub();
    };
  }, [market]);

  const fallbackDocs = market === "IN" ? FALLBACK_DOCS_IN : FALLBACK_DOCS_US;
  const liveDocs: Doc[] = filings.map((f) => ({
    ...filingToDoc(f),
    held: heldTickers.has(f.ticker.toUpperCase()),
  }));
  // Stable sort: held filings float to the top, original recency order preserved within each group.
  liveDocs.sort((a, b) => Number(!!b.held) - Number(!!a.held));
  const docs: Doc[] = liveDocs.length ? liveDocs : fallbackDocs;
  const heldCount = liveDocs.filter((d) => d.held).length;

  const selectedId = sel ?? docs[1]?.id ?? docs[0]?.id ?? null;
  const selectedDoc = docs.find((d) => d.id === selectedId) ?? null;
  const selectedFiling = selectedDoc ? filings.find((f) => f.$id === selectedDoc.id) ?? null : null;
  const isFallback = !selectedFiling;

  const fallbackHeadTitle = market === "IN"
    ? "HDFCBANK · Q4 FY26 Earnings Call · Reasoning Overlay"
    : "TSM · Q4 2025 Earnings Call · Reasoning Overlay";

  const headTitle = selectedFiling
    ? `${selectedFiling.ticker} · ${selectedFiling.form_type}`
    : fallbackHeadTitle;
  const headMeta = selectedFiling
    ? `status: ${selectedFiling.status}`
    : "3 agents synthesizing · 0.74 conv.";

  return (
    <div className="research">
      <Panel
        title="Ingest Queue"
        meta={
          liveDocs.length
            ? `${liveDocs.length} loaded · ${heldCount} on book`
            : `${fallbackDocs.length} loaded`
        }
        bodyClassName="tight"
      >
        <DocList docs={docs} selected={selectedId} setSel={setSel} />
      </Panel>

      <div className="panel" style={{ borderTop: 0, borderBottom: 0 }}>
        <div className="panel-head">
          <span className="title">{headTitle}</span>
          <span className="meta">{headMeta}</span>
        </div>
        <div className="panel-body" style={{ position: "relative" }}>
          {isFallback || !selectedFiling ? <TranscriptView market={market} /> : <FilingDetail filing={selectedFiling} />}
        </div>
      </div>

      <Panel title="Synthesis" meta="auto" bodyClassName="tight">
        <EntityPanel market={market} />
      </Panel>
    </div>
  );
}
