"use client";

import { useState } from "react";
import { useDesk } from "../Shell";
import { useMarket } from "../MarketContext";
import { FundMandatePanel } from "../FundMandate";
import { HorizonSourcePanel, useHorizonStatus } from "../HorizonSource";
import { IbkrAccountsPanel } from "../IbkrAccounts";
import { latestRiskReport, listAdvisoryPositions, listAdvisoryTrades, listFundSnapshots } from "@/lib/appwrite/queries";
import type { AdvisoryTrade, FactorExposure, FundSnapshot, Position, RiskReport, RiskReportPayload } from "@/lib/appwrite/schema";
import type { Market } from "@/lib/meridian/format";
import type { Bar } from "@/lib/fund/benchmark";
import { DESK_INDEX } from "@/lib/market/indices";
import { operatorFetch } from "@/lib/auth/operator-fetch";
import { TRADING_DAYS } from "@/lib/quant/risk";
import { LineChart, shortDate } from "./Chart";
import { PlanSection } from "./Plan";
import { fullMoney, money, pct, toneOf, useFundBook, useLoad, useOnboard, useQuotes, yahoo } from "./data";

type Book = RiskReport["book"];

const RANGES: [string, string][] = [
  ["1M", "1M"],
  ["3M", "3M"],
  ["6M", "6M"],
  ["YTD", "YTD"],
  ["1Y", "1Y"],
  ["All", "All"],
];

function rangeStart(r: string, now: Date): number {
  const d = new Date(now);
  if (r === "YTD") return new Date(now.getFullYear(), 0, 1).getTime();
  if (r === "All") return -Infinity;
  const months = { "1M": 1, "3M": 3, "6M": 6, "1Y": 12 }[r] ?? 0;
  d.setMonth(d.getMonth() - months);
  return d.getTime();
}

const FACTOR_LABELS: Record<string, string> = {
  US_LARGE: "US large-cap",
  US_SMALL: "US small-cap",
  EU_EQ: "EU equities",
  JP_EQ: "Japan equities",
  EM_EQ: "EM equities",
  IG_CREDIT: "Investment-grade credit",
  HY_CREDIT: "High yield",
  RATES_2_5Y: "Rates 2–5y",
  RATES_10Y: "Rates 10y+",
  FX_USD: "US dollar",
  GOLD: "Gold",
  OIL: "Oil and energy",
  VOL_VIX: "Volatility (VIX)",
  NIFTY_MKT: "Nifty (market)",
  IN_BANKS: "Nifty Bank",
  IN_IT: "Nifty IT",
  FX_USDINR: "USD/INR",
};
const FACTOR_ORDER = Object.keys(FACTOR_LABELS);

/** Weight × beta per factor, from each position's stored factor_exposures_json. */
function exposures(rows: { p: Position; w: number }[]): { factor: string; v: number }[] {
  const net: Record<string, number> = {};
  for (const { p, w } of rows) {
    if (!p.factor_exposures_json) continue;
    let fs: FactorExposure[];
    try {
      fs = JSON.parse(p.factor_exposures_json);
    } catch {
      continue;
    }
    if (!Array.isArray(fs)) continue;
    for (const f of fs) if (f && typeof f.beta === "number") net[f.factor] = (net[f.factor] || 0) + w * f.beta;
  }
  return Object.keys(net)
    .sort((a, b) => (FACTOR_ORDER.indexOf(a) + 1 || 99) - (FACTOR_ORDER.indexOf(b) + 1 || 99))
    .map((factor) => ({ factor, v: net[factor] }));
}

function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = xs.reduce((s, x) => s + x, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

/**
 * The index's daily close on or before each mark's date: the last session the
 * mark had seen. Null for marks older than the closes Yahoo returned.
 * Marks and bars both run oldest first.
 */
function indexOnMarks(snaps: FundSnapshot[], bars: Bar[] | null): (number | null)[] {
  let k = 0;
  let last: number | null = null;
  return snaps.map((s) => {
    const day = s.captured_at.slice(0, 10);
    while (bars && k < bars.length && bars[k].date <= day) last = bars[k++].close;
    return last;
  });
}

/**
 * A mark written long after the moment it claims. An old enrich step replayed
 * the quantities held that day over a year of closes, back-dating each row; those rows
 * landed a day or more late. A recorded mark is written as it is taken, within
 * a second. Replays chart faint and stay out of the metrics: the book never
 * held those quantities on those dates.
 */
const REPLAY_LAG_MS = 60 * 60 * 1000;
function isReplay(s: FundSnapshot): boolean {
  return Date.parse(s.$createdAt) - Date.parse(s.captured_at) > REPLAY_LAG_MS;
}

/**
 * Range metrics from the stored marks. The advisory book's NAV moves with the
 * operator's deposits, so its returns come from the flow-free book_index when
 * every mark carries one. The index return comes from its daily closes on the
 * marks, or else the level each mark recorded.
 */
function metrics(snaps: FundSnapshot[], book: Book, closes: (number | null)[]) {
  const flowFree = book === "advisory" && snaps.length > 0 && snaps.every((s) => s.book_index != null);
  const level = snaps.map((s) => (flowFree ? (s.book_index as number) : s.nav_usd));
  const rets: number[] = [];
  for (let i = 1; i < level.length; i++) if (level[i - 1]) rets.push(level[i] / level[i - 1] - 1);
  const enough = rets.length >= 2;
  let peak = level[0] ?? 0;
  let dd = 0;
  for (const v of level) {
    if (v > peak) peak = v;
    if (peak) dd = Math.min(dd, v / peak - 1);
  }
  const vol = std(rets) * Math.sqrt(TRADING_DAYS);
  const mean = rets.length ? rets.reduce((s, x) => s + x, 0) / rets.length : 0;
  const first = snaps[0];
  const last = snaps[snaps.length - 1];
  const c0 = closes[0];
  const cN = closes[closes.length - 1];
  const idx =
    c0 && cN
      ? cN / c0 - 1
      : first?.index_level && last?.index_level
        ? last.index_level / first.index_level - 1
        : null;
  return {
    ret: level.length >= 2 && level[0] ? level[level.length - 1] / level[0] - 1 : null,
    idx,
    dd: level.length >= 2 ? dd : null,
    vol: enough ? vol : null,
    sharpe: enough && vol ? (mean * TRADING_DAYS) / vol : null,
  };
}

function parseReport(row: RiskReport | null): { row: RiskReport; p: RiskReportPayload } | null {
  if (!row) return null;
  try {
    return { row, p: JSON.parse(row.report_json) as RiskReportPayload };
  } catch {
    return null;
  }
}

export function BookScreen() {
  const { market } = useMarket();
  const { full } = useDesk();
  const [book, setBook] = useState<Book>("fund");
  const [range, setRange] = useState("3M");
  // Bumped after a Horizon sync so the advisory book re-reads.
  const [nonce, setNonce] = useState(0);
  const onboard = useOnboard();
  const fund = useFundBook(market, onboard);
  const advisory = useLoad(
    () => Promise.all([listAdvisoryPositions(200, market), listFundSnapshots(400, market, "advisory")]),
    [market, nonce],
    [[], []] as [Position[], FundSnapshot[]],
  );
  const riskGot = useLoad(
    () => latestRiskReport(market, book).then((r) => ({ hit: parseReport(r) })),
    [market, book, nonce],
    { hit: null },
  );
  const risk = riskGot?.hit ?? null;
  const { status: horizon, refresh: refreshHorizon } = useHorizonStatus();
  // A year of the index's daily closes (no tickers: the index alone).
  const indexBars = useLoad<Bar[] | null>(
    () =>
      operatorFetch(`/api/market/benchmark?market=${market}`, { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((j: { index?: { bars?: Bar[] } } | null) => j?.index?.bars ?? null),
    [market],
    null,
  );

  const positions = (book === "fund" ? fund?.positions : advisory?.[0]) ?? [];
  const snapshots = (book === "fund" ? fund?.snapshots : advisory?.[1]) ?? [];
  const loaded = book === "fund" ? fund != null : advisory != null;
  const mv = positions.reduce((s, p) => s + (p.market_value || 0), 0);
  const noFund = book === "fund" && fund != null && fund.cash == null;
  const value = book === "fund" ? (fund && fund.cash != null ? fund.nav : null) : positions.length ? mv : null;
  const denom = book === "fund" ? value ?? 0 : mv;

  const last = snapshots[snapshots.length - 1];
  const dayPnl = last ? last.pnl_daily : null;
  const prior = last ? last.nav_usd - last.pnl_daily : 0;
  const dayPct = dayPnl != null && prior > 0 ? dayPnl / prior : null;

  const from = rangeStart(range, new Date());
  const inRange = snapshots.filter((s) => Date.parse(s.captured_at) >= from);
  const closes = indexOnMarks(inRange, indexBars);
  const replays = inRange.map(isReplay);
  const recorded = inRange.filter((_, i) => !replays[i]);
  const m = metrics(recorded, book, indexOnMarks(recorded, indexBars));
  const index = DESK_INDEX[market];
  // The index rebased onto the book's value where its closes start, so the two
  // lines leave together and the gap between them is the excess.
  const anchor = closes.findIndex((c) => c != null);
  const compare =
    anchor >= 0 && anchor < inRange.length - 1
      ? {
          name: anchor === 0 ? index.name : `${index.name} · from ${shortDate(inRange[anchor].captured_at)}`,
          color: "var(--ink-3)",
          values: closes.map((c, i) =>
            c == null || i < anchor ? null : (inRange[anchor].nav_usd * c) / (closes[anchor] as number),
          ),
        }
      : undefined;

  const sorted = [...positions].sort((a, b) => (b.market_value || 0) - (a.market_value || 0));
  const weighted = sorted.map((p) => ({ p, w: denom > 0 ? (p.market_value || 0) / denom : 0 }));
  const quotes = useQuotes(sorted.slice(0, 40).map((p) => yahoo(p.ticker, market)));
  const byTicker = new Map((risk?.p.names ?? []).map((n) => [n.ticker, n]));
  const budget = onboard?.budgets[market]?.target_te ?? null;

  const metricRows: [string, string, string?][] = [
    [`Return · ${range}`, pct(m.ret, 2, true), toneOf(m.ret)],
    [index.name, pct(m.idx, 2, true), toneOf(m.idx)],
    ["Max drawdown", pct(m.dd, 1)],
    ["Volatility (ann.)", pct(m.vol, 1)],
    ["Sharpe", m.sharpe == null ? "—" : m.sharpe.toFixed(2)],
  ];

  const holdMeta = risk
    ? `Risk measured ${shortDate(risk.row.captured_at)} · session ${risk.row.session}`
    : riskGot === null
      ? "Reading risk…"
      : "Risk not measured yet";

  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "10px 16px", marginBottom: 24 }}>
        <div className="m-seg" role="group" aria-label="Book">
          <button aria-pressed={book === "fund"} onClick={() => setBook("fund")}>
            Fund
          </button>
          <button aria-pressed={book === "advisory"} onClick={() => setBook("advisory")}>
            Advisory
          </button>
        </div>
        <span className="m-sub">
          {book === "fund"
            ? "The desk's own paper fund: mandate cash plus what the agents bought."
            : "Your real holdings, synced read-only. The desk advises; nothing is sent to a broker."}
        </span>
      </div>

      <section>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", justifyContent: "space-between", gap: 12 }}>
          <div>
            <div className="m-sub">{book === "fund" ? "Net asset value" : "Market value"}</div>
            <div className="m-big" style={{ fontSize: "clamp(34px,4.6vw,48px)", lineHeight: 1.1 }}>
              {value == null ? "—" : fullMoney(value, market)}
            </div>
            <div style={{ fontSize: 15, fontWeight: 500, color: toneOf(dayPnl), fontVariantNumeric: "tabular-nums" }}>
              {dayPnl == null
                ? "No mark yet"
                : `${dayPnl < 0 ? "−" : "+"}${money(Math.abs(dayPnl), market)} (${pct(dayPct, 2, true)}) at the last mark`}
            </div>
          </div>
          <div className="m-seg sm" role="group" aria-label="Range">
            {RANGES.map(([id, label]) => (
              <button key={id} aria-pressed={range === id} onClick={() => setRange(id)}>
                {label}
              </button>
            ))}
          </div>
        </div>
        {inRange.length >= 2 ? (
          <LineChart
            points={inRange.map((s) => ({ t: s.captured_at, v: s.nav_usd }))}
            color={toneOf((m.ret ?? 0) || 1)}
            name={book === "fund" ? "Fund" : "Holdings"}
            compare={compare}
            faint={{ name: "Replayed: later holdings at past closes", at: replays }}
            label={(p, first, i) => (
              <>
                {shortDate(p.t)} · {fullMoney(p.v, market)}
                {replays[i] ? " (replayed)" : ""} · {pct(first.v ? p.v / first.v - 1 : null, 2, true)} in range
                {compare && closes[i] != null && i >= anchor
                  ? ` · ${index.name} ${pct((closes[i] as number) / (closes[anchor] as number) - 1, 2, true)}`
                  : ""}
              </>
            )}
          />
        ) : (
          <p className="m-empty" style={{ marginTop: 18 }}>
            {loaded
              ? `Fewer than two marks in this range: the chart draws once the desk has marked the ${book} book twice.`
              : "Loading…"}
          </p>
        )}
      </section>

      <div className="m-stats" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))", marginTop: 28 }}>
        {metricRows.map(([k, v, c]) => (
          <div key={k}>
            <div className="k">{k}</div>
            <div className="v" style={{ color: c }}>
              {v}
            </div>
          </div>
        ))}
      </div>
      {replays.some(Boolean) && (
        <p className="m-meta" style={{ marginTop: 10 }}>
          From the {recorded.length} recorded {recorded.length === 1 ? "mark" : "marks"} in range; the{" "}
          {inRange.length - recorded.length} replayed {inRange.length - recorded.length === 1 ? "one is" : "ones are"} drawn
          only.
        </p>
      )}

      <section style={{ marginTop: 44 }}>
        <div className="m-shead">
          <h2 className="m-h2">Holdings</h2>
          <span className="m-meta">{holdMeta}</span>
        </div>
        {!loaded ? (
          <p className="m-empty">Loading…</p>
        ) : sorted.length === 0 ? (
          <p className="m-empty">
            {book === "advisory"
              ? "No holdings synced from Horizon or IBKR."
              : noFund
                ? "No fund mandate on this desk: set one below to open the fund book."
                : "Nothing deployed yet: the fund is all mandate cash."}
          </p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <div style={{ minWidth: 520 }}>
              <div className="m-tr head" style={{ gridTemplateColumns: "minmax(120px,1.6fr) repeat(4,minmax(70px,1fr))" }}>
                <span>Name</span>
                <span style={{ textAlign: "right" }}>Weight</span>
                <span style={{ textAlign: "right" }}>Today</span>
                <span style={{ textAlign: "right" }}>Beta</span>
                <span style={{ textAlign: "right" }}>Share of risk</span>
              </div>
              {weighted.map(({ p, w }) => {
                const q = quotes[yahoo(p.ticker, market)];
                const d = q ? q.changePct / 100 : null;
                const r = byTicker.get(p.ticker);
                return (
                  <div key={p.$id} className="m-tr" style={{ gridTemplateColumns: "minmax(120px,1.6fr) repeat(4,minmax(70px,1fr))" }}>
                    <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      <span style={{ fontWeight: 600 }}>{p.ticker}</span>{" "}
                      {p.label && <span className="m-meta">{p.label}</span>}
                    </span>
                    <span style={{ textAlign: "right" }}>{pct(w, 1)}</span>
                    <span style={{ textAlign: "right", color: toneOf(d) }}>{pct(d, 2, true)}</span>
                    <span className="m-ink2" style={{ textAlign: "right" }}>
                      {r?.beta == null ? "—" : r.beta.toFixed(2)}
                    </span>
                    <span className="m-ink2" style={{ textAlign: "right" }}>
                      {pct(r?.risk_share, 1)}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
        {book === "fund" && fund?.cash != null && value ? (
          <p className="m-note">
            Cash {fullMoney(fund.cash, market)} ({pct(fund.cash / value, 1)}) is undeployed mandate capital.
          </p>
        ) : null}
      </section>

      {book === "advisory" && <TradesSection market={market} nonce={nonce} />}

      {full && <FullDetail weighted={weighted} risk={risk} indexName={index.name} />}

      <div style={{ marginTop: 48 }}>
        <PlanSection market={market} book={book} targetTe={budget} />
      </div>

      {book === "fund" ? (
        <section style={{ marginTop: 48 }}>
          <div className="m-shead">
            <h2 className="m-h2">Mandate and risk budget</h2>
            <span className="m-meta">capital base · target tracking error · deployment</span>
          </div>
          <div className="m-compat">
            <FundMandatePanel market={market} />
          </div>
        </section>
      ) : (
        <Sources market={market} horizon={horizon} onSynced={() => (refreshHorizon(), setNonce((n) => n + 1))} />
      )}
    </div>
  );
}

const TRADES_SHOWN = 12;

/** A trade in its own currency: a Trading 212 fill is in euros on the US desk. */
function tradeMoney(v: number, ccy: string, dp = 2): string {
  try {
    return v.toLocaleString(ccy === "INR" ? "en-IN" : "en-US", {
      style: "currency",
      currency: ccy,
      minimumFractionDigits: dp,
      maximumFractionDigits: dp,
    });
  } catch {
    return `${v.toFixed(dp)} ${ccy}`;
  }
}

function tradeDate(iso: string): string {
  const d = new Date(iso);
  return Number.isFinite(d.getTime())
    ? d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
    : "—";
}

function TradesSection({ market, nonce }: { market: Market; nonce: number }) {
  const [all, setAll] = useState(false);
  const trades = useLoad(() => listAdvisoryTrades(200, market), [market, nonce], [] as AdvisoryTrade[]);
  const shown = trades ? (all ? trades : trades.slice(0, TRADES_SHOWN)) : [];
  const cols = "minmax(96px,0.9fr) minmax(120px,1.6fr) 44px repeat(3,minmax(76px,1fr)) minmax(80px,0.9fr)";
  return (
    <section style={{ marginTop: 44 }}>
      <div className="m-shead">
        <h2 className="m-h2">Trades</h2>
        <span className="m-meta">From Horizon · in each trade&apos;s own currency</span>
      </div>
      {trades == null ? (
        <p className="m-empty">Loading…</p>
      ) : trades.length === 0 ? (
        <p className="m-empty">No trades synced yet: Sync now under Sources brings in Horizon&apos;s trade log.</p>
      ) : (
        <>
          <div style={{ overflowX: "auto" }}>
            <div style={{ minWidth: 680 }}>
              <div className="m-tr head" style={{ gridTemplateColumns: cols }}>
                <span>Date</span>
                <span>Name</span>
                <span>Side</span>
                <span className="r">Quantity</span>
                <span className="r">Price</span>
                <span className="r">Amount</span>
                <span className="r">Broker</span>
              </div>
              {shown.map((t) => (
                <div key={t.$id} className="m-tr" style={{ gridTemplateColumns: cols }}>
                  <span className="m-ink2">{tradeDate(t.executed_at)}</span>
                  <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {t.kind === "fund" && t.label ? (
                      <span style={{ fontWeight: 600 }}>{t.label}</span>
                    ) : (
                      <>
                        <span style={{ fontWeight: 600 }}>{t.ticker}</span> {t.label && <span className="m-meta">{t.label}</span>}
                      </>
                    )}
                  </span>
                  <span style={{ color: t.side === "buy" ? "var(--up)" : "var(--down)" }}>{t.side === "buy" ? "Buy" : "Sell"}</span>
                  <span className="r">{t.qty.toLocaleString("en-US", { maximumFractionDigits: 4 })}</span>
                  <span className="r m-ink2">{t.price == null ? "—" : tradeMoney(t.price, t.currency)}</span>
                  <span className="r">
                    {tradeMoney(t.amount, t.currency, 0)}
                    {t.estimated && (
                      <span className="m-meta" title="A SIP or share-plan instalment Horizon priced off the day's close or NAV, not a broker fill">
                        {" "}
                        est.
                      </span>
                    )}
                  </span>
                  <span className="r m-ink2">{t.broker}</span>
                </div>
              ))}
            </div>
          </div>
          {trades.length > TRADES_SHOWN && (
            <p className="m-note">
              <button className="m-link" onClick={() => setAll((v) => !v)}>
                {all ? "Show fewer" : `Show all ${trades.length}${trades.length === 200 ? " most recent" : ""}`}
              </button>
            </p>
          )}
        </>
      )}
    </section>
  );
}

function FullDetail({
  weighted,
  risk,
  indexName,
}: {
  weighted: { p: Position; w: number }[];
  risk: { row: RiskReport; p: RiskReportPayload } | null;
  indexName: string;
}) {
  const expo = exposures(weighted);
  const span = Math.max(1, ...expo.map((x) => Math.abs(x.v)));
  const stress = risk?.p.stress ?? [];
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,340px),1fr))", gap: 48, marginTop: 48 }}>
      <section>
        <h2 className="m-h2" style={{ margin: "0 0 8px", fontSize: 22 }}>
          Factor exposure
        </h2>
        {expo.length === 0 ? (
          <p className="m-empty">No factor betas stored on these holdings yet.</p>
        ) : (
          expo.map((x) => {
            const w = (Math.abs(x.v) / span) * 50;
            const color = x.v >= 0 ? "var(--accent)" : "var(--down)";
            return (
              <div
                key={x.factor}
                style={{
                  display: "grid",
                  gridTemplateColumns: "minmax(0,1.2fr) minmax(80px,1fr) 52px",
                  gap: 12,
                  alignItems: "center",
                  padding: "7px 0",
                  borderBottom: "1px solid var(--line)",
                  fontSize: 13,
                }}
              >
                <span>{FACTOR_LABELS[x.factor] ?? x.factor}</span>
                <span style={{ position: "relative", height: 6, background: "var(--sunk)", borderRadius: 3 }}>
                  <span style={{ position: "absolute", left: "50%", top: -3, bottom: -3, width: 1, background: "var(--line-2)" }} />
                  <span
                    style={{
                      position: "absolute",
                      top: 0,
                      bottom: 0,
                      left: x.v >= 0 ? "50%" : `${50 - w}%`,
                      width: `${w}%`,
                      background: color,
                      borderRadius: 3,
                    }}
                  />
                </span>
                <span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color }}>{x.v.toFixed(2)}</span>
              </div>
            );
          })
        )}
      </section>
      <section>
        <h2 className="m-h2" style={{ margin: "0 0 8px", fontSize: 22 }}>
          Stress replays
        </h2>
        {stress.length === 0 ? (
          <p className="m-empty">No stress windows measured on this book yet.</p>
        ) : (
          <>
            {stress.map((s) => (
              <div key={s.label} style={{ padding: "12px 0", borderBottom: "1px solid var(--line)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 14 }}>
                  <span style={{ fontWeight: 600 }}>{s.label}</span>
                  <span className="m-meta">
                    {s.peak} → {s.trough}
                  </span>
                </div>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "minmax(0,1fr) 64px",
                    gap: 10,
                    padding: "4px 0 0",
                    fontSize: 13,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  <span className="m-ink2">Today&apos;s book</span>
                  <span style={{ textAlign: "right", color: toneOf(s.book_return) }}>{pct(s.book_return, 1, true)}</span>
                  <span className="m-ink2">{indexName}</span>
                  <span style={{ textAlign: "right", color: toneOf(s.index_return) }}>{pct(s.index_return, 1, true)}</span>
                </div>
                {(s.uncovered_weight ?? 0) > 0 && (
                  <div className="m-meta" style={{ marginTop: 4 }}>
                    {pct(s.uncovered_weight, 0)} of the book wasn&apos;t trading then and is left out
                  </div>
                )}
              </div>
            ))}
            <p className="m-note">Today&apos;s weights replayed over each historical drawdown of the index.</p>
          </>
        )}
      </section>
    </div>
  );
}

function Sources({
  market,
  horizon,
  onSynced,
}: {
  market: Market;
  horizon: ReturnType<typeof useHorizonStatus>["status"];
  onSynced: () => void;
}) {
  if (!horizon) return null;
  return (
    <section style={{ marginTop: 48 }}>
      <div className="m-shead">
        <h2 className="m-h2">Sources</h2>
        <span className="m-meta">{horizon.configured ? "Horizon · source of record · read-only" : market === "IN" ? "Horizon · not configured" : "Interactive Brokers"}</span>
      </div>
      <div className="m-compat">
        {horizon.configured ? (
          <HorizonSourcePanel market={market} status={horizon} onSynced={onSynced} />
        ) : market === "IN" ? (
          <p className="m-sub">
            The India book comes from Horizon. Set HORIZON_URL and HORIZON_EXPORT_TOKEN on the server, then sync from here.
          </p>
        ) : (
          <IbkrAccountsPanel />
        )}
      </div>
    </section>
  );
}
