"use client";

import { useState } from "react";
import { useDesk } from "../Shell";
import { useMarket } from "../MarketContext";
import { latestHalt, latestRiskReport, listRiskHistory } from "@/lib/appwrite/queries";
import type { RiskReport, RiskReportPayload } from "@/lib/appwrite/schema";
import type { Market } from "@/lib/meridian/format";
import { nextDeskRun, prevDeskRun, runLabel } from "@/lib/meridian/schedule";
import { LineChart, shortDate } from "./Chart";
import { ago, clockOrDate, money, pct, toneOf, useLoad, useOnboard } from "./data";

type Book = RiskReport["book"];

const num = (x: number | null | undefined, dp = 2) => (x == null ? "—" : x.toFixed(dp));

function parse(row: RiskReport | null): RiskReportPayload | null {
  if (!row) return null;
  try {
    return JSON.parse(row.report_json) as RiskReportPayload;
  } catch {
    return null;
  }
}

export function RiskScreen() {
  const { market } = useMarket();
  const { full } = useDesk();
  const [book, setBook] = useState<Book>("fund");
  const got = useLoad(
    () =>
      latestRiskReport(market, book).then(
        (row) => ({ row, error: null as string | null }),
        (e: Error) => ({ row: null, error: e?.message ?? String(e) }),
      ),
    [market, book],
    { row: null, error: null },
  );
  const row = got?.row ?? null;
  const r = parse(row);
  const onboard = useOnboard();
  const target = onboard?.budgets[market]?.target_te ?? null;
  const halt = useLoad(() => (book === "fund" ? latestHalt(market) : Promise.resolve(null)), [market, book], null);
  const haltNow = halt && Date.parse(halt.occurred_at) >= prevDeskRun(market).getTime() ? halt : null;

  const seg = (
    <div className="m-seg" role="group" aria-label="Book">
      <button aria-pressed={book === "fund"} onClick={() => setBook("fund")}>
        Fund
      </button>
      <button aria-pressed={book === "advisory"} onClick={() => setBook("advisory")}>
        Advisory
      </button>
    </div>
  );

  if (!got || !row || !r) {
    const msg = !got
      ? "Loading…"
      : got.error
        ? `Couldn't read risk reports: ${got.error}`
        : row
          ? "The stored report couldn't be read."
          : `No ${book} risk report for this desk yet. Each desk run measures both books; the next ${market === "IN" ? "India" : "US"} run is ${runLabel(nextDeskRun(market))}.`;
    return (
      <div>
        <div style={{ marginBottom: 24 }}>{seg}</div>
        <p className="m-empty">{msg}</p>
        {got && !got.error && !row && (
          <p className="m-meta">
            To measure now from your Mac: <span className="m-mono">npx tsx --env-file=.env.local scripts/risk-report.ts {market} {book}</span>
          </p>
        )}
      </div>
    );
  }

  const nav = r.nav ?? row.nav;
  const unm = r.unmeasured_weight ?? 0;
  const stats: [string, string, string][] = [
    [
      "1-day VaR 95%",
      pct(r.var95.parametric),
      `${r.var95.parametric == null ? "" : `${money(r.var95.parametric * nav, market)} · `}historical ${pct(r.var95.historical)}`,
    ],
    [
      `Tracking error vs ${r.index}`,
      pct(r.tracking_error),
      `${target != null ? `budget ${pct(target)} · ` : ""}beta ${num(r.beta)} · book vol ${pct(r.vol_annual)}`,
    ],
    ["Expected shortfall 95%", pct(r.es95.parametric), `historical ${pct(r.es95.historical)}`],
    ["NAV", money(nav, market), `cash ${pct(r.cash_weight, 1)} · measured ${pct(r.measured_weight, 1)}`],
  ];
  const names = full ? r.names : r.names.slice(0, 5);
  const top = Math.max(...r.names.map((n) => Math.abs(n.risk_share ?? 0)), 1e-9);
  const liq = r.names.filter((n) => n.adv_days != null).sort((a, b) => (b.adv_days ?? 0) - (a.adv_days ?? 0));
  const noVolume = r.names.filter((n) => n.adv_days == null);
  const details: [string, string, string?][] = [
    ["VaR 99%", `${pct(r.var99.parametric)} · hist ${pct(r.var99.historical)}`],
    ["ES 99%", `${pct(r.es99.parametric)} · hist ${pct(r.es99.historical)}`],
    ["Cash", pct(r.cash_weight, 1)],
    ["Measured", pct(r.measured_weight, 1)],
    ["Unmeasured", pct(unm, 1), unm ? "var(--warn)" : undefined],
    ["Window", `${r.window.start} → ${r.window.end} (${r.window.observations} days)`],
    ["Shrinkage", `${num(r.shrinkage)} toward identity`],
    ["Index vol", pct(r.index_vol)],
    ["Marks", r.marks],
  ];
  const NAME_COLS = "minmax(72px,1fr) 60px minmax(80px,2fr) 56px 56px 44px";

  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "10px 16px", marginBottom: 24 }}>
        {seg}
        <span className="m-meta m-mono">
          {row.session} · measured {ago(row.captured_at)} ago
        </span>
        {unm > 0 && <span className="m-tag warn">{pct(unm, 1)} unmeasured</span>}
      </div>

      <Verdict te={r.tracking_error} target={target} cash={r.cash_weight} index={r.index} haltAt={haltNow?.occurred_at ?? null} haltWhy={haltNow?.detail ?? null} />

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,210px),1fr))",
          borderTop: "1px solid var(--line)",
          borderBottom: "1px solid var(--line)",
        }}
      >
        {stats.map(([k, v, sub]) => (
          <div key={k} style={{ padding: "16px 20px 16px 0" }}>
            <div className="m-sub">{k}</div>
            <div className="m-big" style={{ fontSize: "clamp(30px,3.4vw,40px)", lineHeight: 1.15 }}>
              {v}
            </div>
            <div className="m-meta" style={{ textWrap: "pretty" }}>
              {sub}
            </div>
          </div>
        ))}
      </div>

      <History market={market} book={book} target={target} />

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,380px),1fr))",
          gap: 48,
          alignItems: "start",
          marginTop: 40,
        }}
      >
        <section style={{ minWidth: 0 }}>
          <div className="m-shead">
            <h2 className="m-h2">Where the risk sits</h2>
            <span className="m-meta">{r.names.length} names</span>
          </div>
          {r.names.length === 0 ? (
            <p className="m-empty">
              No measured positions: the book&apos;s risk is its cash. Against {r.index} that leaves a tracking error equal to the
              index&apos;s own volatility ({pct(r.index_vol)}).
            </p>
          ) : (
            <>
              <div style={{ overflowX: "auto" }}>
                <div style={{ minWidth: 460 }}>
                  <div className="m-tr head" style={{ gridTemplateColumns: NAME_COLS }}>
                    <span>Name</span>
                    <span className="r">Weight</span>
                    <span>Share of risk</span>
                    <span className="r">Risk</span>
                    <span className="r">TE</span>
                    <span className="r">Beta</span>
                  </div>
                  {names.map((n) => (
                    <div
                      key={n.ticker}
                      className="m-tr"
                      style={{ gridTemplateColumns: NAME_COLS, alignItems: "center", padding: "10px 0", fontSize: 13 }}
                    >
                      <span style={{ fontWeight: 600 }}>{n.ticker}</span>
                      <span className="r m-ink2">{pct(n.weight, 1)}</span>
                      <span className="m-bar" style={{ height: 6, borderRadius: 3 }}>
                        <i
                          style={{
                            width: `${(Math.abs(n.risk_share ?? 0) / top) * 100}%`,
                            background: (n.risk_share ?? 0) < 0 ? "var(--ink-3)" : undefined,
                          }}
                        />
                      </span>
                      <span className="r">{pct(n.risk_share, 1)}</span>
                      <span className="r m-ink2">{pct(n.te_share, 1)}</span>
                      <span className="r m-ink2">{num(n.beta)}</span>
                    </div>
                  ))}
                </div>
              </div>
              <p className="m-note">
                Risk shares sum to 100% over names. TE shares sum to 100% with the index&apos;s own share (
                {pct(r.index_te_share, 1)}), the part of tracking variance from {r.index} weight not held. A negative share
                hedges.
                {!full && r.names.length > 5 ? " Showing the top 5; switch to Full detail for all names." : ""}
              </p>
            </>
          )}
        </section>

        <section style={{ minWidth: 0 }}>
          <div className="m-shead">
            <h2 className="m-h2">Stress replays</h2>
            <span className="m-meta">{r.index}</span>
          </div>
          {r.stress.length === 0 ? (
            <p className="m-empty">The index history doesn&apos;t reach the replay years.</p>
          ) : (
            <>
              {r.stress.map((s) => (
                <div key={s.label} style={{ padding: "12px 0", borderBottom: "1px solid var(--line)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 14 }}>
                    <span style={{ fontWeight: 600 }}>{s.label}</span>
                    <span className="m-meta m-mono">
                      {s.peak} → {s.trough}
                    </span>
                  </div>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(3,minmax(0,1fr))",
                      gap: 12,
                      marginTop: 6,
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {(
                      [
                        [r.index, pct(s.index_return, 1), toneOf(s.index_return)],
                        ["This book", pct(s.book_return, 1), toneOf(s.book_return)],
                        ["Not covered", pct(s.uncovered_weight, 1), "var(--ink-2)"],
                      ] as const
                    ).map(([k, v, c]) => (
                      <div key={k}>
                        <div className="m-meta" style={{ fontSize: 11 }}>
                          {k}
                        </div>
                        <div style={{ fontSize: 16, fontWeight: 500, color: c }}>{v}</div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
              <p className="m-note">
                Today&apos;s book replayed over the index&apos;s peak-to-trough in each year. Names not trading at the peak are not
                covered and count as flat.
              </p>
            </>
          )}
        </section>
      </div>

      {full && (
        <div
          style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,340px),1fr))", gap: 48, marginTop: 48 }}
        >
          <section>
            <h2 className="m-h2" style={{ margin: "0 0 6px", fontSize: 22 }}>
              Measurement
            </h2>
            {details.map(([k, v, c]) => (
              <div
                key={k}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 12,
                  padding: "9px 0",
                  borderBottom: "1px solid var(--line)",
                  fontSize: 13,
                }}
              >
                <span className="m-ink2">{k}</span>
                <span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: c }}>{v}</span>
              </div>
            ))}
            <p className="m-note">
              Parametric figures use a shrunk covariance of daily returns and today&apos;s weights; historical ones replay
              today&apos;s weights over the window. Cash counts as zero risk. Unmeasured names carry no history over the window and
              are left out, never proxied, so the figures cover the measured weight only.
            </p>
          </section>
          <section>
            <div className="m-shead">
              <h2 className="m-h2" style={{ fontSize: 22 }}>
                Liquidity
              </h2>
              <span className="m-meta">days of ADV</span>
            </div>
            {liq.length === 0 ? (
              <p className="m-empty">No positions to exit.</p>
            ) : (
              <>
                {liq.map((n) => (
                  <div
                    key={n.ticker}
                    className="m-tr"
                    style={{ gridTemplateColumns: "minmax(0,1fr) 90px 50px", padding: "9px 0", fontSize: 13 }}
                  >
                    <span style={{ fontWeight: 600 }}>{n.ticker}</span>
                    <span className="r">{(n.adv_days ?? 0) < 0.01 ? "<0.01" : num(n.adv_days)}</span>
                    <span className="r m-ink3">{n.missing_days ? `${n.missing_days}d` : "—"}</span>
                  </div>
                ))}
                <p className="m-note">
                  Shares held over 20-session average daily volume, at the whole day&apos;s volume. Gaps are window sessions the
                  name didn&apos;t print.
                </p>
              </>
            )}
            {noVolume.length > 0 && <p className="m-note">No volume reported: {noVolume.map((n) => n.ticker).join(", ")}.</p>}
            {r.unmeasured.length > 0 && (
              <>
                <div className="m-sub" style={{ marginTop: 20, fontSize: 12, fontWeight: 600 }}>
                  Unmeasured · {pct(unm, 1)} of NAV
                </div>
                {r.unmeasured.map((u) => (
                  <div
                    key={u.ticker}
                    className="m-tr"
                    style={{ gridTemplateColumns: "auto 50px minmax(0,1fr)", padding: "9px 0", fontSize: 13 }}
                  >
                    <span style={{ fontWeight: 600 }}>{u.ticker}</span>
                    <span>{pct(u.weight, 1)}</span>
                    <span className="m-ink3">{u.reason}</span>
                  </div>
                ))}
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

/** The book against its risk budget, in one line, and any halt this session. */
function Verdict({
  te,
  target,
  cash,
  index,
  haltAt,
  haltWhy,
}: {
  te: number | null;
  target: number | null;
  cash: number | null;
  index: string;
  haltAt: string | null;
  haltWhy: string | null;
}) {
  const lines: [string, string][] = [];
  if (haltAt) lines.push(["var(--down)", `Fills halted since ${clockOrDate(haltAt)}. ${haltWhy ?? ""}`]);
  if (target == null) lines.push(["var(--warn)", "No risk budget set: trades stage for review and the plan sizes nothing. Set one in the mandate on the Book."]);
  else if (te == null) lines.push(["var(--warn)", "Tracking error isn't measured, so trades can't be checked against the budget."]);
  else if (te > target)
    lines.push([
      "var(--down)",
      `Over budget: tracking error ${pct(te)} against ${pct(target)}. A trade that adds to it won't pass.${
        (cash ?? 0) > 0.5 ? ` Most of the book is cash (${pct(cash, 0)}), which trails the ${index} by its full volatility; filling the index core closes most of the gap.` : ""
      }`,
    ]);
  else lines.push(["var(--up)", `Within budget: tracking error ${pct(te)} against ${pct(target)}, ${pct(target - te)} of room.`]);
  return (
    <div style={{ margin: "0 0 20px" }}>
      {lines.map(([c, t]) => (
        <div key={t} style={{ display: "flex", gap: 10, alignItems: "baseline", padding: "8px 0", fontSize: 14 }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: c, flex: "none", transform: "translateY(-1px)" }} />
          <span style={{ textWrap: "pretty" }}>{t}</span>
        </div>
      ))}
    </div>
  );
}

/** Tracking error by session against today's budget. */
function History({ market, book, target }: { market: Market; book: RiskReport["book"]; target: number | null }) {
  const rows = useLoad(() => listRiskHistory(market, book, 90), [market, book], [] as RiskReport[]);
  const pts = (rows ?? []).filter((x) => x.tracking_error != null).map((x) => ({ t: x.captured_at, v: x.tracking_error! * 100 }));
  if (pts.length < 2) return null;
  return (
    <section style={{ marginTop: 36 }}>
      <div className="m-shead">
        <h2 className="m-h2">Tracking error over time</h2>
        <span className="m-meta">
          {pts.length} sessions from {shortDate(pts[0].t)}
          {target != null ? " · dashed: today's budget" : ""}
        </span>
      </div>
      <LineChart
        points={pts}
        color={target != null && pts[pts.length - 1].v > target * 100 ? "var(--down)" : "var(--accent)"}
        name="Tracking error"
        compare={target != null ? { name: "Budget", color: "var(--ink-3)", values: pts.map(() => target * 100) } : undefined}
        height={180}
        label={(p) => (
          <>
            {shortDate(p.t)} · tracking error {p.v.toFixed(1)}%{target != null ? ` · budget ${pct(target)}` : ""}
          </>
        )}
      />
    </section>
  );
}
