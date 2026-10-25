"use client";

import { useState } from "react";
import type { Memo } from "@/lib/appwrite/schema";
import { clockOrDate, heldOrder, pct } from "./data";

/** The parts of deciding on a staged order that Today and Research share. */

// The order the broker sized, and what each gate measured on it. The broker
// only holds an order that cleared the risk budget, the pre-trade overlay and
// compliance; orders staged before the measures were stored say so.
export function planRows(m: Memo, o: ReturnType<typeof heldOrder>): [string, string, string?][] {
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

/** A staged order's plan: size, route and what each gate measured, numbered. */
export function OrderPlan({ memo, order }: { memo: Memo; order: ReturnType<typeof heldOrder> }) {
  return (
    <div>
      <div className="m-label" style={{ marginBottom: 4 }}>
        Action plan
      </div>
      {planRows(memo, order).map(([k, v, tone], i) => (
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
  );
}

/** Decline, asking why first; the reason goes to the audit log with the decision. */
export function DeclineButton({ disabled, onDecline }: { disabled: boolean; onDecline: (reason: string) => void }) {
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");
  if (!asking)
    return (
      <button className="m-btn2" disabled={disabled} onClick={() => setAsking(true)}>
        Decline
      </button>
    );
  return (
    <form
      style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", flex: "1 1 320px" }}
      onSubmit={(e) => {
        e.preventDefault();
        onDecline(reason.trim());
      }}
    >
      <label className="m-sr" htmlFor="decline-why">
        Why decline?
      </label>
      <input
        id="decline-why"
        autoFocus
        value={reason}
        maxLength={300}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Why? e.g. too rich here, wait for the print"
        style={{
          flex: "1 1 220px",
          minWidth: 0,
          padding: "8px 10px",
          border: "1px solid var(--line-2)",
          borderRadius: 6,
          background: "var(--surface)",
          color: "var(--ink)",
          font: "inherit",
          fontSize: 13,
        }}
      />
      <button type="submit" className="m-btn2" disabled={disabled}>
        Decline
      </button>
      <button type="button" className="m-link" onClick={() => setAsking(false)}>
        Cancel
      </button>
    </form>
  );
}
