"use client";

import { useEffect, useState } from "react";
import { Panel, Tag } from "../primitives";
import { listFilings, subscribeFilings, getTopMemo } from "@/lib/appwrite/queries";
import type { Filing, Memo } from "@/lib/appwrite/schema";

type Doc = { id: string; src: string; tk: string; ttl: string; when: string };

const FALLBACK_DOCS: Doc[] = [
  { id: "f-0", src: "10-K",          tk: "NVDA", ttl: "Annual Report — segment commentary on China-restricted SKUs and supply mix.", when: "0.4s" },
  { id: "f-1", src: "EARNINGS CALL", tk: "TSM",  ttl: "Q4 2025 transcript — capex language softens; mgmt deflects two questions on inventory.", when: "12s" },
  { id: "f-2", src: "8-K",           tk: "AVGO", ttl: "Executive departure disclosure — CFO transition, no successor named.", when: "1m 4s" },
  { id: "f-3", src: "13F",           tk: "BX",   ttl: "Reported holdings reveal -$340M reduction in semiconductor names.", when: "3m 12s" },
  { id: "f-4", src: "S-1",           tk: "—",    ttl: "Newly filed: vertical-AI infra company, lead investors include sovereign vehicle.", when: "8m" },
];

function fmtAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return s.toFixed(1) + "s";
  if (s < 3600) return Math.floor(s / 60) + "m " + Math.floor(s % 60) + "s";
  return Math.floor(s / 3600) + "h";
}

function filingToDoc(f: Filing): Doc {
  return {
    id: f.$id,
    src: f.form_type,
    tk: f.ticker,
    ttl: f.source_url, // seeded as human summary; schema v2 should split this
    when: fmtAgo(f.filed_at),
  };
}

function DocList({ sel, setSel }: { sel: string | null; setSel: (id: string) => void }) {
  const [docs, setDocs] = useState<Doc[]>(FALLBACK_DOCS);

  useEffect(() => {
    let cancelled = false;
    listFilings(12)
      .then((rows) => {
        if (cancelled || rows.length === 0) return;
        setDocs(rows.map(filingToDoc));
      })
      .catch(() => {});
    const unsub = subscribeFilings((f) => {
      if (cancelled) return;
      setDocs((prev) => [filingToDoc(f), ...prev].slice(0, 12));
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  const selected = sel ?? docs[1]?.id ?? docs[0]?.id ?? null;

  return (
    <div>
      {docs.map((d) => (
        <div key={d.id} className={"doc " + (d.id === selected ? "sel" : "")} onClick={() => setSel(d.id)}>
          <div className="row">
            <span className="src">{d.src}</span>
            <span className="tk mono">{d.tk}</span>
          </div>
          <div className="ttl">{d.ttl}</div>
          <div className="when">ingested {d.when} ago</div>
        </div>
      ))}
    </div>
  );
}

function TranscriptView() {
  return (
    <div style={{ position: "relative", padding: "0 0 40px" }}>
      <div className="transcript">
        <div className="speaker">CFO · prepared remarks · 14:22 elapsed</div>
        <p>
          We continue to see <mark>solid demand</mark> across high-performance compute, with N-3 utilization remaining near
          historical peaks. However, our customers in the AI-accelerator segment are{" "}
          <mark className="cyan">re-pacing certain orders</mark> as they reconcile build schedules with downstream platform
          readiness. We view this as a timing matter, not a demand matter.
        </p>

        <div className="speaker">Analyst — Morgan Stanley</div>
        <p>
          Could you help us understand the magnitude of that re-pacing? Specifically, is this concentrated in any
          customer or geography, and how should we think about Q1?
        </p>

        <div className="speaker">CFO</div>
        <p>
          We are <mark className="red">not in a position to disaggregate that today.</mark> What I can say is that the
          overall picture for the year remains consistent with the framework we shared in October. We expect{" "}
          <mark>capital expenditures in 2026 to be roughly in line with 2025</mark>, with some flex around equipment delivery
          timing.
        </p>

        <div className="speaker">CEO</div>
        <p>
          I want to add — we are extremely confident in the long-term trajectory. The conversations we are having with
          our largest customers are <mark className="cyan">as constructive as they have ever been.</mark>
        </p>
      </div>

      <div className="callout" style={{ right: 14, top: 88 }}>
        <span className="lbl">Forensic · earnings/4f-118</span>
        <div>
          Phrase <span className="amber">&quot;solid demand&quot;</span> appears 14× this call vs. mean 4.1×. Hedging detected
          vs. last 8 prints. Confidence <b>0.82</b>.
        </div>
      </div>

      <div className="callout" style={{ right: 14, top: 240 }}>
        <span className="lbl">Tone delta · vs. Q2 2025</span>
        <div>
          Management certainty score <span className="amber">−0.31σ</span>. Two question deflections logged. Cross-ref TSM,
          ASML supply commentary.
        </div>
      </div>

      <div className="callout" style={{ right: 14, top: 380 }}>
        <span className="lbl">Trade thesis · auto-generated</span>
        <div>
          Pair: long <span className="amber">SOXX</span> / short <span className="amber">TSM 1M ATM call spread</span>. Sized
          0.4% NAV. Awaits PM review.
        </div>
      </div>
    </div>
  );
}

function EntityPanel() {
  const entities = [
    { name: "Taiwan Semiconductor (TSM)", role: "subject",    w: 1.0  },
    { name: "Apple (AAPL)",               role: "customer",   w: 0.78 },
    { name: "NVIDIA (NVDA)",              role: "customer",   w: 0.74 },
    { name: "ASML Holding (ASML)",        role: "supplier",   w: 0.63 },
    { name: "Samsung Foundry",            role: "competitor", w: 0.55 },
    { name: "Intel Foundry",              role: "competitor", w: 0.44 },
    { name: "Mediatek (2454.TW)",         role: "peer",       w: 0.41 },
    { name: "Sumco Corporation",          role: "input",      w: 0.33 },
  ];

  const [memo, setMemo] = useState<Memo | null>(null);
  useEffect(() => {
    let cancelled = false;
    getTopMemo()
      .then((m) => {
        if (!cancelled) setMemo(m);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const title = memo?.title ?? "TSM — Q4 print, demand softness signal";
  const conv = memo?.conviction ?? 0.74;
  const thesis =
    memo?.thesis ??
    "Three independent agents converged on a softening-demand interpretation of management's tone, supported by alt-data divergence in NA capex shipments and a thinning options skew on TSM 1M. Suggested expression: long SOXX vs. short TSM call spread. Risk-managed via VIX overlay.";

  return (
    <div>
      <div className="memo">
        <Tag tone="amber">{memo ? `${memo.status.toUpperCase()} MEMO` : "DRAFT MEMO · v3"}</Tag>
        <h4 style={{ marginTop: 6 }}>{title}</h4>
        <div className="ks">
          <span className="k">Conviction</span><span className="v">{conv.toFixed(2)}</span>
          <span className="k">Horizon</span><span className="v">2-6 weeks</span>
          <span className="k">Size (NAV)</span><span className="v">0.40%</span>
          <span className="k">Sharpe (est.)</span><span className="v">1.82</span>
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
        }}
      >
        Entity Graph
      </div>
      {entities.map((e, i) => (
        <div key={i} className="entity">
          <div className="name">{e.name}</div>
          <div className="row">
            <span style={{ textTransform: "uppercase", letterSpacing: "0.12em" }}>{e.role}</span>
            <div className="bar"><i style={{ width: e.w * 100 + "%" }} /></div>
            <span style={{ color: "var(--ink-1)" }}>{e.w.toFixed(2)}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

export function ResearchScreen() {
  const [sel, setSel] = useState<string | null>(null);
  return (
    <div className="research">
      <Panel title="Ingest Queue" meta="2,418 / hr" bodyClassName="tight">
        <DocList sel={sel} setSel={setSel} />
      </Panel>

      <div className="panel" style={{ borderTop: 0, borderBottom: 0 }}>
        <div className="panel-head">
          <span className="title">TSM · Q4 2025 Earnings Call · Reasoning Overlay</span>
          <span className="meta">3 agents synthesizing · 0.74 conv.</span>
        </div>
        <div className="panel-body" style={{ position: "relative" }}>
          <TranscriptView />
        </div>
      </div>

      <Panel title="Synthesis" meta="auto" bodyClassName="tight">
        <EntityPanel />
      </Panel>
    </div>
  );
}
