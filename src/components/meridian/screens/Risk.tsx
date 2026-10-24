"use client";

import { useEffect, useMemo, useState } from "react";
import { Panel, Sparkline, Tag } from "../primitives";
import { useMarket } from "../MarketContext";
import { fmtMoney } from "@/lib/meridian/format";
import { latestRiskReport, listRiskHistory } from "@/lib/appwrite/queries";
import type { Market, RiskReport, RiskReportPayload } from "@/lib/appwrite/schema";

type Book = RiskReport["book"];

// ── helpers ────────────────────────────────────────────────────────────────

// Rounding noise ("-0.00%") reads as zero.
const pct = (x: number | null | undefined, dp = 2) => (x == null ? "—" : `${(x * 100).toFixed(dp).replace(/^-(0\.?0*)$/, "$1")}%`);
const num = (x: number | null | undefined, dp = 2) => (x == null ? "—" : x.toFixed(dp));
const tone = (x: number | null | undefined) => (x == null ? undefined : x < 0 ? "var(--red)" : "var(--green)");

function parse(row: RiskReport | null): RiskReportPayload | null {
  if (!row) return null;
  try {
    return JSON.parse(row.report_json) as RiskReportPayload;
  } catch {
    return null;
  }
}

function age(iso: string): string {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

// ── panels ───────────────────────────────────────────────────────────────────

function BookSeg({ book, setBook }: { book: Book; setBook: (b: Book) => void }) {
  return (
    <div className="v2-seg risk-seg" role="group" aria-label="Book">
      {(["fund", "advisory"] as const).map((b) => (
        <button key={b} className={book === b ? "on" : ""} aria-pressed={book === b} onClick={() => setBook(b)}>
          {b === "fund" ? "Fund" : "Advisory"}
        </button>
      ))}
    </div>
  );
}

function Headline({ r, row, history, market }: { r: RiskReportPayload; row: RiskReport; history: RiskReport[]; market: Market }) {
  const nav = r.nav ?? row.nav;
  const varSeries = history.map((h) => h.var95).filter((v): v is number => v != null);
  return (
    <>
      <div className="bigstat">
        <span className="k">1-day VaR 95%</span>
        <span className="v">{pct(r.var95.parametric)}</span>
        <span className="d dim">
          {r.var95.parametric == null ? "" : `${fmtMoney(r.var95.parametric * nav, market)} · `}historical {pct(r.var95.historical)}
        </span>
        {varSeries.length > 1 && <Sparkline data={varSeries} />}
      </div>
      <div className="bigstat">
        <span className="k">Tracking error vs {r.index}</span>
        <span className="v">{pct(r.tracking_error)}</span>
        <span className="d dim">beta {num(r.beta)} · index vol {pct(r.index_vol)} · book vol {pct(r.vol_annual)}</span>
      </div>
      <div className="q-stats risk-stats">
        <span>ES 95%</span><b>{pct(r.es95.parametric)} · hist {pct(r.es95.historical)}</b>
        <span>VaR 99%</span><b>{pct(r.var99.parametric)} · hist {pct(r.var99.historical)}</b>
        <span>ES 99%</span><b>{pct(r.es99.parametric)} · hist {pct(r.es99.historical)}</b>
        <span>NAV</span><b>{fmtMoney(nav, market)}</b>
        <span>CASH</span><b>{pct(r.cash_weight, 1)}</b>
        <span>MEASURED</span><b>{pct(r.measured_weight, 1)}</b>
        <span>UNMEASURED</span><b style={r.unmeasured_weight ? { color: "var(--md-accent)" } : undefined}>{pct(r.unmeasured_weight, 1)}</b>
        <span>WINDOW</span><b>{r.window.start} → {r.window.end} ({r.window.observations} days)</b>
        <span>SHRINKAGE</span><b>{num(r.shrinkage)} toward identity</b>
        <span>MARKS</span><b>{r.marks}</b>
      </div>
      <p className="q-note risk-pad">
        Parametric figures use a shrunk covariance of daily returns and today&apos;s weights; historical ones replay today&apos;s
        weights over the window. Cash counts as zero risk. Unmeasured names carry no history over the window and are
        left out, never proxied, so the figures cover the measured weight only.
      </p>
    </>
  );
}

function Contributions({ r }: { r: RiskReportPayload }) {
  if (!r.names.length) {
    return (
      <div className="q-empty">
        No measured positions: the book&apos;s risk is its cash. Against {r.index} that leaves a tracking error equal to the
        index&apos;s own volatility ({pct(r.index_vol)}).
      </div>
    );
  }
  const top = Math.max(...r.names.map((n) => Math.abs(n.risk_share ?? 0)), 1e-9);
  return (
    <>
      <div className="risk-row head">
        <span>Name</span><span>Weight</span><span>Share of risk</span><span>Risk</span><span>TE</span><span>Beta</span>
      </div>
      {r.names.map((n) => (
        <div className="risk-row" key={n.ticker}>
          <span className="t">{n.ticker}</span>
          <span>{pct(n.weight, 1)}</span>
          <span className="b"><i style={{ width: `${(Math.abs(n.risk_share ?? 0) / top) * 100}%` }} className={(n.risk_share ?? 0) < 0 ? "neg" : ""} /></span>
          <span>{pct(n.risk_share, 1)}</span>
          <span>{pct(n.te_share, 1)}</span>
          <span>{num(n.beta)}</span>
        </div>
      ))}
      <p className="q-note risk-pad">
        Risk shares sum to 100% over names. TE shares sum to 100% with the index&apos;s own share
        ({pct(r.index_te_share, 1)}), the part of tracking variance from {r.index} weight not held. A negative share hedges.
      </p>
    </>
  );
}

function Stress({ r }: { r: RiskReportPayload }) {
  if (!r.stress.length) return <div className="q-empty">The index history doesn&apos;t reach the replay years.</div>;
  return (
    <div className="risk-stress">
      {r.stress.map((s) => (
        <div className="risk-replay" key={s.label}>
          <div className="lbl">
            <b>{s.label}</b>
            <span className="dim">{s.peak} → {s.trough}</span>
          </div>
          <div className="q-stats">
            <span>{r.index.toUpperCase()}</span><b style={{ color: tone(s.index_return) }}>{pct(s.index_return, 1)}</b>
            <span>THIS BOOK</span><b style={{ color: tone(s.book_return) }}>{pct(s.book_return, 1)}</b>
            <span>NOT COVERED</span><b>{pct(s.uncovered_weight, 1)} of NAV</b>
          </div>
        </div>
      ))}
      <p className="q-note">
        Today&apos;s book replayed over the index&apos;s peak-to-trough in each year. Names not trading at the peak are not
        covered and count as flat.
      </p>
    </div>
  );
}

function Liquidity({ r }: { r: RiskReportPayload }) {
  const slow = r.names
    .filter((n) => n.adv_days != null)
    .sort((a, b) => (b.adv_days ?? 0) - (a.adv_days ?? 0));
  const noVolume = r.names.filter((n) => n.adv_days == null);
  return (
    <>
      {slow.length ? (
        <>
          <div className="risk-liq head"><span>Name</span><span>Days to exit</span><span>Gaps</span></div>
          {slow.map((n) => (
            <div className="risk-liq" key={n.ticker}>
              <span className="t">{n.ticker}</span>
              <span>{(n.adv_days ?? 0) < 0.01 ? "<0.01" : num(n.adv_days)}</span>
              <span className="dim">{n.missing_days ? `${n.missing_days}d` : "—"}</span>
            </div>
          ))}
          <p className="q-note risk-pad">
            Shares held over 20-session average daily volume, at the whole day&apos;s volume. Gaps are window sessions the
            name didn&apos;t print.
          </p>
        </>
      ) : (
        <div className="q-empty">No positions to exit.</div>
      )}
      {noVolume.length > 0 && <p className="q-note risk-pad">No volume reported: {noVolume.map((n) => n.ticker).join(", ")}.</p>}
      {r.unmeasured.length > 0 && (
        <>
          <div className="risk-sub">Unmeasured · {pct(r.unmeasured_weight, 1)} of NAV</div>
          {r.unmeasured.map((u) => (
            <div className="risk-liq" key={u.ticker}>
              <span className="t">{u.ticker}</span>
              <span>{pct(u.weight, 1)}</span>
              <span className="dim why">{u.reason}</span>
            </div>
          ))}
        </>
      )}
    </>
  );
}

// ── screen ───────────────────────────────────────────────────────────────────

export function RiskScreen() {
  const { market } = useMarket();
  const [book, setBook] = useState<Book>("fund");
  const [row, setRow] = useState<RiskReport | null>(null);
  const [history, setHistory] = useState<RiskReport[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.allSettled([latestRiskReport(market, book), listRiskHistory(market, book)]).then(([l, h]) => {
      if (cancelled) return;
      setRow(l.status === "fulfilled" ? l.value : null);
      setError(l.status === "rejected" ? String((l.reason as Error)?.message ?? l.reason) : null);
      setHistory(h.status === "fulfilled" ? h.value : []);
      setLoaded(true);
    });
    return () => {
      cancelled = true;
      setLoaded(false);
    };
  }, [market, book]);

  const r = useMemo(() => parse(row), [row]);
  const seg = <BookSeg book={book} setBook={setBook} />;
  const meta = row ? (
    <>
      {row.session} · {age(row.captured_at)}
      {r && r.unmeasured_weight ? <> · <Tag tone="amber">{pct(r.unmeasured_weight, 0)} unmeasured</Tag></> : null}
    </>
  ) : null;

  if (!loaded || !row || !r) {
    const msg = !loaded
      ? "Loading…"
      : error
        ? `Couldn't read risk reports: ${error}`
        : row
          ? "The stored report couldn't be read."
          : `No ${book} risk report for this desk yet. The desk loop measures each book hourly while it runs; to measure now, run: npx tsx --env-file=.env.local scripts/risk-report.ts ${market} ${book}`;
    return (
      <div className="risk">
        <Panel title={<>Risk {seg}</>} className="span-row-2 span-col-3">
          <div className="q-empty">{msg}</div>
        </Panel>
      </div>
    );
  }

  return (
    <div className="risk">
      <Panel title={<>Risk {seg}</>} meta={meta} className="span-row-2" bodyClassName="tight">
        <Headline r={r} row={row} history={history} market={market} />
      </Panel>
      <Panel title="Risk contributions" meta={`${r.names.length} names`} className="span-row-2" bodyClassName="tight">
        <Contributions r={r} />
      </Panel>
      <Panel title="Stress replays" meta={r.index}>
        <Stress r={r} />
      </Panel>
      <Panel title="Liquidity" meta="days of ADV" bodyClassName="tight">
        <Liquidity r={r} />
      </Panel>
    </div>
  );
}
