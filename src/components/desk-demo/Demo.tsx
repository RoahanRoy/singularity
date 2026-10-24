"use client";

// The desk on sample data, for the landing page and the guided tour. It reuses
// the real shell markup and desk.css, pinned to the 1280×800 desktop layout
// (demo.css); DemoFrame scales it to fit. Decisions, nav and filters work
// locally; nothing reads or writes the real desk.

import "@/app/desk/desk.css";
import "./demo.css";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Theme } from "@/lib/meridian/theme";
import { LineChart } from "@/components/meridian/desk/Chart";
import { lagLimit, Z99 } from "@/lib/fund/risk-budget";
import { TRADING_DAYS } from "@/lib/quant/risk";
import * as S from "./sample";

export type DemoScreen = "today" | "book" | "risk" | "research" | "agents" | "console" | "log";

const NAV_GROUPS: [string, [DemoScreen, string, string][]][] = [
  ["Monitor", [["today", "Today", "today"], ["book", "Book", "account_balance"], ["risk", "Risk", "shield"]]],
  ["Decide", [["research", "Research", "description"]]],
  ["Operate", [["agents", "Agents", "hub"], ["console", "Console", "forum"]]],
  ["Record", [["log", "Audit log", "history"]]],
];

const usd = (v: number) => "$" + Math.round(v).toLocaleString("en-US");
const short = (v: number) => (Math.abs(v) >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : usd(v));
const pct = (v: number, d = 1, sign = false) => `${sign && v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v * 100).toFixed(d)}%`;
const tone = (v: number) => (v > 0 ? "var(--up)" : v < 0 ? "var(--down)" : "var(--ink-2)");

function Icon({ name }: { name: string }) {
  return (
    <span className="m-icon" aria-hidden>
      {name}
    </span>
  );
}

function Kv({ k, v, c }: { k: string; v: string; c?: string }) {
  return (
    <div className="m-kv">
      <span>{k}</span>
      <span style={{ color: c }}>{v}</span>
    </div>
  );
}

type Decision = "review" | "approved" | "declined";

export function DeskDemo({
  theme,
  screen: initial = "today",
  onToggleTheme,
}: {
  theme: Theme;
  screen?: DemoScreen;
  onToggleTheme?: () => void;
}) {
  const [screen, setScreen] = useState<DemoScreen>(initial);
  const [full, setFull] = useState(false);
  const [decided, setDecided] = useState<Record<string, Decision>>({});
  const body = useRef<HTMLDivElement>(null);
  const pending = S.PROPOSALS.filter((p) => (decided[p.id] ?? "review") === "review").length;
  const [crumb, items] = NAV_GROUPS.find(([, it]) => it.some(([s]) => s === screen))!;
  const title = items.find(([s]) => s === screen)![1];

  const go = (s: DemoScreen) => {
    setScreen(s);
    body.current?.scrollTo(0, 0);
  };
  const decide = (id: string, d: Decision) => setDecided((p) => ({ ...p, [id]: d }));

  return (
    <div className="mx m-embed" data-theme={theme}>
      <aside className="m-side">
        <div className="m-brand">
          <span className="m-mark" aria-hidden />
          <span>Meridian</span>
        </div>
        <div className="m-seg" role="group" aria-label="Market">
          <button aria-pressed>US</button>
          <button aria-pressed={false} disabled title="The sample covers the US desk">
            India
          </button>
        </div>
        <nav className="m-nav" aria-label="Desk sections">
          {NAV_GROUPS.map(([label, its]) => (
            <div className="grp" key={label}>
              <div className="m-label">{label}</div>
              {its.map(([id, lab, icon]) => (
                <button key={id} onClick={() => go(id)} aria-current={screen === id ? "page" : undefined}>
                  <Icon name={icon} />
                  <span style={{ flex: 1 }}>{lab}</span>
                  {id === "today" && pending > 0 && <span className="m-badge">{pending}</span>}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="m-foot">
          <span className="m-avatar">OP</span>
          <div className="who">
            <div>Operator</div>
            <span className="m-meta">Sample desk</span>
          </div>
          {onToggleTheme && (
            <button className="m-sq" onClick={onToggleTheme} aria-label={theme === "dark" ? "Switch to light" : "Switch to dark"}>
              <Icon name={theme === "dark" ? "light_mode" : "dark_mode"} />
            </button>
          )}
        </div>
      </aside>

      <main className="m-main" ref={body}>
        <header className="m-head">
          <div className="m-head-in">
            <div style={{ minWidth: 0, marginRight: "auto" }}>
              <div className="m-meta">
                {crumb}
                <span className="m-tag warn m-sample">Sample data</span>
              </div>
              <h1>{title}</h1>
            </div>
            <div className="m-status">
              <span className="m-dot" style={{ background: "var(--up)" }} />
              <span>Market open · NYSE</span>
              <span className="m-mono m-ink3">10:58 ET</span>
            </div>
            <div className="m-seg" role="group" aria-label="Detail level">
              <button aria-pressed={!full} onClick={() => setFull(false)}>
                Essentials
              </button>
              <button aria-pressed={full} onClick={() => setFull(true)}>
                Full detail
              </button>
            </div>
          </div>
        </header>
        <div className="m-body">
          {screen === "today" && <Today decided={decided} decide={decide} pending={pending} go={go} />}
          {screen === "book" && <Book />}
          {screen === "risk" && <Risk full={full} />}
          {screen === "research" && <Research />}
          {screen === "agents" && <Agents full={full} go={go} />}
          {screen === "console" && <Console />}
          {screen === "log" && <Log />}
        </div>
      </main>
    </div>
  );
}

/* ── Today ─────────────────────────────────────────────────────────────── */

function Today({
  decided,
  decide,
  pending,
  go,
}: {
  decided: Record<string, Decision>;
  decide: (id: string, d: Decision) => void;
  pending: number;
  go: (s: DemoScreen) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const rows = S.PROPOSALS.filter((p) => decided[p.id] !== "declined");
  const rules = [
    `Tracking error target ${pct(S.TARGET_TE)} a year vs the S&P 500`,
    "A trade may not lift tracking error past the target",
    `No single name's active risk above ${pct(S.TARGET_TE)}`,
    `Halt on a day loss beyond ${Z99.toFixed(2)} × (index vol + ${pct(S.TARGET_TE)}) / √${TRADING_DAYS}`,
    `Halt when trailing the S&P 500 by ${pct(lagLimit(S.TARGET_TE, 21))} over a month`,
    "Every trade waits for your approval",
  ];

  return (
    <div className="m-cols2">
      <div className="m-stack" style={{ minWidth: 0 }}>
        <section>
          <div className="m-sub">Friday, October 23 · US fund</div>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "4px 16px", marginTop: 6 }}>
            <span className="m-big" style={{ fontSize: 56 }}>
              {usd(S.NAV)}
            </span>
            <span style={{ fontSize: 16, fontWeight: 500, color: "var(--up)", fontVariantNumeric: "tabular-nums" }}>
              +{usd(S.DAY_PNL)} ({pct(S.DAY_PNL / (S.NAV - S.DAY_PNL), 2, true)}) today
            </span>
          </div>
          <p className="m-sub" style={{ margin: "12px 0 0", maxWidth: "62ch", fontSize: 15 }}>
            {pending === 0 ? "Nothing is waiting for you." : `${pending} ${pending === 1 ? "proposal is" : "proposals are"} waiting for you.`}{" "}
            Last agent step 1m ago.
          </p>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit,minmax(86px,1fr))",
              marginTop: 22,
              borderTop: "1px solid var(--line)",
              borderBottom: "1px solid var(--line)",
            }}
          >
            {S.TICKS.map(([label, price, ch]) => (
              <div key={label} style={{ padding: "10px 12px 10px 0", fontVariantNumeric: "tabular-nums" }}>
                <div className="m-meta">{label}</div>
                <div style={{ fontSize: 14, fontWeight: 500 }}>{price.toLocaleString("en-US", { maximumFractionDigits: 2 })}</div>
                <div style={{ fontSize: 12, color: tone(ch) }}>{pct(ch / 100, 2, true)}</div>
              </div>
            ))}
          </div>
        </section>

        <section>
          <div className="m-shead">
            <h2 className="m-h2">Needs your decision</h2>
            <span className="m-meta">Every trade asks for review</span>
          </div>
          {rows.length === 0 && (
            <p className="m-empty">Nothing needs you right now. The next proposal will appear here and in the sidebar badge.</p>
          )}
          {rows.map((p) => {
            const approved = decided[p.id] === "approved";
            const isOpen = open === p.id;
            const plan: [string, string, string?][] = [
              ["Order", `Buy ${p.qty.toLocaleString()} ${p.ticker}`],
              ["Size", `${p.weight.toFixed(2)}% of NAV`],
              ["Route", p.route],
              ["Arrival price", p.arrival],
              ["Pre-trade risk gate", "Passed", "var(--up)"],
              ["Compliance", "Passed", "var(--up)"],
            ];
            return (
              <div key={p.id} style={{ borderTop: "1px solid var(--line)", padding: "14px 0" }}>
                <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "10px 16px" }}>
                  <button
                    onClick={() => setOpen(isOpen ? null : p.id)}
                    aria-expanded={isOpen}
                    style={{
                      flex: "1 1 280px",
                      minWidth: 0,
                      display: "flex",
                      flexDirection: "column",
                      gap: 2,
                      border: 0,
                      background: "transparent",
                      padding: 0,
                      cursor: "pointer",
                      textAlign: "left",
                    }}
                  >
                    <span style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
                      <span style={{ fontWeight: 600, fontSize: 16 }}>{p.ticker}</span>
                      <span style={{ fontWeight: 600, fontVariantNumeric: "tabular-nums", color: "var(--up)" }}>
                        Buy {p.weight.toFixed(2)}%
                      </span>
                      <span className={`m-tag ${approved ? "up" : "accent"}`}>{approved ? "Approved" : "Review"}</span>
                    </span>
                    <span className="m-sub">{p.thesis}</span>
                    <span className="m-meta">
                      Conviction {p.conviction.toFixed(2)} · held {p.held}
                    </span>
                  </button>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    {approved ? (
                      <>
                        <span style={{ fontSize: 13, fontWeight: 500, color: "var(--up)" }}>Approved · fills next sweep</span>
                        <button className="m-link" onClick={() => decide(p.id, "review")}>
                          Undo
                        </button>
                      </>
                    ) : (
                      <button className="m-btn2" onClick={() => setOpen(isOpen ? null : p.id)}>
                        {isOpen ? "Close" : "Review plan"}
                      </button>
                    )}
                  </div>
                </div>
                {isOpen && !approved && (
                  <div className="m-card" style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 14 }}>
                    <div>
                      <div className="m-label" style={{ marginBottom: 4 }}>
                        Action plan
                      </div>
                      {plan.map(([k, v, c], i) => (
                        <div
                          key={k}
                          style={{
                            display: "grid",
                            gridTemplateColumns: "22px minmax(0,1fr) auto",
                            gap: 10,
                            padding: "6px 0",
                            borderBottom: "1px solid var(--line)",
                            fontSize: 13,
                          }}
                        >
                          <span className="m-mono m-ink3">{i + 1}</span>
                          <span>{k}</span>
                          <span style={{ color: c ?? "var(--ink)", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{v}</span>
                        </div>
                      ))}
                    </div>
                    <button className="m-link" style={{ alignSelf: "flex-start" }} onClick={() => go("research")}>
                      Thesis: {p.title}&nbsp;→
                    </button>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button
                        className="m-btn"
                        onClick={() => {
                          decide(p.id, "approved");
                          setOpen(null);
                        }}
                      >
                        Approve buy {p.qty.toLocaleString()}
                      </button>
                      <button
                        className="m-btn2"
                        onClick={() => {
                          decide(p.id, "declined");
                          setOpen(null);
                        }}
                      >
                        Decline
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </section>

        <section>
          <div className="m-shead">
            <h2 className="m-h2">Since you last looked</h2>
            <button className="m-link" onClick={() => go("agents")}>
              All agent activity →
            </button>
          </div>
          {S.FEED.map(([t, who, what]) => (
            <div
              key={t + who}
              style={{ display: "grid", gridTemplateColumns: "48px minmax(0,1fr)", gap: 12, padding: "11px 0", borderTop: "1px solid var(--line)", fontSize: 13 }}
            >
              <span className="m-mono m-ink3" style={{ fontSize: 12 }}>
                {t}
              </span>
              <span>
                <span style={{ fontWeight: 600 }}>{who}</span> <span className="m-ink2">{what}</span>
              </span>
            </div>
          ))}
        </section>
      </div>

      <aside className="m-aside">
        <section className="m-card" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className={`m-dot${paused ? "" : " m-pulse"}`} style={{ background: paused ? "var(--warn)" : "var(--up)" }} />
            <span style={{ fontWeight: 600 }}>{paused ? "Agents are paused" : "Agents are working"}</span>
          </div>
          <div className="m-sub">{paused ? "0" : "3"} of 3 workers running. Last step 1m ago.</div>
          <div className="m-kv" style={{ borderTop: 0, padding: 0, fontSize: 12 }}>
            <span>Inference spend today</span>
            <span>${S.SPEND[0][1].toFixed(2)}</span>
          </div>
          <button className="m-btn2" onClick={() => setPaused(!paused)}>
            {paused ? "Resume agents" : "Pause all agents"}
          </button>
        </section>
        <section>
          <div className="m-shead" style={{ marginBottom: 6 }}>
            <h3 className="m-h3">Recent actions</h3>
            <button className="m-link" onClick={() => go("log")}>
              Audit log →
            </button>
          </div>
          {S.RECENT.map(([a, d, meta, blocked]) => (
            <div key={meta} style={{ padding: "9px 0", borderTop: "1px solid var(--line)", fontSize: 13 }}>
              <div>
                <span style={{ fontWeight: 600, color: blocked ? "var(--down)" : undefined }}>{a}</span> <span className="m-ink2">{d}</span>
              </div>
              <div className="m-meta">{meta}</div>
            </div>
          ))}
        </section>
        <section>
          <div className="m-shead" style={{ marginBottom: 6 }}>
            <h3 className="m-h3">Guardrails</h3>
            <button className="m-link" onClick={() => go("book")}>
              Edit →
            </button>
          </div>
          {rules.map((r) => (
            <div key={r} style={{ display: "flex", gap: 8, alignItems: "baseline", padding: "6px 0", borderTop: "1px solid var(--line)", fontSize: 13 }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--up)", flex: "none", transform: "translateY(-1px)" }} />
              {r}
            </div>
          ))}
        </section>
      </aside>
    </div>
  );
}

/* ── Book ──────────────────────────────────────────────────────────────── */

const PATH = S.NAV_PATH.map((v, i) => ({ t: new Date(Date.UTC(2026, 6, 24) + i * 1.4 * 864e5).toISOString(), v }));

function Book() {
  const [book, setBook] = useState<"fund" | "advisory">("fund");
  const first = PATH[0].v;
  const last = PATH[PATH.length - 1].v;
  const metrics: [string, string, string?][] = [
    ["Return · 3M", pct(last / first - 1, 2, true), "var(--up)"],
    ["S&P 500", "+4.12%", "var(--up)"],
    ["Max drawdown", "2.3%"],
    ["Volatility (ann.)", "11.8%"],
    ["Sharpe", "1.62"],
  ];
  const COLS = "minmax(120px,1.6fr) repeat(4,minmax(70px,1fr))";
  const date = (t: string) => new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

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

      {book === "advisory" ? (
        <p className="m-empty">
          On a live desk, holdings from IBKR (US) or Horizon (India) sync here read-only, under Sources. The sample has none.
        </p>
      ) : (
        <>
          <section>
            <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 12 }}>
              <div>
                <div className="m-sub">Net asset value</div>
                <div className="m-big" style={{ fontSize: 48, lineHeight: 1.1 }}>
                  {usd(S.NAV)}
                </div>
                <div style={{ fontSize: 15, fontWeight: 500, color: "var(--up)", fontVariantNumeric: "tabular-nums" }}>
                  +{short(S.DAY_PNL)} ({pct(S.DAY_PNL / (S.NAV - S.DAY_PNL), 2, true)}) at the last mark
                </div>
              </div>
              <div className="m-seg sm" role="group" aria-label="Range">
                {["1M", "3M", "YTD", "1Y"].map((r) => (
                  <button key={r} aria-pressed={r === "3M"}>
                    {r}
                  </button>
                ))}
              </div>
            </div>
            <LineChart
              points={PATH}
              color="var(--up)"
              label={(p, f) => (
                <>
                  {date(p.t)} · {usd(p.v)} · {pct(p.v / f.v - 1, 2, true)} in range
                </>
              )}
            />
          </section>

          <div className="m-stats" style={{ gridTemplateColumns: "repeat(5,minmax(0,1fr))", marginTop: 28 }}>
            {metrics.map(([k, v, c]) => (
              <div key={k}>
                <div className="k">{k}</div>
                <div className="v" style={{ color: c }}>
                  {v}
                </div>
              </div>
            ))}
          </div>

          <section style={{ marginTop: 44 }}>
            <div className="m-shead">
              <h2 className="m-h2">Holdings</h2>
              <span className="m-meta">Risk measured Oct 23 · session US close</span>
            </div>
            <div className="m-tr head" style={{ gridTemplateColumns: COLS }}>
              <span>Name</span>
              <span style={{ textAlign: "right" }}>Weight</span>
              <span style={{ textAlign: "right" }}>Today</span>
              <span style={{ textAlign: "right" }}>Beta</span>
              <span style={{ textAlign: "right" }}>Share of risk</span>
            </div>
            {S.HOLDINGS.map(([t, name, w, d, b, r]) => (
              <div key={t} className="m-tr" style={{ gridTemplateColumns: COLS }}>
                <span>
                  <span style={{ fontWeight: 600 }}>{t}</span> <span className="m-meta">{name}</span>
                </span>
                <span style={{ textAlign: "right" }}>{pct(w)}</span>
                <span style={{ textAlign: "right", color: tone(d) }}>{pct(d / 100, 2, true)}</span>
                <span className="m-ink2" style={{ textAlign: "right" }}>
                  {b.toFixed(2)}
                </span>
                <span className="m-ink2" style={{ textAlign: "right" }}>
                  {pct(r)}
                </span>
              </div>
            ))}
            <p className="m-note">
              Cash {usd(S.CASH)} ({pct(S.CASH / S.NAV)}) is undeployed mandate capital.
            </p>
          </section>

          <section style={{ marginTop: 48 }}>
            <div className="m-shead">
              <h2 className="m-h2">Mandate and risk budget</h2>
              <span className="m-meta">capital base · target tracking error · deployment</span>
            </div>
            <div style={{ maxWidth: 520 }}>
              <Kv k="Capital base" v={usd(1_250_000_000)} />
              <Kv k="Target tracking error" v={`${pct(S.TARGET_TE)} a year vs the S&P 500`} />
              <Kv k="Deployed" v={pct(1 - S.CASH / S.NAV)} />
              <Kv k="Approval" v="Every trade waits for you" />
            </div>
          </section>
        </>
      )}
    </div>
  );
}

/* ── Risk ──────────────────────────────────────────────────────────────── */

function Risk({ full }: { full: boolean }) {
  const r = S.RISK;
  const stats: [string, string, string][] = [
    ["1-day VaR 95%", pct(r.var95, 2), `${short(r.var95 * S.NAV)} · historical ${pct(r.var95h, 2)}`],
    ["Tracking error vs S&P 500", pct(r.te), `beta ${r.beta.toFixed(2)} · book vol ${pct(r.vol)}`],
    ["Expected shortfall 95%", pct(r.es95, 2), `historical ${pct(r.es95h, 2)}`],
    ["NAV", short(S.NAV), `cash ${pct(S.CASH / S.NAV)} · measured ${pct(r.measured)}`],
  ];
  const top = Math.max(...r.names.map((n) => n[2]));
  const COLS = "minmax(72px,1fr) 60px minmax(80px,2fr) 56px 56px 44px";
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: "10px 16px", marginBottom: 24 }}>
        <div className="m-seg" role="group" aria-label="Book">
          <button aria-pressed>Fund</button>
          <button aria-pressed={false} disabled>
            Advisory
          </button>
        </div>
        <span className="m-meta m-mono">US close · measured 42m ago</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,minmax(0,1fr))", borderTop: "1px solid var(--line)", borderBottom: "1px solid var(--line)" }}>
        {stats.map(([k, v, sub]) => (
          <div key={k} style={{ padding: "16px 20px 16px 0" }}>
            <div className="m-sub">{k}</div>
            <div className="m-big" style={{ fontSize: 40, lineHeight: 1.15 }}>
              {v}
            </div>
            <div className="m-meta">{sub}</div>
          </div>
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: 48, alignItems: "start", marginTop: 40 }}>
        <section style={{ minWidth: 0 }}>
          <div className="m-shead">
            <h2 className="m-h2">Where the risk sits</h2>
            <span className="m-meta">{S.HOLDINGS.length} names</span>
          </div>
          <div className="m-tr head" style={{ gridTemplateColumns: COLS }}>
            <span>Name</span>
            <span className="r">Weight</span>
            <span>Share of risk</span>
            <span className="r">Risk</span>
            <span className="r">TE</span>
            <span className="r">Beta</span>
          </div>
          {r.names.map(([t, w, rs, ts, b]) => (
            <div key={t} className="m-tr" style={{ gridTemplateColumns: COLS, alignItems: "center", padding: "10px 0", fontSize: 13 }}>
              <span style={{ fontWeight: 600 }}>{t}</span>
              <span className="r m-ink2">{pct(w)}</span>
              <span className="m-bar" style={{ height: 6, borderRadius: 3 }}>
                <i style={{ width: `${(rs / top) * 100}%` }} />
              </span>
              <span className="r">{pct(rs)}</span>
              <span className="r m-ink2">{pct(ts)}</span>
              <span className="r m-ink2">{b.toFixed(2)}</span>
            </div>
          ))}
          <p className="m-note">
            Risk shares sum to 100% over names. TE shares sum to 100% with the index&apos;s own share ({pct(r.indexTeShare)}). A
            negative share hedges.{full ? "" : " Showing the top 5; switch to Full detail for liquidity."}
          </p>
        </section>
        <section style={{ minWidth: 0 }}>
          <div className="m-shead">
            <h2 className="m-h2">Stress replays</h2>
            <span className="m-meta">S&amp;P 500</span>
          </div>
          {r.stress.map(([label, peak, trough, idx, bk, unc]) => (
            <div key={label} style={{ padding: "12px 0", borderBottom: "1px solid var(--line)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 14 }}>
                <span style={{ fontWeight: 600 }}>{label}</span>
                <span className="m-meta m-mono">
                  {peak} → {trough}
                </span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3,minmax(0,1fr))", gap: 12, marginTop: 6, fontVariantNumeric: "tabular-nums" }}>
                {(
                  [
                    ["S&P 500", pct(idx), tone(idx)],
                    ["This book", pct(bk), tone(bk)],
                    ["Not covered", pct(unc), "var(--ink-2)"],
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
          <p className="m-note">Today&apos;s book replayed over the index&apos;s peak-to-trough in each year.</p>
        </section>
      </div>
      {full && (
        <section style={{ marginTop: 48, maxWidth: 520 }}>
          <div className="m-shead">
            <h2 className="m-h2" style={{ fontSize: 22 }}>
              Liquidity
            </h2>
            <span className="m-meta">days of ADV</span>
          </div>
          {[...r.names]
            .sort((a, b) => b[5] - a[5])
            .map(([t, , , , , adv]) => (
              <div key={t} className="m-tr" style={{ gridTemplateColumns: "minmax(0,1fr) 90px", padding: "9px 0", fontSize: 13 }}>
                <span style={{ fontWeight: 600 }}>{t}</span>
                <span className="r">{adv.toFixed(2)}</span>
              </div>
            ))}
          <p className="m-note">Shares held over 20-session average daily volume.</p>
        </section>
      )}
    </div>
  );
}

/* ── Research ──────────────────────────────────────────────────────────── */

function Research() {
  const [view, setView] = useState<"filings" | "quant">("filings");
  const [pick, setPick] = useState(0);
  const [ticker, form, , age] = S.INBOX[pick];
  const hasMemo = S.INBOX[pick][5];
  const m = S.MEMO;
  return (
    <div>
      <div className="m-tabs" role="tablist" aria-label="Research views" style={{ marginBottom: 24 }}>
        <button role="tab" aria-selected={view === "filings"} onClick={() => setView("filings")}>
          Filings &amp; memos
        </button>
        <button role="tab" aria-selected={view === "quant"} onClick={() => setView("quant")}>
          Quant
        </button>
      </div>
      {view === "filings" ? (
        <div className="m-split">
          <div style={{ minWidth: 0 }}>
            <div className="m-shead">
              <h2 className="m-h3">Inbox</h2>
              <span className="m-meta">
                {S.INBOX.length} documents · {S.INBOX.filter((f) => f[4]).length} on the book
              </span>
            </div>
            {S.INBOX.map(([t, f, h, a, held, memo], i) => (
              <button key={t + f} className="m-pick" aria-current={i === pick} onClick={() => setPick(i)}>
                <span style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                  <span style={{ fontSize: 14, fontWeight: 600 }}>{t}</span>
                  <span className="m-sub" style={{ fontSize: 12 }}>
                    {f}
                  </span>
                  {held && (
                    <span className="m-meta" style={{ fontSize: 11 }}>
                      held
                    </span>
                  )}
                  <span className="m-meta" style={{ marginLeft: "auto", fontSize: 11 }}>
                    {a}
                  </span>
                </span>
                <span className="m-sub" style={{ display: "block", fontSize: 13, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {h}
                </span>
                {memo && <span style={{ display: "inline-block", marginTop: 4, fontSize: 11, fontWeight: 600, color: "var(--accent)" }}>Memo</span>}
              </button>
            ))}
          </div>
          <div style={{ minWidth: 0 }}>
            {pick === 0 ? (
              <>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }} className="m-meta">
                  <span className="m-tag accent">Draft memo</span>
                  <span>
                    {m.ticker} · {m.form} · by {m.author} · {m.age} ago
                  </span>
                </div>
                <h2 className="m-h2" style={{ margin: "12px 0 20px", fontSize: 40, letterSpacing: "-0.015em", lineHeight: 1.1 }}>
                  {m.title}
                </h2>
                <div className="m-stats" style={{ gridTemplateColumns: "repeat(4,minmax(0,1fr))" }}>
                  {m.stats.map(([k, v]) => (
                    <div key={k} style={{ padding: "12px 16px 12px 0" }}>
                      <div className="k">{k}</div>
                      <div className="v" style={{ fontSize: 24 }}>
                        {v}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="m-prose" style={{ marginTop: 24, fontSize: 17 }}>
                  {m.paras.map((p) => (
                    <p key={p}>{p}</p>
                  ))}
                </div>
                <p className="m-meta" style={{ marginTop: 24, paddingTop: 16, borderTop: "1px solid var(--line)" }}>
                  No order staged from this memo. The Filing tab holds the call it was written from.
                </p>
              </>
            ) : (
              <>
                <div className="m-meta">
                  {ticker} · {form} · {age} ago
                </div>
                <h2 className="m-h2" style={{ margin: "8px 0 12px", fontSize: 32, lineHeight: 1.15 }}>
                  {S.INBOX[pick][2]}
                </h2>
                <p className="m-sub" style={{ maxWidth: "62ch", fontSize: 15 }}>
                  {hasMemo
                    ? "An analyst memo on this document is waiting in review."
                    : "Parsed and filed. No analyst has written on it yet: it waits for the next desk loop on this name."}
                </p>
              </>
            )}
          </div>
        </div>
      ) : (
        <section style={{ maxWidth: 720 }}>
          <div className="m-shead">
            <h2 className="m-h2">Measured names</h2>
            <span className="m-meta">screen · valuation · models · factors · ML</span>
          </div>
          <div className="m-tr head" style={{ gridTemplateColumns: "minmax(0,1fr) 100px 100px 80px" }}>
            <span>Name</span>
            <span>Status</span>
            <span className="r">Ensemble</span>
            <span className="r">Measured</span>
          </div>
          {S.QUANT.map(([t, st, sig, a]) => (
            <div key={t} className="m-tr" style={{ gridTemplateColumns: "minmax(0,1fr) 100px 100px 80px", fontSize: 13 }}>
              <span style={{ fontWeight: 600 }}>{t}</span>
              <span>
                <span className={`m-tag ${st === "done" ? "up" : "accent"}`}>{st === "done" ? "Done" : "Running"}</span>
              </span>
              <span className="r" style={{ color: sig.startsWith("+") ? "var(--up)" : undefined }}>
                {sig}
              </span>
              <span className="r m-ink3">{a}</span>
            </div>
          ))}
          <p className="m-note">Each card runs the quant desk&apos;s stages on the name and combines them into an out-of-sample ensemble.</p>
        </section>
      )}
    </div>
  );
}

/* ── Agents ────────────────────────────────────────────────────────────── */

const KIND: Record<string, [string, string]> = {
  action: ["Action", "var(--accent)"],
  thought: ["Thought", "var(--ink-3)"],
  block: ["Blocked", "var(--down)"],
};

function Agents({ full, go }: { full: boolean; go: (s: DemoScreen) => void }) {
  const [sel, setSel] = useState<string | null>(null);
  const agents = S.CLUSTERS.reduce((s, c) => s + c[2], 0);
  const working = S.CLUSTERS.reduce((s, c) => s + c[3], 0);
  const trace = sel ? S.TRACE.filter((t) => t[2].endsWith(sel)) : S.TRACE;
  const COLS = "minmax(0,1.6fr) 70px minmax(60px,1fr) 70px";
  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: "10px 16px", marginBottom: 24 }}>
        <span className="m-sub" style={{ fontSize: 13 }}>
          {agents} agents in {S.CLUSTERS.length} clusters · last action 1m ago
        </span>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginLeft: "auto", fontSize: 13 }}>
          <span className="m-ink2">Model spend today</span>
          <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>${S.SPEND[0][1].toFixed(2)}</span>
          <span className="m-meta">both desks</span>
        </div>
        <button className="m-btn2" onClick={() => go("console")}>
          Agent controls
        </button>
      </div>
      <div className="m-cols2">
        <div className="m-stack" style={{ minWidth: 0 }}>
          <section>
            <div className="m-shead">
              <h2 className="m-h2">Clusters</h2>
              <span className="m-meta">{agents} agents</span>
            </div>
            <div className="m-meta" style={{ display: "grid", gridTemplateColumns: COLS, gap: 12, padding: "8px 0", borderBottom: "1px solid var(--line-2)" }}>
              <span>Cluster</span>
              <span style={{ textAlign: "right" }}>Agents</span>
              <span>Working now</span>
              <span style={{ textAlign: "right" }}>Last act</span>
            </div>
            {S.CLUSTERS.map(([name, theme, n, w, last]) => {
              const on = sel === name;
              return (
                <div
                  key={name}
                  style={{
                    display: "grid",
                    gridTemplateColumns: COLS,
                    gap: 12,
                    alignItems: "center",
                    padding: "6px 0",
                    borderBottom: "1px solid var(--line)",
                    fontSize: 13,
                    background: on ? "var(--sunk)" : undefined,
                  }}
                >
                  <button
                    aria-pressed={on}
                    onClick={() => setSel(on ? null : name)}
                    style={{ minWidth: 0, border: 0, background: "transparent", padding: "6px 0", textAlign: "left", cursor: "pointer" }}
                  >
                    <span style={{ display: "block", fontWeight: 600 }}>{name}</span>
                    <span className="m-meta">
                      {theme} · {w ? "working" : "idle"}
                    </span>
                  </button>
                  <span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{n}</span>
                  <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span className="m-bar" style={{ flex: 1 }}>
                      <i style={{ width: `${(w / n) * 100}%` }} />
                    </span>
                    <span style={{ fontVariantNumeric: "tabular-nums", fontSize: 12 }}>{w}</span>
                  </span>
                  <span className="m-meta" style={{ textAlign: "right" }}>
                    {last}
                  </span>
                </div>
              );
            })}
          </section>
          <section>
            <div className="m-shead">
              <h2 className="m-h2">{sel ? `${sel} activity` : "Recent activity"}</h2>
              {sel ? (
                <button className="m-link" onClick={() => setSel(null)}>
                  Show all clusters
                </button>
              ) : (
                <span className="m-meta">live</span>
              )}
            </div>
            {trace.length === 0 && <p className="m-empty">No recent events from this cluster.</p>}
            {trace.map(([kind, summary, who, age]) => {
              const [label, color] = KIND[kind];
              return (
                <div
                  key={summary}
                  style={{ display: "grid", gridTemplateColumns: "86px minmax(0,1fr) auto", gap: 12, alignItems: "start", padding: "11px 0", borderTop: "1px solid var(--line)", fontSize: 13 }}
                >
                  <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color }}>
                    <span className="m-dot" style={{ width: 6, height: 6, background: color }} />
                    {label}
                  </span>
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: "block" }}>{summary}</span>
                    <span className="m-mono m-ink3" style={{ fontSize: 12 }}>
                      {who}
                    </span>
                  </span>
                  <span className="m-meta">{age}</span>
                </div>
              );
            })}
          </section>
        </div>
        <aside className="m-aside">
          <section className="m-card" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <h2 className="m-h2" style={{ fontSize: 22, marginBottom: 6 }}>
              Fleet
            </h2>
            <Kv k="Agents" v={String(agents)} />
            <Kv k="Working now" v={String(working)} c="var(--up)" />
            <Kv k="Blocked" v="0" />
            <Kv k="Models in rotation" v="3" />
            <Kv k="Model calls today" v="1,284" />
            <p className="m-note" style={{ margin: "8px 0 0" }}>
              Spend and calls come from the budget ledger, which every model call writes; it covers both desks.
            </p>
          </section>
          {full && (
            <section>
              <div className="m-shead">
                <h2 className="m-h2" style={{ fontSize: 22 }}>
                  Model routing
                </h2>
                <span className="m-meta">agents · working</span>
              </div>
              {(
                [
                  ["Opus", 6, 3],
                  ["Sonnet", 9, 4],
                  ["Haiku", 5, 1],
                ] as const
              ).map(([m, n, a]) => (
                <div key={m} style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 60px 56px", gap: 12, alignItems: "center", padding: "9px 0", borderBottom: "1px solid var(--line)", fontSize: 13 }}>
                  <span className="m-mono" style={{ fontSize: 12 }}>
                    {m}
                  </span>
                  <span className="m-bar">
                    <i style={{ width: `${(n / agents) * 100}%` }} />
                  </span>
                  <span className="m-ink2" style={{ textAlign: "right" }}>
                    {n} · {a}
                  </span>
                </div>
              ))}
            </section>
          )}
        </aside>
      </div>
    </>
  );
}

/* ── Console ───────────────────────────────────────────────────────────── */

function Console() {
  const [on, setOn] = useState<Record<string, boolean>>({ responder: true, tech: true, india: false });
  const workers: [string, string][] = [
    ["responder", "Operator responder"],
    ["tech", "Tech desk loop"],
    ["india", "India desk loop"],
  ];
  const invested = S.NAV - S.CASH;
  return (
    <div className="m-cols2">
      <section className="m-chat">
        <div className="m-chat-feed">
          {S.THREAD.map(([mine, meta, text]) => (
            <div key={meta + text.slice(0, 8)} className={"m-msg" + (mine ? " mine" : "")}>
              <span className="m-meta">{meta}</span>
              <div className="m-bubble">{text}</div>
            </div>
          ))}
        </div>
        <form className="m-ask" onSubmit={(e) => e.preventDefault()}>
          <input aria-label="Ask Meridian" placeholder="Sample desk: sign in to ask the live one" disabled />
          <button type="submit" className="m-btn" disabled>
            Send
          </button>
        </form>
        <p className="m-note" style={{ marginTop: 8 }}>
          The Operator responder answers from the live book, recent memos and news.
        </p>
      </section>
      <aside className="m-aside">
        <div>
          <h2 className="m-h3" style={{ marginBottom: 8 }}>
            Agent controls
          </h2>
          {workers.map(([id, label]) => (
            <div key={id} className="m-kv" style={{ alignItems: "center" }}>
              <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className={`m-dot${on[id] ? " m-pulse" : ""}`} style={{ background: on[id] ? "var(--up)" : "var(--ink-3)" }} />
                {label}
              </span>
              <button className="m-btn2" style={{ minHeight: 30, padding: "4px 10px", fontSize: 12 }} onClick={() => setOn((p) => ({ ...p, [id]: !p[id] }))}>
                {on[id] ? "Stop" : "Start"}
              </button>
            </div>
          ))}
        </div>
        <div>
          <h2 className="m-h3" style={{ marginBottom: 8 }}>
            Book posture
          </h2>
          <Kv k="Names held" v={String(S.HOLDINGS.length + 14)} />
          <Kv k="Invested" v={short(invested)} />
          <Kv k="Cash" v={short(S.CASH)} />
          <Kv k="Largest" v="NVDA · 8.4%" />
        </div>
        <div>
          <h2 className="m-h3" style={{ marginBottom: 8 }}>
            Spend today
          </h2>
          {S.SPEND.map(([k, v]) => (
            <Kv key={k} k={k} v={`$${v.toFixed(2)}`} />
          ))}
          <Kv k="Total" v={`$${S.SPEND.reduce((s, x) => s + x[1], 0).toFixed(2)}`} />
          <p className="m-note" style={{ marginTop: 8 }}>
            Both desks, since local midnight.
          </p>
        </div>
      </aside>
    </div>
  );
}

/* ── Audit log ─────────────────────────────────────────────────────────── */

const LOG_KIND = { trade: ["Trade", "accent"], agents: ["Agents", ""], guard: ["Guardrail", "warn"] } as const;

function Log() {
  const [filter, setFilter] = useState<"all" | "trade" | "agents" | "guard">("all");
  const rows = S.LOG.filter((r) => filter === "all" || r[4] === filter);
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: "10px 16px", marginBottom: 20 }}>
        <div className="m-seg" role="group" aria-label="Filter">
          {(
            [
              ["all", "All"],
              ["trade", "Trades"],
              ["agents", "Agents"],
              ["guard", "Guardrails"],
            ] as const
          ).map(([id, label]) => (
            <button key={id} aria-pressed={filter === id} onClick={() => setFilter(id)}>
              {label}
            </button>
          ))}
        </div>
        <span className="m-sub">Every approval, fill and guardrail check. An approval can be undone until it executes.</span>
      </div>
      {rows.map(([t, a, d, actor, kind, blocked]) => {
        const [label, tn] = LOG_KIND[kind];
        return (
          <div
            key={t + d}
            style={{ display: "grid", gridTemplateColumns: "72px minmax(0,1fr) auto", gap: "6px 16px", alignItems: "baseline", padding: "13px 0", borderTop: "1px solid var(--line)", fontSize: 13 }}
          >
            <span className="m-mono m-ink3" style={{ fontSize: 12 }}>
              {t}
            </span>
            <span>
              <span style={{ fontWeight: 600, color: blocked ? "var(--down)" : undefined }}>{a}</span> <span className="m-ink2">{d}</span>
              <span className="m-meta" style={{ display: "block" }}>
                {actor}
              </span>
            </span>
            <span className={`m-tag ${tn}`}>{label}</span>
          </div>
        );
      })}
    </div>
  );
}

/* ── Frame ─────────────────────────────────────────────────────────────── */

/**
 * The sample desk at its 1280×800 desktop size, scaled to the frame's width.
 * Changing `screen` remounts the desk on that screen.
 */
export function DemoFrame({
  theme,
  screen = "today",
  onToggleTheme,
  label = "Sample desk",
}: {
  theme: Theme;
  screen?: DemoScreen;
  onToggleTheme?: () => void;
  label?: string;
}): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState<number | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setScale(el.clientWidth / 1280));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={ref} className="s-frame" role="region" aria-label={label} style={{ aspectRatio: "1280 / 800" }}>
      <div className="s-frame-in" style={{ transform: `scale(${scale ?? 0})`, visibility: scale == null ? "hidden" : undefined }}>
        <DeskDemo key={screen} theme={theme} screen={screen} onToggleTheme={onToggleTheme} />
      </div>
    </div>
  );
}
