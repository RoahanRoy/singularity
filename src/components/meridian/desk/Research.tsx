"use client";

import { useEffect, useState } from "react";
import { useDesk } from "../Shell";
import { useMarket } from "../MarketContext";
import { listAgents, listFilings, listMemos, listMemosByFiling, listPositions, subscribeFilings } from "@/lib/appwrite/queries";
import type { Filing, Memo, MemoEntity } from "@/lib/appwrite/schema";
import { nextDeskRun, runLabel } from "@/lib/meridian/schedule";
import { ago, decideMemo, heldOrder, useLoad } from "./data";

/** Enough rows to show a filing for every name on the book (largest desk holds ~55). */
const QUEUE_SIZE = 80;

const MEMO_TONE: Record<Memo["status"], string> = {
  draft: "",
  review: "warn",
  approved: "accent",
  executed: "up",
  rejected: "down",
};

function parseEntities(raw: string | null | undefined): MemoEntity[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((e): e is MemoEntity => e && typeof e.name === "string" && typeof e.role === "string" && typeof e.weight === "number")
      .map((e) => ({ ...e, weight: Math.max(0, Math.min(1, e.weight)) }));
  } catch {
    return [];
  }
}

/** The filing's stored summary, or the last path segment of its source. */
function headline(f: Filing): string {
  if (f.summary) return f.summary.split(/\n+/)[0];
  try {
    const u = new URL(f.source_url);
    const tail = u.pathname.split("/").filter(Boolean).pop() ?? u.hostname;
    return tail.replace(/\.(htm|html|pdf|txt|xml|json)$/i, "");
  } catch {
    return f.source_url;
  }
}

const paras = (s: string) => s.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);

export function FilingsView() {
  const { market } = useMarket();
  const { focusMemo, setFocusMemo, held, reloadHeld } = useDesk();
  const [nonce, setNonce] = useState(0);
  const base = useLoad(
    () =>
      Promise.all([
        listFilings(QUEUE_SIZE, market),
        listMemos(100, market),
        listPositions(200, market).then((ps) => ps.map((p) => p.ticker.toUpperCase())),
        listAgents(200).then((a) => Object.fromEntries(a.map((x) => [x.$id, x.name])) as Record<string, string>),
      ]),
    [market, nonce],
    [[], [], [], {}] as [Filing[], Memo[], string[], Record<string, string>],
  );
  // Filings that land while the screen is open, newest first.
  const [live, setLive] = useState<{ market: string; rows: Filing[] }>({ market, rows: [] });
  useEffect(() => subscribeFilings((f) => setLive((l) => ({ market, rows: [f, ...(l.market === market ? l.rows : [])] })), market), [market]);

  const [sel, setSel] = useState<string | null>(() => focusMemo?.filing_id ?? null);

  const [filings0, memos, heldTickers, agents] = base ?? [[], [], [], {}];
  const fresh = live.market === market ? live.rows : [];
  const seen = new Set<string>();
  const heldSet = new Set(heldTickers);
  const filings = [...fresh, ...filings0]
    .filter((f) => !seen.has(f.$id) && (seen.add(f.$id), true))
    // Held names first; recency kept within each group.
    .sort((a, b) => Number(heldSet.has(b.ticker.toUpperCase())) - Number(heldSet.has(a.ticker.toUpperCase())));
  const memoed = new Set(memos.map((m) => m.filing_id).filter(Boolean));
  const heldCount = filings.filter((f) => heldSet.has(f.ticker.toUpperCase())).length;
  // A memo opened from Today shows on its own when its filing isn't in the inbox.
  const loose =
    focusMemo && (focusMemo.market ?? market) === market && base != null && !filings.some((f) => f.$id === focusMemo.filing_id)
      ? focusMemo
      : null;

  const current = loose ? null : (filings.find((f) => f.$id === sel) ?? filings[0] ?? null);
  const pick = (id: string) => {
    setSel(id);
    if (focusMemo) setFocusMemo(null);
  };

  return (
    <div className="m-split">
      <div style={{ minWidth: 0 }}>
        <div className="m-shead">
          <h2 className="m-h3">Inbox</h2>
          <span className="m-meta">
            {base == null ? "Loading…" : `${filings.length} documents · ${heldCount} on the book`}
          </span>
        </div>
        {base != null && filings.length === 0 && <p className="m-empty">No filings ingested on this desk yet.</p>}
        {loose && (
          <button className="m-pick" aria-current onClick={() => {}}>
            <span style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
              <span style={{ fontSize: 14, fontWeight: 600 }}>{loose.ticker ?? "—"}</span>
              <span className="m-sub" style={{ fontSize: 12 }}>
                memo
              </span>
              <span className="m-meta" style={{ marginLeft: "auto", fontSize: 11 }}>
                {ago(loose.$createdAt)}
              </span>
            </span>
            <span className="m-sub" style={{ display: "block", fontSize: 13, marginTop: 2 }}>
              {loose.title}
            </span>
          </button>
        )}
        {filings.map((f) => (
          <button key={f.$id} className="m-pick" aria-current={f.$id === current?.$id} onClick={() => pick(f.$id)}>
            <span style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
              <span style={{ fontSize: 14, fontWeight: 600 }}>{f.ticker}</span>
              <span className="m-sub" style={{ fontSize: 12 }}>
                {f.form_type}
              </span>
              {heldSet.has(f.ticker.toUpperCase()) && (
                <span className="m-meta" style={{ fontSize: 11 }} title="On the book">
                  held
                </span>
              )}
              <span className="m-meta" style={{ marginLeft: "auto", fontSize: 11, whiteSpace: "nowrap" }}>
                {ago(f.$createdAt)}
              </span>
            </span>
            <span
              className="m-sub"
              style={{ display: "block", fontSize: 13, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
            >
              {headline(f)}
            </span>
            {memoed.has(f.$id) && (
              <span style={{ display: "inline-block", marginTop: 4, fontSize: 11, fontWeight: 600, color: "var(--accent)" }}>
                Memo ready
              </span>
            )}
          </button>
        ))}
      </div>

      <article style={{ minWidth: 0 }}>
        {loose ? (
          <MemoArticle
            key={loose.$id}
            memos={[loose]}
            filing={null}
            agents={agents}
            held={held}
            onDecided={() => {
              reloadHeld();
              setNonce((n) => n + 1);
            }}
          />
        ) : current ? (
          <FilingArticle
            key={current.$id}
            filing={current}
            agents={agents}
            held={held}
            nonce={nonce}
            onDecided={() => {
              reloadHeld();
              setNonce((n) => n + 1);
            }}
          />
        ) : null}
      </article>
    </div>
  );
}

function FilingArticle({
  filing,
  agents,
  held,
  nonce,
  onDecided,
}: {
  filing: Filing;
  agents: Record<string, string>;
  held: Memo[] | null;
  nonce: number;
  onDecided: () => void;
}) {
  const memos = useLoad(() => listMemosByFiling(filing.$id), [filing.$id, nonce], []);
  if (memos == null) return <p className="m-empty">Loading…</p>;
  if (memos.length) return <MemoArticle memos={memos} filing={filing} agents={agents} held={held} onDecided={onDecided} />;

  const why =
    filing.status === "indexed"
      ? "Parsed and indexed, but no analyst memo references it yet. The desk writes memos for filings on covered names as its loop picks them up."
      : filing.status === "failed"
        ? "Parsing failed, so no memo will be written from this filing."
        : `The filing is ${filing.status}. The analyst writes a memo once parsing completes.`;
  return (
    <>
      <div className="m-meta">
        {filing.form_type} · filed {ago(filing.filed_at)} ago · ingested {ago(filing.$createdAt)} ago
      </div>
      <h2 className="m-h2" style={{ margin: "8px 0 12px", fontSize: 32, lineHeight: 1.15 }}>
        {filing.ticker}
      </h2>
      <FilingBody filing={filing} />
      <div className="m-card" style={{ maxWidth: 520, marginTop: 24, display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ fontWeight: 600 }}>No memo yet</div>
        <div className="m-sub" style={{ fontSize: 13 }}>
          {why}
        </div>
      </div>
    </>
  );
}

function FilingBody({ filing }: { filing: Filing }) {
  let host: string | null = null;
  try {
    host = new URL(filing.source_url).hostname.replace(/^www\./, "");
  } catch {
    host = null;
  }
  return (
    <>
      {filing.summary ? (
        <div className="m-prose" style={{ fontSize: 17 }}>
          {paras(filing.summary).map((p, i) => (
            <p key={i}>{p}</p>
          ))}
        </div>
      ) : (
        <p className="m-sub" style={{ margin: 0, maxWidth: "62ch", fontSize: 15 }}>
          No summary stored for this filing yet.
        </p>
      )}
      <div style={{ maxWidth: 520, marginTop: 20 }}>
        <div className="m-kv">
          <span>Form</span>
          <span>{filing.form_type}</span>
        </div>
        <div className="m-kv">
          <span>Filed</span>
          <span>{new Date(filing.filed_at).toLocaleString()}</span>
        </div>
        <div className="m-kv">
          <span>Status</span>
          <span>{filing.status}</span>
        </div>
        <div className="m-kv">
          <span>Source</span>
          <a href={filing.source_url} target="_blank" rel="noreferrer" className="m-link" style={{ wordBreak: "break-all" }}>
            {host ?? "open"} ↗
          </a>
        </div>
      </div>
    </>
  );
}

function MemoArticle({
  memos,
  filing,
  agents,
  held,
  onDecided,
}: {
  memos: Memo[];
  filing: Filing | null;
  agents: Record<string, string>;
  held: Memo[] | null;
  onDecided: () => void;
}) {
  const { market: desk } = useMarket();
  const [idx, setIdx] = useState(0);
  const [tab, setTab] = useState<"memo" | "filing" | "entities">("memo");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const m = memos[Math.min(idx, memos.length - 1)];
  const market = m.market ?? desk;
  const entities = parseEntities(m.entities_json);
  const order = heldOrder(m);
  // The held list is the live status; the row read here may be a step behind.
  const status = held?.find((h) => h.$id === m.$id)?.status ?? m.status;

  async function act(action: "approve" | "reject" | "undo") {
    setBusy(true);
    setError(null);
    const err = await decideMemo(m.$id, action).catch((e: Error) => e.message);
    setBusy(false);
    if (err) setError(err);
    onDecided();
  }

  const stats: [string, string][] = [
    ["Conviction", m.conviction.toFixed(2)],
    ["Status", status],
    ...(order
      ? ([
          ["Order", `Buy ${order.qty.toLocaleString()}`],
          ["Size", order.weight_pct == null ? "—" : `${Number(order.weight_pct).toFixed(2)}% NAV`],
        ] as [string, string][])
      : []),
  ];
  const tabs: ["memo" | "filing" | "entities", string][] = [
    ["memo", "Memo"],
    ...(filing ? ([["filing", "Filing"]] as ["filing", string][]) : []),
    ...(entities.length ? ([["entities", "Entities"]] as ["entities", string][]) : []),
  ];

  return (
    <>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }} className="m-meta">
        <span className={`m-tag ${MEMO_TONE[status] ?? ""}`}>{status[0].toUpperCase() + status.slice(1)} memo</span>
        <span>
          {[m.ticker ?? filing?.ticker, filing?.form_type, `by ${agents[m.author_agent_id] ?? "an agent"}`, `${ago(m.$createdAt)} ago`]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </div>
      <h2
        className="m-h2"
        style={{ margin: "12px 0 20px", fontSize: "clamp(30px,3.6vw,42px)", letterSpacing: "-0.015em", lineHeight: 1.1, textWrap: "balance" }}
      >
        {m.title}
      </h2>
      <div className="m-stats" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(110px,1fr))" }}>
        {stats.map(([k, v]) => (
          <div key={k} style={{ padding: "12px 16px 12px 0" }}>
            <div className="k">{k}</div>
            <div className="v" style={{ fontSize: 24 }}>
              {v}
            </div>
          </div>
        ))}
      </div>
      {tabs.length > 1 && (
        <div className="m-tabs" role="tablist" aria-label="Memo views" style={{ margin: "24px 0 20px", gap: 20 }}>
          {tabs.map(([id, label]) => (
            <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)} style={{ fontSize: 13, padding: "8px 0" }}>
              {label}
            </button>
          ))}
        </div>
      )}

      {tab === "memo" && (
        <>
          <div className="m-prose" style={{ marginTop: tabs.length > 1 ? 0 : 24 }}>
            {paras(m.thesis).map((p, i) => (
              <p key={i}>{p}</p>
            ))}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginTop: 24, paddingTop: 16, borderTop: "1px solid var(--line)" }}>
            {status === "review" && order ? (
              <>
                <button className="m-btn" disabled={busy} onClick={() => act("approve")}>
                  Approve buy {order.qty.toLocaleString()}
                </button>
                <button className="m-btn2" disabled={busy} onClick={() => act("reject")}>
                  Decline
                </button>
                <span className="m-meta">The order is staged; nothing trades until you approve.</span>
              </>
            ) : status === "approved" ? (
              <>
                <span className="m-sub">
                  Approved · fills at the {market === "IN" ? "India" : "US"} run {runLabel(nextDeskRun(market))}
                </span>
                {order && (
                  <button className="m-btn2" disabled={busy} onClick={() => act("undo")}>
                    Undo
                  </button>
                )}
              </>
            ) : (
              <span className="m-meta">
                {status === "executed"
                  ? "Executed: the order filled."
                  : status === "rejected"
                    ? "Declined: no order."
                    : "No order staged from this memo."}
              </span>
            )}
          </div>
          {error && (
            <p className="m-sub" style={{ color: "var(--down)", margin: "10px 0 0" }}>
              {error}
            </p>
          )}
          {memos.length > 1 && (
            <>
              <h3 className="m-h3" style={{ margin: "28px 0 6px" }}>
                Other memos on this filing
              </h3>
              {memos.map((x, i) =>
                i === idx ? null : (
                  <button key={x.$id} className="m-pick" onClick={() => setIdx(i)} style={{ borderTop: "1px solid var(--line)", borderRadius: 0 }}>
                    <span style={{ fontSize: 13, fontWeight: 500 }}>{x.title}</span>
                    <span className="m-meta" style={{ display: "block" }}>
                      {x.status} · conviction {x.conviction.toFixed(2)} · {ago(x.$createdAt)} ago
                    </span>
                  </button>
                ),
              )}
            </>
          )}
        </>
      )}

      {tab === "filing" && filing && <FilingBody filing={filing} />}

      {tab === "entities" &&
        entities.map((e, i) => (
          <div
            key={i}
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(0,1.4fr) 90px minmax(60px,1fr) 40px",
              gap: 12,
              alignItems: "center",
              padding: "10px 0",
              borderTop: "1px solid var(--line)",
              fontSize: 13,
            }}
          >
            <span style={{ fontWeight: 500 }}>{e.name}</span>
            <span className="m-ink3">{e.role}</span>
            <span className="m-bar">
              <i style={{ width: `${e.weight * 100}%` }} />
            </span>
            <span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{e.weight.toFixed(2)}</span>
          </div>
        ))}
    </>
  );
}
