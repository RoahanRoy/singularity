"use client";

import { useEffect, useMemo, useState } from "react";
import { operatorFetch } from "@/lib/auth/operator-fetch";
import {
  BENCHMARK_RANGES, compareToIndex, rescaleTo, windowStart,
  type Bar, type BenchmarkRange, type BenchmarkResult, type HoldingVsIndex,
} from "@/lib/fund/benchmark";
import { recordedTrack, type RecordedPoint } from "@/lib/fund/scorecard";
import type { Market, Position } from "@/lib/appwrite/schema";

/** Where a holding's prices came from, when not its own listing in the desk's currency. */
type Source = { symbol: string; currency?: string; proxy?: string };
/** Today's holdings replayed over past prices, or the track recorded at each book sync. */
type View = "replay" | "recorded";

type Payload = {
  index: { symbol: string; name: string; bars: Bar[] };
  bars: Record<string, Bar[]>;
  sources?: Record<string, Source>;
};

const BOOK = "var(--md-accent)";
const INDEX = "var(--ink-2)";

const sgn = (x: number, digits = 1) => `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(digits)}%`;
const tone = (x: number) => (x > 0 ? "var(--green)" : x < 0 ? "var(--red)" : "var(--ink-1)");
const fmtDate = (d: string) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "2-digit", timeZone: "UTC" });

const label: React.CSSProperties = {
  fontFamily: "var(--mono)", fontSize: 10, color: "var(--ink-3)", letterSpacing: "0.12em", textTransform: "uppercase",
};

/**
 * The book against the desk's broad-market index (S&P 500 / Nifty 50): both
 * rebased to 100, the running excess underneath, risk stats, and which
 * holdings are carrying or dragging the book.
 */
export function BenchmarkPanel({ positions, market, snapshots = [] }: {
  positions: Position[];
  market: Market;
  /** The desk's fund_snapshots, oldest first: the recorded track lives on them. */
  snapshots?: RecordedPoint[];
}) {
  const [range, setRange] = useState<BenchmarkRange>("6M");
  const [view, setView] = useState<View>("replay");
  const listed = useMemo(
    () => positions.filter((p) => !p.ticker.startsWith("MF:") && p.qty > 0),
    [positions],
  );
  const key = `${market}|${listed.map((p) => p.ticker).sort().join(",")}`;
  const [loaded, setLoaded] = useState<{ key: string; payload: Payload | null; error: string | null } | null>(null);

  useEffect(() => {
    if (!listed.length) return;
    let cancelled = false;
    const tickers = encodeURIComponent(listed.map((p) => p.ticker).join(","));
    operatorFetch(`/api/market/benchmark?market=${market}&tickers=${tickers}`, { cache: "no-store" })
      .then(async (r) => {
        const j = await r.json();
        if (cancelled) return;
        if (!r.ok) setLoaded({ key, payload: null, error: j?.error ?? `HTTP ${r.status}` });
        else setLoaded({ key, payload: j as Payload, error: null });
      })
      .catch((e: unknown) => { if (!cancelled) setLoaded({ key, payload: null, error: e instanceof Error ? e.message : "fetch failed" }); });
    return () => { cancelled = true; };
    // `key` captures the market and the ticker set; `listed` changes identity on every positions read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const payload = loaded?.key === key ? loaded.payload : null;
  const indexName = payload?.index.name ?? (market === "IN" ? "Nifty 50" : "S&P 500");
  const funds = positions.filter((p) => p.ticker.startsWith("MF:")).length;

  const result = useMemo<BenchmarkResult | null>(() => {
    if (!payload) return null;
    const bars = payload.index.bars;
    if (!bars.length) return null;
    const from = windowStart(bars[bars.length - 1].date, range);
    return compareToIndex(
      listed.map((p) => {
        const own = payload.bars[p.ticker] ?? [];
        // A stand-in moves like the holding but sits at its own price level.
        const bars = payload.sources?.[p.ticker]?.proxy ? rescaleTo(own, p.market_value / p.qty) : own;
        return { ticker: p.ticker, label: p.label, qty: p.qty, bars };
      }),
      bars,
      from,
    );
  }, [payload, listed, range]);

  const recorded = useMemo<BenchmarkResult | null>(() => {
    const all = recordedTrack(snapshots);
    if (!all) return null;
    // A range shorter than the record so far shows the whole record.
    return recordedTrack(snapshots, windowStart(all.dates[all.dates.length - 1], range)) ?? all;
  }, [snapshots, range]);
  const recordedSince = recordedTrack(snapshots)?.dates[0] ?? null;
  const viewProps = { view, onView: setView, recordedSince };

  if (view === "recorded" && recorded) {
    return <BenchmarkView result={recorded} indexName={indexName} range={range} onRange={setRange} funds={0} {...viewProps} />;
  }
  if (!listed.length) {
    return <Empty>No listed holdings on this desk yet: nothing to compare against the {indexName}.</Empty>;
  }
  if (loaded?.key === key && loaded.error) return <Empty>Couldn&apos;t load price history: {loaded.error}</Empty>;
  if (!payload) return <Empty>Loading a year of closes for {listed.length} holdings and the {indexName}…</Empty>;
  if (!result) return <Empty>No overlapping price history for the book and the {indexName}.</Empty>;
  return (
    <BenchmarkView
      result={result} indexName={indexName} range={range} onRange={setRange} funds={funds} sources={payload.sources} {...viewProps}
    />
  );
}

/** The comparison itself, given a computed result: no fetching, so it renders anywhere. */
export function BenchmarkView({
  result, indexName, range, onRange, funds, sources = {}, view = "replay", onView, recordedSince = null,
}: {
  result: BenchmarkResult;
  indexName: string;
  range: BenchmarkRange;
  onRange: (r: BenchmarkRange) => void;
  funds: number;
  sources?: Record<string, Source>;
  view?: View;
  onView?: (v: View) => void;
  /** First day of the recorded track; null until two days are on record. */
  recordedSince?: string | null;
}) {
  const beating = result.excess >= 0;
  const held = new Set(result.holdings.map((h) => h.ticker));
  const abroad = Object.entries(sources).filter(([t, s]) => held.has(t) && !s.proxy);
  const proxied = Object.entries(sources).filter(([t, s]) => held.has(t) && s.proxy);
  return (
    <div style={{ display: "grid", gap: 0 }}>
      {onView && (
        <div style={{ display: "flex", gap: 2, padding: "10px 14px 0" }} role="group" aria-label="Which book">
          <Toggle on={view === "replay"} onClick={() => onView("replay")}>Replay · today&apos;s holdings</Toggle>
          <Toggle
            on={view === "recorded"}
            onClick={() => onView("recorded")}
            disabled={!recordedSince}
            title={recordedSince ? undefined : "Starts with the next book sync; shows once two days are on record."}
          >
            {recordedSince ? `Recorded · since ${fmtDate(recordedSince)}` : "Recorded · starts next sync"}
          </Toggle>
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "10px 14px 6px", flexWrap: "wrap" }}>
        <div style={{ fontFamily: "var(--mono)", fontSize: 13, color: "var(--ink-0)" }}>
          {beating ? "Ahead of" : "Behind"} the {indexName} by{" "}
          <span style={{ color: tone(result.excess) }}>{Math.abs(result.excess * 100).toFixed(1)}%</span>
          <span style={{ color: "var(--ink-3)" }}> · {range}</span>
        </div>
        <Legend color={BOOK} text={`Book ${sgn(result.bookReturn)}`} />
        <Legend color={INDEX} text={`${indexName} ${sgn(result.indexReturn)}`} dashed />
        <div style={{ marginLeft: "auto", display: "flex", gap: 2 }} role="group" aria-label="Time range">
          {BENCHMARK_RANGES.map((r) => (
            <Toggle key={r} on={r === range} onClick={() => onRange(r)}>{r}</Toggle>
          ))}
        </div>
      </div>

      <ComparisonChart result={result} indexName={indexName} />

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", borderTop: "1px solid var(--line-soft)" }}>
        <Stat k="Excess" v={sgn(result.excess)} color={tone(result.excess)} />
        <Stat k="Beta" v={result.beta == null ? "—" : result.beta.toFixed(2)} />
        <Stat
          k="Up / down capture"
          v={result.upCapture == null || result.downCapture == null ? "—" : `${Math.round(result.upCapture * 100)} / ${Math.round(result.downCapture * 100)}`}
        />
        <Stat k="Max DD · book" v={sgn(result.bookMaxDrawdown)} color={result.bookMaxDrawdown < result.indexMaxDrawdown ? "var(--red)" : undefined} />
        <Stat k="Max DD · index" v={sgn(result.indexMaxDrawdown)} />
        <Stat k="Tracking error" v={result.trackingError == null ? "—" : `${(result.trackingError * 100).toFixed(1)}%`} />
      </div>

      <Contributors holdings={result.holdings} indexName={indexName} />

      <div className="dim" style={{ padding: "8px 14px 12px", fontFamily: "var(--mono)", fontSize: 10.5, lineHeight: 1.6, color: "var(--ink-3)" }}>
        {view === "recorded" ? (
          <>
            Recorded at each book sync: the book&apos;s holdings marked from one sync to the next, so trades and their
            timing count and new cash doesn&apos;t, against the {indexName} price index.
          </>
        ) : (
          <>Today&apos;s share counts held over the window (price return, no cash or trades), against the {indexName} price index.</>
        )}
        {abroad.length > 0 && ` Priced from listings abroad, converted daily: ${abroad.map(([t, s]) => `${t} (${s.symbol}${s.currency ? `, ${s.currency}` : ""})`).join(", ")}.`}
        {proxied.length > 0 && ` Stand-ins: ${proxied.map(([t, s]) => `${t} (${s.proxy})`).join(", ")}.`}
        {result.missing.length > 0 && ` No history for ${result.missing.join(", ")}.`}
        {funds > 0 && ` ${funds} fund${funds === 1 ? "" : "s"} left out.`}
        {" "}Capture above 100 / below 100 is the shape that beats the index with less risk.
      </div>
    </div>
  );
}

function Toggle({ on, onClick, disabled, title, children }: {
  on: boolean;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      disabled={disabled}
      title={title}
      style={{
        fontFamily: "var(--mono)", fontSize: 10, letterSpacing: "0.08em", padding: "3px 8px",
        border: "1px solid " + (on ? "var(--line-strong)" : "transparent"), borderRadius: 6,
        background: on ? "var(--bg-3)" : "transparent",
        color: on ? "var(--ink-0)" : "var(--ink-3)", cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.6 : 1,
      }}
    >
      {children}
    </button>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="dim" style={{ padding: "10px 14px", fontFamily: "var(--mono)", fontSize: 11, lineHeight: 1.6 }}>{children}</div>;
}

function Legend({ color, text, dashed }: { color: string; text: string; dashed?: boolean }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontFamily: "var(--mono)", fontSize: 11, color: "var(--ink-1)" }}>
      <svg width="16" height="6" aria-hidden>
        <line x1="0" y1="3" x2="16" y2="3" stroke={color} strokeWidth="2" strokeDasharray={dashed ? "3 2" : undefined} strokeLinecap="round" />
      </svg>
      {text}
    </span>
  );
}

function Stat({ k, v, color }: { k: string; v: string; color?: string }) {
  return (
    <div style={{ padding: "10px 14px", borderRight: "1px solid var(--line-soft)" }}>
      <div style={label}>{k}</div>
      <div style={{ fontFamily: "var(--mono)", fontSize: 15, marginTop: 3, color: color ?? "var(--ink-0)" }}>{v}</div>
    </div>
  );
}

// ── Chart ────────────────────────────────────────────────────────────────────

const W = 600;
const H_MAIN = 190;
const H_EXCESS = 54;
const PAD_Y = 10;

/** Round-number gridlines (in % change from the start) spanning [lo, hi]. */
function ticks(lo: number, hi: number): number[] {
  const span = Math.max(hi - lo, 1);
  const step = [1, 2, 5, 10, 20, 25, 50, 100].find((s) => span / s <= 5) ?? 200;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(v);
  return out;
}

function ComparisonChart({ result, indexName }: { result: BenchmarkResult; indexName: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const n = result.dates.length;
  const x = (k: number) => (k / Math.max(1, n - 1)) * W;

  // Main panel: both series as % change from the window start, one shared axis.
  const bookPct = result.book.map((v) => v - 100);
  const idxPct = result.index.map((v) => v - 100);
  const lo = Math.min(0, ...bookPct, ...idxPct);
  const hi = Math.max(0, ...bookPct, ...idxPct);
  const pad = (hi - lo) * 0.08 || 1;
  const yLo = lo - pad, yHi = hi + pad;
  const y = (v: number) => PAD_Y + (1 - (v - yLo) / (yHi - yLo)) * (H_MAIN - 2 * PAD_Y);
  const path = (vs: number[]) => vs.map((v, k) => `${k ? "L" : "M"}${x(k).toFixed(2)},${y(v).toFixed(2)}`).join(" ");

  // Excess strip: book minus index, in percentage points.
  const ex = bookPct.map((b, k) => b - idxPct[k]);
  const exMax = Math.max(0.5, ...ex.map(Math.abs));
  const ey = (v: number) => H_EXCESS / 2 - (v / exMax) * (H_EXCESS / 2 - 4);
  const exLine = ex.map((v, k) => `${k ? "L" : "M"}${x(k).toFixed(2)},${ey(v).toFixed(2)}`).join(" ");
  const exArea = `${exLine} L${W},${H_EXCESS / 2} L0,${H_EXCESS / 2} Z`;

  const grid = ticks(lo, hi);
  const k = hover;
  const onMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    setHover(Math.round(f * (n - 1)));
  };
  const endLabel = (v: number) => `${(y(v) / H_MAIN) * 100}%`;
  const lastB = bookPct[n - 1], lastI = idxPct[n - 1];
  // Keep the two end labels from overlapping when the lines finish close together.
  const apart = Math.abs(y(lastB) - y(lastI)) > 14;

  return (
    <div style={{ padding: "4px 14px 10px" }}>
      <div
        style={{ position: "relative", paddingRight: 92 }}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        <div style={{ position: "relative", height: H_MAIN }}>
          <svg viewBox={`0 0 ${W} ${H_MAIN}`} preserveAspectRatio="none" style={{ width: "100%", height: H_MAIN, display: "block" }} role="img"
            aria-label={`Book ${sgn(result.bookReturn)} against ${indexName} ${sgn(result.indexReturn)}`}>
            <g stroke="var(--line-soft)" strokeWidth="1" vectorEffect="non-scaling-stroke">
              {grid.map((g) => <line key={g} x1="0" x2={W} y1={y(g)} y2={y(g)} vectorEffect="non-scaling-stroke" strokeDasharray={g === 0 ? undefined : "2 4"} stroke={g === 0 ? "var(--ink-4)" : undefined} />)}
            </g>
            <path d={path(idxPct)} fill="none" stroke={INDEX} strokeWidth="2" strokeDasharray="5 4" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
            <path d={path(bookPct)} fill="none" stroke={BOOK} strokeWidth="2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
            {k != null && <line x1={x(k)} x2={x(k)} y1="0" y2={H_MAIN} stroke="var(--ink-3)" strokeWidth="1" vectorEffect="non-scaling-stroke" />}
          </svg>
          {k != null && (
            <>
              <Dot left={(x(k) / W) * 100} top={(y(idxPct[k]) / H_MAIN) * 100} color={INDEX} />
              <Dot left={(x(k) / W) * 100} top={(y(bookPct[k]) / H_MAIN) * 100} color={BOOK} />
            </>
          )}
          {/* y-axis labels and direct end labels live in HTML so the stretched SVG can't distort them. */}
          {grid.map((g) => (
            <span key={g} style={{ ...label, letterSpacing: 0, position: "absolute", left: 2, top: `${(y(g) / H_MAIN) * 100}%`, transform: "translateY(calc(-100% - 1px))", pointerEvents: "none" }}>
              {g > 0 ? "+" : ""}{g}%
            </span>
          ))}
          <EndLabel top={endLabel(lastB)} text={`Book ${sgn(result.bookReturn)}`} nudge={apart ? 0 : lastB >= lastI ? -7 : 7} />
          <EndLabel top={endLabel(lastI)} text={`${indexName} ${sgn(result.indexReturn)}`} nudge={apart ? 0 : lastB >= lastI ? 7 : -7} muted />
        </div>

        <div style={{ position: "relative", height: H_EXCESS, marginTop: 22 }}>
          <svg viewBox={`0 0 ${W} ${H_EXCESS}`} preserveAspectRatio="none" style={{ width: "100%", height: H_EXCESS, display: "block" }} aria-hidden>
            <defs>
              <clipPath id="bm-above"><rect x="0" y="0" width={W} height={H_EXCESS / 2} /></clipPath>
              <clipPath id="bm-below"><rect x="0" y={H_EXCESS / 2} width={W} height={H_EXCESS / 2} /></clipPath>
            </defs>
            <path d={exArea} fill="var(--green)" fillOpacity="0.28" clipPath="url(#bm-above)" />
            <path d={exArea} fill="var(--red)" fillOpacity="0.28" clipPath="url(#bm-below)" />
            <line x1="0" x2={W} y1={H_EXCESS / 2} y2={H_EXCESS / 2} stroke="var(--ink-4)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
            <path d={exLine} fill="none" stroke="var(--ink-1)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
            {k != null && <line x1={x(k)} x2={x(k)} y1="0" y2={H_EXCESS} stroke="var(--ink-3)" strokeWidth="1" vectorEffect="non-scaling-stroke" />}
          </svg>
          <span style={{ ...label, position: "absolute", left: 0, top: -16 }}>Excess vs index</span>
          <span style={{ ...label, letterSpacing: 0, position: "absolute", right: -92, top: "50%", transform: "translateY(-50%)", width: 84, color: tone(ex[n - 1]) }}>
            {ex[n - 1] >= 0 ? "+" : "−"}{Math.abs(ex[n - 1]).toFixed(1)} pts
          </span>
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4, ...label, letterSpacing: 0 }}>
          <span>{fmtDate(result.dates[0])}</span>
          <span>{fmtDate(result.dates[n - 1])}</span>
        </div>

        {k != null && (
          <div
            style={{
              position: "absolute", top: 4, pointerEvents: "none",
              left: `calc((100% - 92px) * ${x(k) / W})`,
              transform: x(k) > W * 0.6 ? "translateX(calc(-100% - 10px))" : "translateX(10px)",
              background: "var(--bg-2)", border: "1px solid var(--line-strong)", borderRadius: 8,
              padding: "7px 9px", fontFamily: "var(--mono)", fontSize: 11, lineHeight: 1.55, color: "var(--ink-1)", whiteSpace: "nowrap",
              boxShadow: "0 8px 24px -12px rgba(0,0,0,0.6)",
            }}
          >
            <div style={{ color: "var(--ink-3)" }}>{fmtDate(result.dates[k])}</div>
            <TipRow color={BOOK} name="Book" v={bookPct[k] / 100} />
            <TipRow color={INDEX} name={indexName} v={idxPct[k] / 100} dashed />
            <div>Excess <span style={{ color: tone(ex[k]) }}>{ex[k] >= 0 ? "+" : "−"}{Math.abs(ex[k]).toFixed(1)} pts</span></div>
          </div>
        )}
      </div>
    </div>
  );
}

function Dot({ left, top, color }: { left: number; top: number; color: string }) {
  return (
    <span style={{
      position: "absolute", left: `${left}%`, top: `${top}%`, width: 8, height: 8, borderRadius: 99,
      background: color, boxShadow: "0 0 0 2px var(--bg-1)", transform: "translate(-50%, -50%)", pointerEvents: "none",
    }} />
  );
}

function EndLabel({ top, text, nudge, muted }: { top: string; text: string; nudge: number; muted?: boolean }) {
  return (
    <span style={{
      position: "absolute", right: -92, top, transform: `translateY(calc(-50% + ${nudge}px))`, width: 84,
      fontFamily: "var(--mono)", fontSize: 10, color: muted ? "var(--ink-2)" : "var(--ink-0)",
      whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", paddingLeft: 6,
    }}>
      {text}
    </span>
  );
}

function TipRow({ color, name, v, dashed }: { color: string; name: string; v: number; dashed?: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <svg width="12" height="6" aria-hidden>
        <line x1="0" y1="3" x2="12" y2="3" stroke={color} strokeWidth="2" strokeDasharray={dashed ? "3 2" : undefined} />
      </svg>
      <span style={{ flex: 1 }}>{name}</span>
      <span style={{ color: "var(--ink-0)", marginLeft: 12 }}>{sgn(v)}</span>
    </div>
  );
}

// ── Who is carrying the book ────────────────────────────────────────────────

function Contributors({ holdings, indexName }: { holdings: HoldingVsIndex[]; indexName: string }) {
  if (!holdings.length) return null;
  const top = holdings.filter((h) => h.contribution > 0).slice(0, 5);
  const bottom = holdings.filter((h) => h.contribution < 0).slice(-5).reverse();
  const scale = Math.max(...holdings.map((h) => Math.abs(h.contribution)), 1e-9);
  const beat = holdings.filter((h) => h.excess > 0).length;
  return (
    <div style={{ borderTop: "1px solid var(--line-soft)", padding: "10px 14px 4px" }}>
      <div style={{ ...label, marginBottom: 6 }}>
        {beat} of {holdings.length} holdings beat the {indexName} · contribution to excess, pts
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "0 24px" }}>
        <ContribList rows={top} scale={scale} empty="No holding is ahead of the index." />
        <ContribList rows={bottom} scale={scale} empty="No holding is lagging the index." />
      </div>
    </div>
  );
}

function ContribList({ rows, scale, empty }: { rows: HoldingVsIndex[]; scale: number; empty: string }) {
  if (!rows.length) return <div className="dim" style={{ fontFamily: "var(--mono)", fontSize: 11, padding: "4px 0" }}>{empty}</div>;
  return (
    <div>
      {rows.map((h) => (
        <div
          key={h.ticker}
          title={`${h.label ?? h.ticker}: ${sgn(h.ret)} over the window, ${sgn(h.excess)} vs the index, weight ${(h.weight * 100).toFixed(1)}%`}
          style={{ display: "grid", gridTemplateColumns: "84px 58px 1fr 54px", alignItems: "center", gap: 8, padding: "4px 0", fontFamily: "var(--mono)", fontSize: 11 }}
        >
          <span style={{ color: "var(--ink-0)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{h.ticker}</span>
          <span style={{ color: "var(--ink-2)", textAlign: "right" }}>{sgn(h.ret)}</span>
          <span style={{ height: 6, background: "var(--bg-3)", borderRadius: 3, position: "relative", overflow: "hidden" }}>
            <i style={{
              position: "absolute", top: 0, bottom: 0, left: 0, borderRadius: 3,
              width: `${(Math.abs(h.contribution) / scale) * 100}%`,
              background: h.contribution >= 0 ? "var(--green)" : "var(--red)",
            }} />
          </span>
          <span style={{ color: "var(--ink-1)", textAlign: "right" }}>{h.contribution >= 0 ? "+" : "−"}{Math.abs(h.contribution * 100).toFixed(2)}</span>
        </div>
      ))}
    </div>
  );
}
