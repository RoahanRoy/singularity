"use client";

import { useState } from "react";
import { useDesk } from "../Shell";
import { useMarket } from "../MarketContext";
import { listEnsembleVerdicts, listMemosForTickers, listMemosPage, listPositions } from "@/lib/appwrite/queries";
import type { Memo } from "@/lib/appwrite/schema";
import { rankIdeas, upsideOf, type IdeaRanking } from "@/lib/fund/ideas";
import { verdictOf } from "@/lib/fund/rebalance";
import { UNIVERSE } from "@/lib/market/universe";
import type { Market } from "@/lib/meridian/format";
import { nextDeskRun, runLabel } from "@/lib/meridian/schedule";
import { ago, heldOrder, useLoad } from "./data";

/**
 * Research's queue views: the ideas the desk researches next (the same
 * ranking the desk loop walks, src/lib/fund/ideas.ts) and the memo backlog
 * by status.
 */

// MERIDIAN_QUANT_STORED_MAX_AGE_H's default: a verdict older than this isn't an idea.
const SWEEP_FRESH_H = 36;

const MEMO_TONE: Record<Memo["status"], string> = { draft: "", review: "warn", approved: "accent", executed: "up", rejected: "down" };
const signed = (n: number, dp = 1) => `${n > 0 ? "+" : ""}${n.toFixed(dp)}`;

type IdeasGot = { ranking: IdeaRanking; lastSweep: string | null; stale: boolean; memos: Record<string, Memo> };

async function loadIdeas(market: Market): Promise<IdeasGot> {
  const [reports, positions] = await Promise.all([listEnsembleVerdicts(market, 3), listPositions(200, market)]);
  const verdicts = reports.flatMap((r) => {
    const v = verdictOf(r);
    if (!v) return [];
    let data: unknown = null;
    try {
      data = r.payload_json ? (JSON.parse(r.payload_json) as { data?: unknown }).data : null;
    } catch {
      /* no upside */
    }
    return [{ ...v, upsidePct: upsideOf(data) }];
  });
  const ranking = rankIdeas({
    verdicts,
    universe: UNIVERSE[market],
    held: positions.map((p) => p.ticker),
    now: Date.now(),
    maxAgeMs: SWEEP_FRESH_H * 3_600_000,
  });
  const memos: Record<string, Memo> = {};
  for (const m of await listMemosForTickers(market, ranking.ideas.map((i) => i.ticker)))
    if (m.ticker && !memos[m.ticker.toUpperCase()]) memos[m.ticker.toUpperCase()] = m;
  const lastSweep = reports[0]?.run_at ?? null;
  const stale = lastSweep != null && Date.now() - Date.parse(lastSweep) > SWEEP_FRESH_H * 3_600_000;
  return { ranking, lastSweep, stale, memos };
}

export function IdeasView() {
  const { market } = useMarket();
  const { go, setResearchView, setFocusMemo } = useDesk();
  const [showOut, setShowOut] = useState(false);
  const got = useLoad(() => loadIdeas(market), [market], null as IdeasGot | null);
  const desk = market === "IN" ? "India" : "US";

  if (got === null) return <p className="m-empty">Loading…</p>;
  const { ranking, lastSweep, stale, memos } = got;
  const open = (m: Memo) => {
    setFocusMemo(m);
    setResearchView("filings");
    go("research");
  };
  const cols = "28px minmax(90px,1fr) repeat(3,minmax(64px,0.7fr)) minmax(120px,1.3fr)";

  return (
    <div>
      <p className="m-sub" style={{ margin: "0 0 20px", maxWidth: "70ch", textWrap: "pretty" }}>
        Names off both books that the latest quant sweep reads long, with fair value at or above the price, strongest first. Each{" "}
        {desk} run researches the next uncovered one after any filing updates; the next run is {runLabel(nextDeskRun(market))}.
      </p>
      {ranking.ideas.length === 0 ? (
        <p className="m-empty">
          {lastSweep
            ? `No ideas: the newest sweep verdict is ${ago(lastSweep)} old${
                stale ? `, past the ${SWEEP_FRESH_H}h window (weekends have no sweep)` : ""
              }, and no fresh long on an unheld name has valuation upside.`
            : "No quant sweep on this desk in the last three days, so there are no ideas."}
        </p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <div style={{ minWidth: 600 }}>
            <div className="m-tr head" style={{ gridTemplateColumns: cols }}>
              <span>#</span>
              <span>Name</span>
              <span className="r">Edge</span>
              <span className="r">Confidence</span>
              <span className="r">Upside</span>
              <span>Coverage</span>
            </div>
            {ranking.ideas.map((i, n) => {
              const m = memos[i.ticker];
              return (
                <div key={i.ticker} className="m-tr" style={{ gridTemplateColumns: cols, fontSize: 13 }}>
                  <span className="m-ink3">{n + 1}</span>
                  <span>
                    <span style={{ fontWeight: 600 }}>{i.ticker}</span>{" "}
                    <span className="m-meta">swept {ago(i.runAt)} ago</span>
                  </span>
                  <span className="r">{i.edge.toFixed(1)}</span>
                  <span className="r m-ink2">{i.confidence.toFixed(2)}</span>
                  <span className="r" style={{ color: "var(--up)" }}>
                    {signed(i.upsidePct)}%
                  </span>
                  <span>
                    {m ? (
                      <button className="m-link" onClick={() => open(m)}>
                        <span className={`m-tag ${MEMO_TONE[m.status]}`}>{m.status}</span> memo {ago(m.$createdAt)} ago →
                      </button>
                    ) : (
                      <span className="m-meta">Not researched yet</span>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
      <p className="m-note">
        Edge is the ensemble&apos;s composite × confidence, the key the construction plan buys by. Upside is the valuation blend&apos;s
        fair value against the price. A covered name comes back on its filings and on a verdict flip, not from this list.
      </p>
      {ranking.excluded.length > 0 && (
        <div style={{ padding: "9px 0", borderTop: "1px solid var(--line)", fontSize: 13 }}>
          <button className="m-link" aria-expanded={showOut} onClick={() => setShowOut((v) => !v)}>
            {ranking.excluded.length} fresh longs left out {showOut ? "▴" : "▾"}
          </button>
          {showOut &&
            ranking.excluded.map((x) => (
              <div key={x.ticker} className="m-sub" style={{ marginTop: 6 }}>
                <span style={{ fontWeight: 600, color: "var(--ink)" }}>{x.ticker}</span> · {x.reason}
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

const STATUSES: [Memo["status"] | null, string][] = [
  ["review", "In review"],
  ["approved", "Approved"],
  ["executed", "Executed"],
  ["rejected", "Rejected"],
  [null, "All"],
];
const PAGE = 25;

export function MemosView() {
  const { market } = useMarket();
  const { go, setResearchView, setFocusMemo } = useDesk();
  const [status, setStatus] = useState<Memo["status"] | null>("review");
  const [pages, setPages] = useState(1);
  const got = useLoad(() => listMemosPage(market, status, PAGE * pages), [market, status, pages], { memos: [], total: 0 });
  const open = (m: Memo) => {
    setFocusMemo(m);
    setResearchView("filings");
    go("research");
  };
  const cols = "minmax(70px,0.6fr) minmax(160px,2.4fr) 70px 90px 70px";

  return (
    <div>
      <div className="m-seg" role="group" aria-label="Memo status" style={{ display: "inline-flex", marginBottom: 20 }}>
        {STATUSES.map(([s, label]) => (
          <button
            key={label}
            aria-pressed={status === s}
            onClick={() => {
              setStatus(s);
              setPages(1);
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {got == null ? (
        <p className="m-empty">Loading…</p>
      ) : got.memos.length === 0 ? (
        <p className="m-empty">No memos with this status on the {market === "IN" ? "India" : "US"} desk.</p>
      ) : (
        <>
          <p className="m-meta" style={{ margin: "0 0 8px" }}>
            {got.total.toLocaleString()} {status ? STATUSES.find(([s]) => s === status)![1].toLowerCase() : "in all"}
            {status === "review" ? " · only the ones with an order can be approved; the rest are the desk's notes without a call" : ""}
          </p>
          <div style={{ overflowX: "auto" }}>
            <div style={{ minWidth: 560 }}>
              <div className="m-tr head" style={{ gridTemplateColumns: cols }}>
                <span>Name</span>
                <span>Memo</span>
                <span className="r">Conviction</span>
                <span>Status</span>
                <span className="r">Written</span>
              </div>
              {got.memos.map((m) => (
                <button
                  key={m.$id}
                  className="m-tr"
                  onClick={() => open(m)}
                  style={{
                    gridTemplateColumns: cols,
                    width: "100%",
                    fontSize: 13,
                    border: 0,
                    borderBottom: "1px solid var(--line)",
                    background: "transparent",
                    color: "inherit",
                    font: "inherit",
                    textAlign: "left",
                    cursor: "pointer",
                  }}
                >
                  <span style={{ fontWeight: 600 }}>{m.ticker ?? "—"}</span>
                  <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.title}</span>
                  <span className="r">{m.conviction.toFixed(2)}</span>
                  <span>
                    <span className={`m-tag ${MEMO_TONE[m.status]}`}>{m.status}</span>
                    {heldOrder(m) ? <span className="m-meta"> · order</span> : null}
                  </span>
                  <span className="r m-ink3">{ago(m.$createdAt)}</span>
                </button>
              ))}
            </div>
          </div>
          {got.total > got.memos.length && (
            <p className="m-note">
              <button className="m-link" onClick={() => setPages((p) => p + 1)}>
                Show {Math.min(PAGE, got.total - got.memos.length)} more
              </button>
            </p>
          )}
        </>
      )}
    </div>
  );
}
