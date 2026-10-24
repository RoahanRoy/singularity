"use client";

import { useEffect, useMemo, useState } from "react";
import { useDesk } from "../Shell";
import { useMarket } from "../MarketContext";
import {
  enqueueAgentCommand,
  listAgentStatus,
  listAgents,
  listAuditLog,
  listBudgetLedger,
  listRecentEvents,
  subscribeAgentEvents,
  subscribeAgentStatus,
} from "@/lib/appwrite/queries";
import type { AgentEvent, AgentStatusDoc, Memo } from "@/lib/appwrite/schema";
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

export function TodayScreen() {
  const { market } = useMarket();
  const onboard = useOnboard();
  const book = useFundBook(market, onboard);
  const { held, go } = useDesk();
  const [events, setEvents] = useState<AgentEvent[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    listRecentEvents(6)
      .then((e) => !cancelled && setEvents(e))
      .catch(() => !cancelled && setEvents([]));
    const unsub = subscribeAgentEvents((ev) => !cancelled && setEvents((p) => [ev, ...(p ?? [])].slice(0, 6)));
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  const pending = (held ?? []).filter((m) => m.status === "review");
  const budget = onboard?.budgets[market] ?? null;

  return (
    <div className="m-cols2">
      <div className="m-stack">
        <Headline market={market} book={book} pending={pending.length} lastStep={events?.[0]?.occurred_at ?? null} />
        <Decisions held={held} />
        <Feed events={events} onAll={() => go("agents")} />
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
  const { go, setResearchView } = useDesk();
  return (
    <button
      className="m-link"
      style={{ alignSelf: "flex-start", textAlign: "left" }}
      onClick={() => {
        setResearchView("filings");
        go("research");
      }}
    >
      Thesis: {memo.title}
      <span style={{ whiteSpace: "nowrap" }}>&nbsp;→</span>
    </button>
  );
}

// The order the broker sized. It only holds an order that cleared compliance
// and the pre-trade gate, so both read as passed.
function planRows(m: Memo, o: ReturnType<typeof heldOrder>): [string, string, string?][] {
  if (!o) return [["Order", "No sized order on this memo", "var(--warn)"]];
  const rows: [string, string, string?][] = [["Order", `Buy ${o.qty.toLocaleString()} ${m.ticker ?? "shares"}`]];
  if (o.weight_pct != null) rows.push(["Size", `${o.weight_pct.toFixed(2)}% of NAV`]);
  if (o.algo || o.venue) rows.push(["Route", [o.algo, o.venue].filter(Boolean).join(" · ")]);
  if (o.arrival) rows.push(["Arrival price", `${o.arrival.price.toLocaleString(undefined, { maximumFractionDigits: 2 })} · ${clockOrDate(o.arrival.at)}`]);
  rows.push(["Pre-trade risk gate", "Passed", "var(--up)"], ["Compliance", "Passed", "var(--up)"]);
  return rows;
}

function firstSentence(s: string): string {
  const t = (s || "").replace(/\s+/g, " ").trim();
  const m = t.match(/^(.{20,220}?[.!?])(\s|$)/);
  return m ? m[1] : t.length > 220 ? t.slice(0, 217) + "…" : t;
}

function Feed({ events, onAll }: { events: AgentEvent[] | null; onAll: () => void }) {
  const names = useLoad(
    () => listAgents(200).then((a) => Object.fromEntries(a.map((x) => [x.$id, x.name]))),
    [],
    {} as Record<string, string>,
  );
  return (
    <section>
      <div className="m-shead">
        <h2 className="m-h2">Since you last looked</h2>
        <button className="m-link" onClick={onAll}>
          All agent activity →
        </button>
      </div>
      {events == null ? (
        <p className="m-empty">Loading…</p>
      ) : events.length === 0 ? (
        <p className="m-empty">No agent activity yet.</p>
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
            }}
          >
            <span className="m-mono m-ink3" style={{ fontSize: 12 }}>
              {clockOrDate(e.occurred_at)}
            </span>
            <span style={{ minWidth: 0 }}>
              <span style={{ fontWeight: 600 }}>{names?.[e.agent_id] ?? e.agent_id}</span>{" "}
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
  const spend = useLoad(
    () =>
      listBudgetLedger(200).then((rows) => {
        const day = new Date().toDateString();
        return rows
          .filter((r) => r.category === "llm" && new Date(r.occurred_at).toDateString() === day)
          .reduce((s, r) => s + (r.amount_usd || 0), 0);
      }),
    [],
    null as number | null,
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
        <span>{spend == null ? "—" : `$${spend.toFixed(2)}`}</span>
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
          ["Every trade waits for your approval", true],
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
