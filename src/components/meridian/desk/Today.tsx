"use client";

import { useEffect, useMemo, useState } from "react";
import { useDesk } from "../Shell";
import { useMarket } from "../MarketContext";
import {
  enqueueAgentCommand,
  listAgentStatus,
  listAgents,
  listAuditLog,
  listBudgetSince,
  listRecentEvents,
  subscribeAgentEvents,
  subscribeAgentStatus,
} from "@/lib/appwrite/queries";
import type { Agent, AgentEvent, AgentStatusDoc, Memo } from "@/lib/appwrite/schema";
import { lagLimit, Z99 } from "@/lib/fund/risk-budget";
import { TRADING_DAYS } from "@/lib/quant/risk";
import { DESK_INDEX } from "@/lib/market/indices";
import type { Market } from "@/lib/meridian/format";
import {
  ago,
  clockOrDate,
  decideMemo,
  fullMoney,
  heldOrder,
  pct,
  startOfToday,
  toneOf,
  useFundBook,
  useLoad,
  useOnboard,
  useQuotes,
  yahoo,
} from "./data";

// The dispatcher republishes every worker's row every 5 minutes; older than
// this and nobody is home to run them (same rule as the Console).
const DISPATCHER_STALE_MS = 12 * 60_000;
const WORKERS = ["responder", "tech", "india"] as const;
const FEED_SIZE = 8;
const SEEN_KEY = (m: Market) => `meridian-desk-seen-${m}`;

/** When this viewer last left Today on a desk (this browser only). */
function readSeen(m: Market): string | null {
  try {
    return window.localStorage.getItem(SEEN_KEY(m));
  } catch {
    return null;
  }
}

export function TodayScreen() {
  const { market } = useMarket();
  const onboard = useOnboard();
  const book = useFundBook(market, onboard);
  const { held, go } = useDesk();
  // The event stream is shared by both desks; this desk's agents pick its rows.
  const agents = useLoad(() => listAgents(200, market), [market], [] as Agent[]);
  const [got, setGot] = useState<{ market: Market; rows: AgentEvent[] } | null>(null);
  // The last visit as it stood when Today opened; leaving stamps the next one.
  const [seen] = useState(() => ({ US: readSeen("US"), IN: readSeen("IN") }));

  useEffect(() => {
    if (!agents) return;
    const mine = new Set(agents.map((a) => a.$id));
    let cancelled = false;
    listRecentEvents(FEED_SIZE, [...mine])
      .then((rows) => !cancelled && setGot({ market, rows }))
      .catch(() => !cancelled && setGot({ market, rows: [] }));
    const unsub = subscribeAgentEvents((ev) => {
      if (cancelled || !mine.has(ev.agent_id)) return;
      setGot((p) => ({ market, rows: [ev, ...(p?.market === market ? p.rows : [])].slice(0, FEED_SIZE) }));
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [agents, market]);

  useEffect(
    () => () => {
      try {
        window.localStorage.setItem(SEEN_KEY(market), new Date().toISOString());
      } catch {
        /* storage blocked: every visit reads as the first */
      }
    },
    [market],
  );

  const events = got?.market === market ? got.rows : null;
  const names = Object.fromEntries((agents ?? []).map((a) => [a.$id, a.name]));

  const pending = (held ?? []).filter((m) => m.status === "review");
  const budget = onboard?.budgets[market] ?? null;

  return (
    <div className="m-cols2">
      <div className="m-stack">
        <Headline market={market} book={book} pending={pending.length} lastStep={events?.[0]?.occurred_at ?? null} />
        <Decisions held={held} />
        <Feed events={events} names={names} seenAt={seen[market]} onAll={() => go("agents")} />
      </div>
      <aside className="m-aside">
        <AgentCard lastStep={events?.[0]?.occurred_at ?? null} />
        <RecentActions onAll={() => go("log")} />
        <Guardrails market={market} target={budget?.target_te ?? null} onEdit={() => go("book")} />
      </aside>
    </div>
  );
}

function Headline({
  market,
  book,
  pending,
  lastStep,
}: {
  market: Market;
  book: ReturnType<typeof useFundBook>;
  pending: number;
  lastStep: string | null;
}) {
  const { go } = useDesk();
  const idx = DESK_INDEX[market];
  // The index, then the fund's largest holdings.
  const ticks = useMemo(() => {
    const top = (book?.positions ?? [])
      .slice()
      .sort((a, b) => (b.market_value || 0) - (a.market_value || 0))
      .slice(0, 5)
      .map((p) => ({ label: p.ticker, sym: yahoo(p.ticker, market) }));
    return [{ label: idx.name, sym: idx.symbol }, ...top];
  }, [book?.positions, market, idx]);
  const quotes = useQuotes(ticks.map((t) => t.sym));
  const date = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  const noFund = book != null && book.cash == null;

  const summary = [
    pending === 0
      ? "Nothing is waiting for you."
      : `${pending} ${pending === 1 ? "proposal is" : "proposals are"} waiting for you.`,
    lastStep ? `Last agent step ${ago(lastStep)} ago.` : null,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <section>
      <div className="m-sub">
        {date} · {market === "IN" ? "India fund" : "US fund"}
      </div>
      {book == null ? (
        <div className="m-big" style={{ fontSize: "clamp(38px,5.2vw,56px)", marginTop: 6, color: "var(--ink-3)" }}>
          —
        </div>
      ) : noFund ? (
        <div style={{ marginTop: 6 }}>
          <div className="m-big" style={{ fontSize: 34 }}>No fund on this desk yet</div>
          <p className="m-sub" style={{ margin: "8px 0 0" }}>
            Set a mandate on the{" "}
            <button className="m-link" onClick={() => go("book")}>
              Book
            </button>{" "}
            to give the agents capital to deploy.
          </p>
        </div>
      ) : (
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "4px 16px", marginTop: 6 }}>
          <span className="m-big" style={{ fontSize: "clamp(38px,5.2vw,56px)" }}>
            {fullMoney(book.nav, market)}
          </span>
          {book.dayPnl != null && (
            <span style={{ fontSize: 16, fontWeight: 500, color: toneOf(book.dayPnl), fontVariantNumeric: "tabular-nums" }}>
              {book.dayPnl >= 0 ? "+" : "−"}
              {fullMoney(Math.abs(book.dayPnl), market)}
              {book.dayPct != null && ` (${pct(book.dayPct, 2, true)})`} today
            </span>
          )}
        </div>
      )}
      <p className="m-sub" style={{ margin: "12px 0 0", maxWidth: "62ch", fontSize: 15, textWrap: "pretty" }}>
        {summary}
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
        {ticks.map((t) => {
          const q = quotes[t.sym];
          return (
            <div key={t.sym} style={{ padding: "10px 12px 10px 0", fontVariantNumeric: "tabular-nums", minWidth: 0 }}>
              <div className="m-meta" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {t.label}
              </div>
              <div style={{ fontSize: 14, fontWeight: 500 }}>
                {q ? q.price.toLocaleString(market === "IN" ? "en-IN" : "en-US", { maximumFractionDigits: 2 }) : "—"}
              </div>
              <div style={{ fontSize: 12, color: toneOf(q?.changePct) }}>{q ? pct(q.changePct / 100, 2, true) : "—"}</div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** Held orders: every trade the broker clears waits here for the operator. */
function Decisions({ held }: { held: Memo[] | null }) {
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { reloadHeld } = useDesk();

  async function act(m: Memo, action: "approve" | "reject" | "undo") {
    setBusy(m.$id);
    setError(null);
    const err = await decideMemo(m.$id, action).catch((e: Error) => e.message);
    if (err) setError(`${m.ticker ?? m.title}: ${err}`);
    setBusy(null);
    if (action !== "undo") setOpen(null);
    reloadHeld();
  }

  return (
    <section aria-labelledby="h-approvals">
      <div className="m-shead">
        <h2 id="h-approvals" className="m-h2">
          Needs your decision
        </h2>
        <span className="m-meta">Every trade asks for review</span>
      </div>
      {error && (
        <p className="m-sub" style={{ margin: "0 0 8px", color: "var(--down)" }}>
          {error}
        </p>
      )}
      {held == null ? (
        <p className="m-empty">Loading…</p>
      ) : held.length === 0 ? (
        <p className="m-empty">Nothing needs you right now. The next proposal will appear here and in the sidebar badge.</p>
      ) : (
        held.map((m) => {
          const o = heldOrder(m);
          const isOpen = open === m.$id;
          const approved = m.status === "approved";
          const conviction = o?.conviction ?? m.conviction;
          return (
            <div key={m.$id} style={{ borderTop: "1px solid var(--line)", padding: "14px 0" }}>
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "10px 16px" }}>
                <button
                  onClick={() => setOpen(isOpen ? null : m.$id)}
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
                    color: "inherit",
                    font: "inherit",
                  }}
                >
                  <span style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
                    <span style={{ fontWeight: 600, fontSize: 16 }}>{m.ticker ?? m.title}</span>
                    <span style={{ fontWeight: 600, fontVariantNumeric: "tabular-nums", color: "var(--up)" }}>
                      Buy {o?.weight_pct != null ? `${o.weight_pct.toFixed(2)}%` : o ? `${o.qty}` : ""}
                    </span>
                    <span className={`m-tag ${approved ? "up" : "accent"}`}>{approved ? "Approved" : "Review"}</span>
                  </span>
                  <span className="m-sub" style={{ textWrap: "pretty" }}>
                    {firstSentence(m.thesis)}
                  </span>
                  <span className="m-meta">
                    Conviction {conviction.toFixed(2)} · held {ago(m.$updatedAt)}
                  </span>
                </button>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {approved ? (
                    <>
                      <span style={{ fontSize: 13, fontWeight: 500, color: "var(--up)" }}>Approved · fills next sweep</span>
                      <button className="m-link" disabled={busy === m.$id} onClick={() => act(m, "undo")}>
                        Undo
                      </button>
                    </>
                  ) : (
                    <button className="m-btn2" onClick={() => setOpen(isOpen ? null : m.$id)}>
                      {isOpen ? "Close" : "Review plan"}
                    </button>
                  )}
                </div>
              </div>
              {isOpen && (
                <div className="m-card" style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 14 }}>
                  <div>
                    <div className="m-label" style={{ marginBottom: 4 }}>
                      Action plan
                    </div>
                    {planRows(m, o).map(([k, v, tone], i) => (
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
                        <span style={{ color: tone ?? "var(--ink)", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{v}</span>
                      </div>
                    ))}
                  </div>
                  <ThesisLink memo={m} />
                  {!approved && (
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <button className="m-btn" disabled={busy === m.$id || !o} onClick={() => act(m, "approve")}>
                        Approve {o ? `buy ${o.qty.toLocaleString()}` : ""}
                      </button>
                      <button className="m-btn2" disabled={busy === m.$id} onClick={() => act(m, "reject")}>
                        Decline
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })
      )}
    </section>
  );
}

function ThesisLink({ memo }: { memo: Memo }) {
  const { go, setResearchView, setFocusMemo } = useDesk();
  return (
    <button
      className="m-link"
      style={{ alignSelf: "flex-start", textAlign: "left" }}
      onClick={() => {
        setResearchView("filings");
        setFocusMemo(memo);
        go("research");
      }}
    >
      Thesis: {memo.title}
      <span style={{ whiteSpace: "nowrap" }}>&nbsp;→</span>
    </button>
  );
}

// The order the broker sized, and what each gate measured on it. The broker
// only holds an order that cleared the risk budget, the pre-trade overlay and
// compliance; orders staged before the measures were stored say so.
function planRows(m: Memo, o: ReturnType<typeof heldOrder>): [string, string, string?][] {
  if (!o) return [["Order", "No sized order on this memo", "var(--warn)"]];
  const rows: [string, string, string?][] = [["Order", `Buy ${o.qty.toLocaleString()} ${m.ticker ?? "shares"}`]];
  if (o.weight_pct != null) rows.push(["Size", `${o.weight_pct.toFixed(2)}% of NAV`]);
  if (o.algo || o.venue) rows.push(["Route", [o.algo, o.venue].filter(Boolean).join(" · ")]);
  if (o.arrival) rows.push(["Arrival price", `${o.arrival.price.toLocaleString(undefined, { maximumFractionDigits: 2 })} · ${clockOrDate(o.arrival.at)}`]);
  const c = o.checks;
  if (!c) {
    rows.push(["Risk budget, overlay, compliance", "Cleared · measures not stored on this order", "var(--up)"]);
    return rows;
  }
  if (c.te_before != null && c.te_after != null)
    rows.push([
      "Tracking error",
      `${pct(c.te_before)} → ${pct(c.te_after)}${c.target_te != null ? ` · budget ${pct(c.target_te)}` : ""}`,
      "var(--up)",
    ]);
  if (c.var95_after_pct != null) rows.push(["Book 1-day VaR 95% after", `${c.var95_after_pct.toFixed(2)}% of NAV`]);
  if (c.valuation)
    rows.push([
      "Valuation",
      `${c.valuation.verdict}${c.valuation.upside_pct != null ? ` · ${c.valuation.upside_pct > 0 ? "+" : ""}${c.valuation.upside_pct.toFixed(1)}% to fair value` : ""}`,
      c.valuation.verdict === "rich" ? "var(--warn)" : undefined,
    ]);
  if (c.critic)
    rows.push([
      "Red-team critic",
      `${c.critic.verdict}${c.critic.score != null ? ` · ${c.critic.score.toFixed(2)}` : ""}`,
      c.critic.verdict === "pass" ? "var(--up)" : "var(--warn)",
    ]);
  rows.push(
    c.compliance_flags.length
      ? ["Compliance", `Cleared with notes: ${c.compliance_flags.join("; ")}`, "var(--warn)"]
      : ["Compliance", "Cleared, no flags", "var(--up)"],
  );
  return rows;
}

function firstSentence(s: string): string {
  const t = (s || "").replace(/\s+/g, " ").trim();
  const m = t.match(/^(.{20,220}?[.!?])(\s|$)/);
  return m ? m[1] : t.length > 220 ? t.slice(0, 217) + "…" : t;
}

function Feed({
  events,
  names,
  seenAt,
  onAll,
}: {
  events: AgentEvent[] | null;
  names: Record<string, string>;
  seenAt: string | null;
  onAll: () => void;
}) {
  const fresh = (e: AgentEvent) => !seenAt || e.occurred_at > seenAt;
  const count = events?.filter(fresh).length ?? 0;
  const meta = !seenAt
    ? "Latest on this desk"
    : count === 0
      ? `Nothing new since ${clockOrDate(seenAt)}`
      : `${count === FEED_SIZE ? `${count}+` : count} new since ${clockOrDate(seenAt)}`;
  return (
    <section>
      <div className="m-shead">
        <h2 className="m-h2">Since you last looked</h2>
        <span className="m-meta" style={{ marginRight: "auto", marginLeft: 12 }}>
          {events == null ? "" : meta}
        </span>
        <button className="m-link" onClick={onAll}>
          All agent activity →
        </button>
      </div>
      {events == null ? (
        <p className="m-empty">Loading…</p>
      ) : events.length === 0 ? (
        <p className="m-empty">No agent activity on this desk yet.</p>
      ) : (
        events.map((e) => (
          <div
            key={e.$id}
            style={{
              display: "grid",
              gridTemplateColumns: "48px minmax(0,1fr)",
              gap: 12,
              padding: "11px 0",
              borderTop: "1px solid var(--line)",
              fontSize: 13,
              opacity: fresh(e) ? 1 : 0.55,
            }}
          >
            <span className="m-mono m-ink3" style={{ fontSize: 12 }}>
              {clockOrDate(e.occurred_at)}
            </span>
            <span style={{ minWidth: 0 }}>
              <span style={{ fontWeight: 600 }}>{names[e.agent_id] ?? e.agent_id}</span>{" "}
              <span className="m-ink2">{e.summary}</span>
            </span>
          </div>
        ))
      )}
    </section>
  );
}

function AgentCard({ lastStep }: { lastStep: string | null }) {
  const [statuses, setStatuses] = useState<Record<string, AgentStatusDoc> | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  // Both desks, since local midnight; a page short of the day's rows reads as a floor.
  const spend = useLoad(
    () =>
      listBudgetSince(startOfToday()).then(({ rows, total }) => ({
        usd: rows.filter((r) => r.category === "llm").reduce((s, r) => s + (r.amount_usd || 0), 0),
        partial: total > rows.length,
      })),
    [],
    null as { usd: number; partial: boolean } | null,
  );

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    let cancelled = false;
    listAgentStatus()
      .then((rows) => !cancelled && setStatuses(Object.fromEntries(rows.map((r) => [r.name, r]))))
      .catch(() => !cancelled && setStatuses({}));
    const unsub = subscribeAgentStatus((row) => !cancelled && setStatuses((p) => ({ ...(p ?? {}), [row.name]: row })));
    return () => {
      cancelled = true;
      clearInterval(t);
      unsub();
    };
  }, []);

  const rows = Object.values(statuses ?? {});
  const freshest = rows.reduce((m, s) => Math.max(m, Date.parse(s.updated_at || "") || 0), 0);
  const online = freshest > 0 && now - freshest < DISPATCHER_STALE_MS;
  const running = WORKERS.filter((w) => statuses?.[w]?.running).length;

  const [title, dot] = !statuses
    ? ["Checking agents…", "var(--ink-3)"]
    : !online
      ? ["Dispatcher offline", "var(--ink-3)"]
      : running > 0
        ? ["Agents are working", "var(--up)"]
        : ["Agents are paused", "var(--warn)"];
  const sub = [
    online ? `${running} of ${WORKERS.length} workers running.` : "Desk loops run on the daily cloud routines.",
    lastStep ? `Last step ${ago(lastStep, now)} ago.` : null,
  ]
    .filter(Boolean)
    .join(" ");

  async function toggle() {
    const action = running > 0 ? "stop" : "start";
    setBusy(true);
    try {
      const targets = WORKERS.filter((w) => (action === "start" ? !statuses?.[w]?.running : statuses?.[w]?.running));
      await Promise.all(targets.map((w) => enqueueAgentCommand(w, action)));
    } catch {
      // Failure shows as the status not changing.
    } finally {
      setTimeout(() => setBusy(false), 800);
    }
  }

  return (
    <section className="m-card" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span className={`m-dot${online && running > 0 ? " m-pulse" : ""}`} style={{ background: dot }} />
        <span style={{ fontWeight: 600 }}>{title}</span>
      </div>
      <div className="m-sub">{sub}</div>
      <div className="m-kv" style={{ borderTop: 0, padding: 0, fontSize: 12 }}>
        <span>Inference spend today</span>
        <span>{spend == null ? "—" : `${spend.partial ? "≥ " : ""}$${spend.usd.toFixed(2)}`}</span>
      </div>
      <button className="m-btn2" disabled={!online || busy} onClick={toggle} title={online ? undefined : "Run npm run agents:dispatch on your host"}>
        {running > 0 ? "Pause all agents" : "Resume agents"}
      </button>
    </section>
  );
}

function RecentActions({ onAll }: { onAll: () => void }) {
  const rows = useLoad(() => listAuditLog(3), [], []);
  return (
    <section>
      <div className="m-shead" style={{ marginBottom: 6 }}>
        <h3 className="m-h3">Recent actions</h3>
        <button className="m-link" onClick={onAll}>
          Audit log →
        </button>
      </div>
      {rows == null ? (
        <p className="m-empty">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="m-empty">Nothing recorded yet.</p>
      ) : (
        rows.map((e) => (
          <div key={e.$id} style={{ padding: "9px 0", borderTop: "1px solid var(--line)", fontSize: 13 }}>
            <div>
              <span style={{ fontWeight: 600, color: e.decision === "block" ? "var(--down)" : undefined }}>
                {humanAction(e.action)}
              </span>{" "}
              <span className="m-ink2">{e.detail || e.target}</span>
            </div>
            <div className="m-meta">
              {clockOrDate(e.occurred_at)} · {e.actor}
            </div>
          </div>
        ))
      )}
    </section>
  );
}

export function humanAction(a: string): string {
  const s = a.replace(/^operator_/, "").replace(/[_-]+/g, " ").trim();
  return s ? s[0].toUpperCase() + s.slice(1) : a;
}

/** The limits the risk budget implies (lib/fund/risk-budget.ts), in words. */
function Guardrails({ market, target, onEdit }: { market: Market; target: number | null; onEdit: () => void }) {
  const idx = DESK_INDEX[market].name;
  const rules: [string, boolean][] =
    target == null
      ? [["No risk budget set: the desk stages every trade.", false]]
      : [
          [`Tracking error target ${pct(target)} a year vs the ${idx}`, true],
          ["A trade may not lift tracking error past the target", true],
          [`No single name's active risk above ${pct(target)}`, true],
          [`Halt on a day loss beyond ${Z99.toFixed(2)} × (index vol + ${pct(target)}) / √${TRADING_DAYS}`, true],
          [`Halt when trailing the ${idx} by ${pct(lagLimit(target, 21))} over a month`, true],
          ["Trades wait for your approval unless the desk runs with MERIDIAN_AUTO_APPROVE=1", true],
        ];
  return (
    <section>
      <div className="m-shead" style={{ marginBottom: 6 }}>
        <h3 className="m-h3">Guardrails</h3>
        <button className="m-link" onClick={onEdit}>
          Edit →
        </button>
      </div>
      {rules.map(([text, on]) => (
        <div
          key={text}
          style={{
            display: "flex",
            gap: 8,
            alignItems: "baseline",
            padding: "6px 0",
            borderTop: "1px solid var(--line)",
            fontSize: 13,
            color: on ? "var(--ink)" : "var(--ink-2)",
          }}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: on ? "var(--up)" : "var(--warn)",
              flex: "none",
              transform: "translateY(-1px)",
            }}
          />
          {text}
        </div>
      ))}
    </section>
  );
}
