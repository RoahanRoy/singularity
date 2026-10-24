"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useOperator } from "../AuthGate";
import { useMarket } from "../MarketContext";
import {
  enqueueAgentCommand,
  listAgentStatus,
  listBudgetSince,
  listOperatorMessages,
  sendOperatorMessage,
  subscribeAgentStatus,
  subscribeOperatorMessages,
} from "@/lib/appwrite/queries";
import type { AgentStatusDoc, AgentWorker, BudgetLedger, OperatorMessage } from "@/lib/appwrite/schema";
import type { Market } from "@/lib/meridian/format";
import { ago, money, toneOf, useFundBook, useLoad, useOnboard } from "./data";

/**
 * The operator console on the v2 layout: a chat on the desk's real
 * operator_messages thread (the responder worker answers it), and beside it
 * the worker controls, the fund book's posture and today's spend. The design's
 * guardrail switches have nothing behind them, so the aside carries the
 * controls that do (agent_commands rows the dispatcher drains).
 */

const threadFor = (market: Market) => (market === "IN" ? "default-IN" : "default");

const HINTS = ["What's my biggest risk?", "Summarise today", "Which memos are waiting on me?", "What changed on the book?"];

function Chat({ market }: { market: Market }) {
  const op = useOperator();
  const thread = threadFor(market);
  const [got, setGot] = useState<{ thread: string; rows: OperatorMessage[] } | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const feed = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    listOperatorMessages(thread, 200)
      .then((rows) => !cancelled && setGot({ thread, rows }))
      .catch(() => !cancelled && setGot({ thread, rows: [] }));
    const unsub = subscribeOperatorMessages(thread, (m) => {
      if (cancelled) return;
      setGot((prev) => {
        const rows = prev?.thread === thread ? prev.rows : [];
        return rows.some((x) => x.$id === m.$id) ? prev : { thread, rows: [...rows, m] };
      });
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [thread]);

  const msgs = got?.thread === thread ? got.rows : null;
  const thinking = !!msgs?.length && msgs[msgs.length - 1].role === "operator";

  useEffect(() => {
    if (feed.current) feed.current.scrollTop = feed.current.scrollHeight;
  }, [msgs?.length, thinking]);

  async function ask(text: string) {
    const t = text.trim();
    if (!t || sending) return;
    setSending(true);
    setError(null);
    setDraft("");
    try {
      await sendOperatorMessage(t, "operator", thread);
    } catch (e) {
      setDraft(t);
      setError(e instanceof Error ? e.message : "Couldn't send.");
    } finally {
      setSending(false);
    }
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    ask(draft);
  };

  const opName = op?.name || op?.email || "Operator";

  return (
    <section className="m-chat">
      <div ref={feed} className="m-chat-feed" aria-live="polite">
        {msgs == null ? (
          <p className="m-meta">Loading the thread…</p>
        ) : msgs.length === 0 ? (
          <div className="m-empty">No messages on the {market === "IN" ? "India" : "US"} desk yet. Ask something below.</div>
        ) : (
          msgs.map((m) => {
            const mine = m.role === "operator";
            return (
              <div key={m.$id} className={"m-msg" + (mine ? " mine" : "")}>
                <span className="m-meta">
                  {mine ? opName : m.role === "assistant" ? "Meridian · assistant" : "System"} · {ago(m.$createdAt)} ago
                </span>
                <div className="m-bubble">{m.content}</div>
              </div>
            );
          })
        )}
        {thinking && <p className="m-meta m-pulse">Meridian is working…</p>}
      </div>
      <div className="m-chips">
        {HINTS.map((h) => (
          <button key={h} type="button" onClick={() => ask(h)} disabled={sending || thinking}>
            {h}
          </button>
        ))}
      </div>
      <form className="m-ask" onSubmit={onSubmit}>
        <label htmlFor="mx-ask" className="m-sr">Ask Meridian</label>
        <input
          id="mx-ask"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Ask about the book, or give an instruction"
          disabled={sending}
          autoComplete="off"
        />
        <button type="submit" className="m-btn" disabled={sending || !draft.trim()}>
          Send
        </button>
      </form>
      <p className="m-note" style={{ marginTop: 8 }}>
        {error ? <span style={{ color: "var(--down)" }}>{error} </span> : null}
        The Operator responder answers from the live book, recent memos and news. If it&apos;s stopped, messages wait for it.
      </p>
    </section>
  );
}

const WORKERS: [AgentWorker, string][] = [
  ["responder", "Operator responder"],
  ["tech", "US research loop"],
  ["india", "India research loop"],
];
// The dispatcher republishes every worker's row each tick; older than this, it isn't running.
const DISPATCHER_STALE_MS = 12 * 60_000;

function Workers() {
  const [rows, setRows] = useState<Record<string, AgentStatusDoc> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    let cancelled = false;
    listAgentStatus()
      .then((list) => !cancelled && setRows(Object.fromEntries(list.map((r) => [r.name, r]))))
      .catch(() => !cancelled && setRows({}));
    const unsub = subscribeAgentStatus((r) => {
      if (!cancelled) setRows((prev) => ({ ...(prev ?? {}), [r.name]: r }));
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  async function run(key: string, cmds: [AgentWorker, "start" | "stop" | "restart"][]) {
    setBusy(key);
    try {
      await Promise.all(cmds.map(([name, action]) => enqueueAgentCommand(name, action)));
    } catch {
      // A failed command shows as the status not changing.
    } finally {
      // Give the dispatcher a beat to pick the command up before re-enabling.
      setTimeout(() => setBusy(null), 800);
    }
  }

  if (rows == null) return <p className="m-meta">Loading workers…</p>;

  const freshest = Object.values(rows).reduce((m, s) => Math.max(m, Date.parse(s.updated_at || "") || 0), 0);
  const online = freshest > 0 && now - freshest < DISPATCHER_STALE_MS;
  const running = WORKERS.filter(([n]) => rows[n]?.running).map(([n]) => n);
  const stopped = WORKERS.filter(([n]) => !rows[n]?.running).map(([n]) => n);
  const off = busy !== null || !online;

  return (
    <>
      <p className="m-sub" style={{ margin: "0 0 10px" }}>
        {online ? (
          <>Dispatcher online · last report {ago(new Date(freshest).toISOString(), now)} ago.</>
        ) : (
          <>
            Dispatcher offline{freshest ? ` since ${ago(new Date(freshest).toISOString(), now)} ago` : ""}. Run{" "}
            <span className="m-mono">npm run agents:dispatch</span> on your host.
          </>
        )}
      </p>
      {WORKERS.map(([name, label]) => {
        const s = rows[name];
        const on = !!s?.running;
        const failed = !on && s?.exit_code != null && s.exit_code !== 0;
        return (
          <div key={name} className="m-kv" style={{ alignItems: "center" }}>
            <span style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
              <span className="m-dot" style={{ background: on ? "var(--up)" : failed ? "var(--down)" : "var(--ink-3)" }} />
              <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                <span style={{ color: "var(--ink)" }}>{label}</span>
                <span className="m-meta">
                  {on ? `Running · pid ${s?.pid ?? "—"}` : s?.exit_code != null ? `Stopped · exit ${s.exit_code}` : "Stopped"}
                </span>
              </span>
            </span>
            <span style={{ display: "flex", gap: 6 }}>
              {on ? (
                <>
                  <button className="m-link" disabled={off} onClick={() => run(`${name}:restart`, [[name, "restart"]])}>
                    Restart
                  </button>
                  <button className="m-link" disabled={off} onClick={() => run(`${name}:stop`, [[name, "stop"]])}>
                    Stop
                  </button>
                </>
              ) : (
                <button className="m-link" disabled={off} onClick={() => run(`${name}:start`, [[name, "start"]])}>
                  Start
                </button>
              )}
            </span>
          </div>
        );
      })}
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button className="m-btn2" disabled={off || !stopped.length} onClick={() => run("all:start", stopped.map((n) => [n, "start"]))}>
          {busy === "all:start" ? "Starting…" : "Run all"}
        </button>
        <button className="m-btn2" disabled={off || !running.length} onClick={() => run("all:stop", running.map((n) => [n, "stop"]))}>
          {busy === "all:stop" ? "Stopping…" : "Stop all"}
        </button>
      </div>
    </>
  );
}

function startOfToday(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

const CATEGORY: Record<BudgetLedger["category"], string> = {
  llm: "Model calls",
  data: "Data",
  compute: "Compute",
  venue_fees: "Venue fees",
};

export function ConsoleScreen() {
  const { market } = useMarket();
  const onboard = useOnboard();
  const book = useFundBook(market, onboard);
  const spend = useLoad(
    () => listBudgetSince(startOfToday()).then((r) => ({ hit: r as Awaited<ReturnType<typeof listBudgetSince>> | null })),
    [market],
    { hit: null },
  );

  const kv = (k: string, v: string, color?: string) => (
    <div key={k} className="m-kv">
      <span>{k}</span>
      <span className="m-mono" style={color ? { color } : undefined}>{v}</span>
    </div>
  );

  const positions = book?.positions ?? [];
  const mv = positions.reduce((s, p) => s + (p.market_value || 0), 0);
  const upnl = positions.reduce((s, p) => s + (p.unrealized_pnl || 0), 0);
  const largest = positions.reduce<(typeof positions)[number] | null>(
    (m, p) => (!m || (p.market_value || 0) > (m.market_value || 0) ? p : m),
    null,
  );

  const ledger = spend?.hit?.rows ?? [];
  const partial = spend?.hit != null && spend.hit.total > ledger.length;
  const byCat = new Map<BudgetLedger["category"], number>();
  for (const r of ledger) byCat.set(r.category, (byCat.get(r.category) ?? 0) + r.amount_usd);
  const usd = (v: number) => `${partial ? "≥ " : ""}$${v.toFixed(2)}`;

  return (
    <div className="m-cols2">
      <Chat key={market} market={market} />
      <aside className="m-aside">
        <div>
          <h2 className="m-h3" style={{ marginBottom: 8 }}>Agent controls</h2>
          <Workers />
        </div>
        <div>
          <h2 className="m-h3" style={{ marginBottom: 8 }}>Book posture</h2>
          {book == null ? (
            <p className="m-meta">Loading…</p>
          ) : book.cash == null ? (
            <p className="m-sub">No fund on this desk yet.</p>
          ) : (
            <>
              {kv("Names held", String(positions.length))}
              {kv("Invested", money(mv, market))}
              {kv("Cash", money(book.cash, market))}
              {kv("Unrealised P&L", money(upnl, market), toneOf(upnl))}
              {largest && book.nav > 0 && kv("Largest", `${largest.ticker} · ${((largest.market_value / book.nav) * 100).toFixed(1)}%`)}
            </>
          )}
        </div>
        <div>
          <h2 className="m-h3" style={{ marginBottom: 8 }}>Spend today</h2>
          {spend == null ? (
            <p className="m-meta">Loading…</p>
          ) : spend.hit == null ? (
            <p className="m-sub">The spend ledger didn&apos;t load.</p>
          ) : ledger.length === 0 ? (
            <p className="m-sub">Nothing spent since midnight.</p>
          ) : (
            <>
              {[...byCat].map(([cat, v]) => kv(CATEGORY[cat] ?? cat, usd(v)))}
              {kv("Total", usd(ledger.reduce((s, r) => s + r.amount_usd, 0)))}
              <p className="m-note" style={{ marginTop: 8 }}>Both desks, since local midnight.</p>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}
