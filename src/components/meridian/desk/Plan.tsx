"use client";

import { useState } from "react";
import { latestConstructionPlan } from "@/lib/appwrite/queries";
import type { ConstructionPlan, ConstructionPlanPayload } from "@/lib/appwrite/schema";
import { operatorFetch } from "@/lib/auth/operator-fetch";
import type { CoreApproval } from "@/lib/fund/core-approval";
import type { Market } from "@/lib/meridian/format";
import { nextDeskRun, runLabel } from "@/lib/meridian/schedule";
import { clockOrDate, money, pct, useLoad } from "./data";

const BINDING: Record<ConstructionPlan["binding"], string> = {
  target: "at target tracking error",
  bounds: "inside target, bounds bind",
  floor: "above target, floor binds",
};

/** The desk's stored construction plan for a book (written by the construct step; read only here). */
export function PlanSection({ market, book, targetTe }: { market: Market; book: ConstructionPlan["book"]; targetTe: number | null }) {
  const [open, setOpen] = useState<"fixed" | "skipped" | null>(null);
  const got = useLoad(
    () =>
      latestConstructionPlan(market, book).then((row) => {
        let payload: ConstructionPlanPayload | null = null;
        try {
          payload = row ? (JSON.parse(row.plan_json) as ConstructionPlanPayload) : null;
        } catch {
          payload = null;
        }
        return { hit: row ? { row, payload } : null };
      }),
    [market, book],
    { hit: null },
  );
  const title = book === "fund" ? "Construction plan" : "Rebalance plan";

  const head = (meta?: string) => (
    <div className="m-shead">
      <h2 className="m-h2">{title}</h2>
      {meta && <span className="m-meta">{meta}</span>}
    </div>
  );

  if (got === null)
    return (
      <section>
        {head()}
        <p className="m-empty">Loading…</p>
      </section>
    );
  if (got.hit === null) {
    return (
      <section>
        {head()}
        <p className="m-empty">
          {targetTe == null
            ? "No risk budget set on this desk: the plan is sized to its target tracking error. Set one in the mandate below."
            : `No ${book} plan stored yet: the desk's construct step writes one each session.`}
        </p>
      </section>
    );
  }

  const { row, payload } = got.hit;
  const lines = (payload?.lines ?? []).filter((l) => l.shares != null && l.shares !== 0);
  const fixed = payload?.fixed ?? [];
  const skipped = payload?.skipped ?? [];
  const skippedCount = payload?.skipped_count ?? skipped.length;
  const buy = lines.filter((l) => (l.value ?? 0) > 0).reduce((s, l) => s + (l.value ?? 0), 0);
  const sell = lines.filter((l) => (l.value ?? 0) < 0).reduce((s, l) => s - (l.value ?? 0), 0);
  const shares = (n: number) => Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: market === "IN" ? 0 : 2 });
  const beta = (x: number | null) => (x == null ? "—" : x.toFixed(2));
  const arrow = (a: string, b: string) => (
    <>
      <span className="m-ink3">{a}</span> → {b}
    </>
  );

  const stats: [string, React.ReactNode, string?][] = [
    ["Tracking error", arrow(pct(row.te_before), pct(row.te_after)), `target ${pct(row.target_te)} · ${BINDING[row.binding] ?? row.binding}`],
    ["Beta", arrow(beta(row.beta_before), beta(row.beta_after)), payload?.index ? `vs ${payload.index}` : undefined],
    ["1-day VaR 95%", arrow(pct(row.var95_before), pct(row.var95_after)), row.var95_after == null ? undefined : `${money(row.var95_after * row.nav, market)} of ${money(row.nav, market)}`],
    ["Sells / buys", `${money(sell, market)} / ${money(buy, market)}`],
    ["Expected alpha", pct(row.alpha), "confidence × upside, weighted"],
  ];

  const toggle = (key: "fixed" | "skipped", label: string, items: { ticker: string; reason: string; label?: string | null }[]) => (
    <div style={{ padding: "9px 0", borderTop: "1px solid var(--line)", fontSize: 13 }}>
      <button className="m-link" aria-expanded={open === key} onClick={() => setOpen((o) => (o === key ? null : key))}>
        {label} {open === key ? "▴" : "▾"}
      </button>
      {open === key &&
        items.map((u) => (
          <div key={u.ticker} className="m-sub" style={{ marginTop: 6 }}>
            <span style={{ fontWeight: 600, color: "var(--ink)" }}>{u.ticker}</span>
            {u.label ? ` · ${u.label}` : ""} · {u.reason}
          </div>
        ))}
    </div>
  );

  return (
    <section>
      {head(`Session ${row.session}`)}
      <div className="m-stats" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", marginBottom: 12 }}>
        {stats.map(([k, v, sub]) => (
          <div key={k}>
            <div className="k">{k}</div>
            <div className="v" style={{ fontSize: 20 }}>
              {v}
            </div>
            {sub && <div className="m-meta">{sub}</div>}
          </div>
        ))}
      </div>
      {lines.length === 0 ? (
        <p className="m-empty">
          {fixed.length && !(payload?.lines ?? []).length
            ? "No trades: the plan holds every name as it is (why below)."
            : "No trades: the book already sits at the plan's weights."}
        </p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <div style={{ minWidth: 520 }}>
            {lines.map((l) => {
              const isBuy = (l.shares ?? 0) > 0;
              return (
                <div key={l.ticker} style={{ padding: "11px 0", borderTop: "1px solid var(--line)" }}>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "minmax(110px,1.4fr) 56px repeat(3,minmax(70px,1fr))",
                      gap: 12,
                      fontSize: 14,
                      fontVariantNumeric: "tabular-nums",
                      alignItems: "baseline",
                    }}
                  >
                    <span style={{ fontWeight: 600, minWidth: 0 }} title={l.label ?? undefined}>
                      {l.ticker}
                      {l.role === "core" && <span className="m-meta"> · core</span>}
                    </span>
                    <span style={{ fontWeight: 600, color: isBuy ? "var(--up)" : "var(--down)" }}>{isBuy ? "Buy" : "Sell"}</span>
                    <span style={{ textAlign: "right" }}>{shares(l.shares ?? 0)} sh</span>
                    <span style={{ textAlign: "right" }}>{money(Math.abs(l.value ?? 0), market)}</span>
                    <span className="m-ink2" style={{ textAlign: "right" }}>
                      {pct(l.from, 1)} → {pct(l.toRounded, 1)}
                    </span>
                  </div>
                  {l.why && (
                    <div className="m-sub" style={{ marginTop: 3, fontSize: 12 }}>
                      {l.why}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
      {book === "fund" && <PlanCore market={market} planId={row.$id} line={lines.find((l) => l.role === "core") ?? null} />}
      {fixed.length > 0 &&
        toggle("fixed", `${fixed.length} held as they are`, fixed.map((f) => ({ ...f, reason: `${pct(f.weight, 1)} · ${f.reason}` })))}
      {skippedCount > 0 &&
        (skipped.length ? (
          toggle("skipped", `${skippedCount} left out`, skipped)
        ) : (
          <p className="m-sub" style={{ padding: "9px 0", margin: 0, borderTop: "1px solid var(--line)" }}>
            {skippedCount} left out (reasons not stored)
          </p>
        ))}
      <p className="m-note">
        {new Date(row.captured_at).toLocaleString()}
        {payload?.marks ? ` · marks: ${payload.marks}` : ""}.{" "}
        {book === "fund"
          ? `The PM sizes each buy to its line; the broker trades the ${payload?.core ?? "index"} core to the plan once a session.`
          : "Advisory only: nothing is sent to a broker."}
      </p>
    </section>
  );
}

export type CoreLine = NonNullable<ConstructionPlanPayload["lines"]>[number];

/** The core line a fund plan trades, if any. */
export function coreLineOf(row: ConstructionPlan | null): CoreLine | null {
  if (!row) return null;
  try {
    const p = JSON.parse(row.plan_json) as ConstructionPlanPayload;
    return (p.lines ?? []).find((l) => l.role === "core" && l.shares != null && l.shares !== 0) ?? null;
  } catch {
    return null;
  }
}

/** Read the desk's core approval (/api/core/approve), or post a decision on it. */
async function coreApproval(market: Market, body?: { action: "approve" | "undo"; planId?: string }) {
  const res = await operatorFetch(
    body ? "/api/core/approve" : `/api/core/approve?market=${market}`,
    body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ market, ...body }) } : { cache: "no-store" },
  );
  const j = (await res.json().catch(() => ({}))) as { approval?: CoreApproval | null; error?: string };
  if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
  return j.approval ?? null;
}

/** The desk's core approval, null while it loads; `reload` after a decision. */
export function useCoreApproval(market: Market): { got: { a: CoreApproval | null } | null; reload: () => void } {
  const [nonce, setNonce] = useState(0);
  const got = useLoad(() => coreApproval(market).then((a) => ({ a })), [market, nonce], { a: null });
  return { got, reload: () => setNonce((n) => n + 1) };
}

/** Whether the core trade still waits on the operator: a trade on the plan and no open approval. */
export const corePending = (line: CoreLine | null, a: CoreApproval | null) => !!line?.shares && a?.status !== "approved";

function PlanCore({ market, planId, line }: { market: Market; planId: string; line: CoreLine | null }) {
  const { got, reload } = useCoreApproval(market);
  if (!got) return null;
  return <CoreDecision market={market} planId={planId} line={line} approval={got.a} onDecided={reload} />;
}

/**
 * The plan's index-core trade as a decision: approve it and the next desk run
 * fills it at a live price, the same side and at most these shares.
 */
export function CoreDecision({
  market,
  planId,
  line,
  approval: a,
  onDecided,
}: {
  market: Market;
  planId: string;
  line: CoreLine | null;
  approval: CoreApproval | null;
  onDecided: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = a?.status === "approved" ? a : null;
  const shares = line?.shares ?? 0;
  if (!open && !(line && shares)) return null;

  async function decide(action: "approve" | "undo") {
    setBusy(true);
    setError(null);
    try {
      await coreApproval(market, { action, planId });
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
    onDecided();
  }

  const desk = market === "IN" ? "India" : "US";
  const run = runLabel(nextDeskRun(market));
  const side = shares > 0 ? "Buy" : "Sell";
  return (
    <div className="m-card" style={{ margin: "14px 0 4px", display: "flex", flexWrap: "wrap", alignItems: "center", gap: "10px 16px" }}>
      <div style={{ flex: "1 1 280px", minWidth: 0 }}>
        {open ? (
          <>
            <div style={{ fontWeight: 600 }}>
              Core rebalance approved: {open.side} up to {open.max_shares.toLocaleString()} {open.ticker}
            </div>
            <div className="m-sub" style={{ fontSize: 13 }}>
              Approved {clockOrDate(open.approved_at)} on the {open.plan_session} plan. The {desk} run {run} fills it at the live
              price, re-sized on the book then; it holds if the plan has turned to the other side.
            </div>
          </>
        ) : (
          <>
            <div style={{ fontWeight: 600 }}>
              Needs your decision: {side.toLowerCase()} {Math.abs(shares).toLocaleString()} {line!.ticker} for the index core
            </div>
            <div className="m-sub" style={{ fontSize: 13 }}>
              {money(Math.abs(line!.value ?? 0), market)} · core {pct(line!.from, 1)} → {pct(line!.toRounded, 1)} of NAV. Approve and the{" "}
              {desk} run {run} fills it at the live price, never more than these shares.
            </div>
          </>
        )}
        {a && !open && a.status !== "withdrawn" && a.done_at && (
          <div className="m-meta" style={{ marginTop: 4 }}>
            Last approval {a.status} {clockOrDate(a.done_at)}
            {a.detail ? `: ${a.detail}` : ""}
          </div>
        )}
        {error && (
          <div className="m-sub" style={{ color: "var(--down)", fontSize: 13, marginTop: 4 }}>
            {error}
          </div>
        )}
      </div>
      {open ? (
        <button className="m-btn2" disabled={busy} onClick={() => decide("undo")}>
          Undo
        </button>
      ) : (
        <button className="m-btn" disabled={busy} onClick={() => decide("approve")}>
          Approve {side.toLowerCase()} {Math.abs(shares).toLocaleString()} {line!.ticker}
        </button>
      )}
    </div>
  );
}
