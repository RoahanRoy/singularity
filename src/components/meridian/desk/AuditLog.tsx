"use client";

import { useState } from "react";
import { useDesk } from "../Shell";
import { listAuditLog } from "@/lib/appwrite/queries";
import type { AuditLog } from "@/lib/appwrite/schema";
import { humanAction } from "./Today";
import { clockOrDate, decideMemo, useLoad } from "./data";

type Kind = "trade" | "agents" | "guard";
const FILTERS: ["all" | Kind, string][] = [
  ["all", "All"],
  ["trade", "Trades"],
  ["agents", "Agents"],
  ["guard", "Guardrails"],
];
const KIND: Record<Kind, [string, string]> = {
  trade: ["Trade", "accent"],
  agents: ["Agents", ""],
  guard: ["Guardrail", "warn"],
};

// Who wrote the row decides its kind (scripts/agents writeAudit actors).
function kindOf(e: AuditLog): Kind {
  if (["risk-overlay", "circuit-breaker", "budget-controller", "compliance"].includes(e.actor)) return "guard";
  if (e.actor === "operator" || e.actor === "broker" || e.actor === "attribution" || e.actor === "desk") return "trade";
  return "agents";
}

const memoOf = (e: AuditLog) => e.detail.match(/\(memo ([A-Za-z0-9_-]+)\)/)?.[1] ?? null;

export function AuditLogScreen() {
  const { held, reloadHeld } = useDesk();
  const [filter, setFilter] = useState<"all" | Kind>("all");
  const [nonce, setNonce] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const rows = useLoad(() => listAuditLog(200), [nonce], []);

  // An approval can be taken back only while its order is still unfilled.
  const undoable = new Set((held ?? []).filter((m) => m.status === "approved").map((m) => m.$id));
  const latestApproval = new Map<string, string>();
  for (const e of rows ?? []) {
    const id = memoOf(e);
    if (id && !latestApproval.has(id)) latestApproval.set(id, e.$id);
  }

  async function undo(memoId: string) {
    setError(null);
    const err = await decideMemo(memoId, "undo").catch((e: Error) => e.message);
    if (err) setError(err);
    reloadHeld();
    setNonce((n) => n + 1);
  }

  const list = (rows ?? []).filter((e) => filter === "all" || kindOf(e) === filter);

  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "10px 16px", marginBottom: 20 }}>
        <div className="m-seg" role="group" aria-label="Filter">
          {FILTERS.map(([id, label]) => (
            <button key={id} aria-pressed={filter === id} onClick={() => setFilter(id)}>
              {label}
            </button>
          ))}
        </div>
        <span className="m-sub">
          Every approval, fill and guardrail check. An approval can be undone until it executes.
        </span>
      </div>
      {error && (
        <p className="m-sub" style={{ margin: "0 0 12px", color: "var(--down)" }}>
          {error}
        </p>
      )}
      {rows == null ? (
        <p className="m-empty">Loading…</p>
      ) : list.length === 0 ? (
        <p className="m-empty">Nothing in this filter yet.</p>
      ) : (
        list.map((e) => {
          const [label, tone] = KIND[kindOf(e)];
          const memo = memoOf(e);
          const canUndo =
            e.action === "operator_approve" && memo != null && undoable.has(memo) && latestApproval.get(memo) === e.$id;
          return (
            <div
              key={e.$id}
              style={{
                display: "grid",
                gridTemplateColumns: "64px minmax(0,1fr) auto auto",
                gap: "6px 16px",
                alignItems: "baseline",
                padding: "13px 0",
                borderTop: "1px solid var(--line)",
                fontSize: 13,
              }}
            >
              <span className="m-mono m-ink3" style={{ fontSize: 12 }}>
                {clockOrDate(e.occurred_at)}
              </span>
              <span style={{ minWidth: 0 }}>
                <span style={{ fontWeight: 600, color: e.decision === "block" ? "var(--down)" : undefined }}>
                  {humanAction(e.action)}
                </span>{" "}
                <span className="m-ink2">{e.detail || e.target}</span>
                <span className="m-meta" style={{ display: "block" }}>
                  {e.actor === "operator" ? "You" : e.actor}
                  {e.target ? ` · ${e.target}` : ""}
                </span>
              </span>
              <span className={`m-tag ${tone}`} style={{ justifySelf: "start" }}>
                {label}
              </span>
              <span style={{ justifySelf: "end", minWidth: 56, textAlign: "right" }}>
                {canUndo && (
                  <button className="m-btn2" style={{ minHeight: 30, padding: "4px 10px", fontSize: 12 }} onClick={() => undo(memo!)}>
                    Undo
                  </button>
                )}
              </span>
            </div>
          );
        })
      )}
    </div>
  );
}
