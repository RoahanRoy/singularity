"use client";

import { useCallback, useEffect, useState } from "react";
import { fmtMoney } from "@/lib/meridian/format";
import type { FundMandate, Market, RiskPosture } from "@/lib/appwrite/schema";

const POSTURES: RiskPosture[] = ["conservative", "balanced", "aggressive"];

const btn: React.CSSProperties = {
  fontFamily: "var(--mono)",
  fontSize: 11,
  letterSpacing: "0.06em",
  padding: "7px 14px",
  background: "var(--md-accent)",
  color: "#0a0b0e",
  border: 0,
  borderRadius: 5,
  cursor: "pointer",
};

const field: React.CSSProperties = {
  fontFamily: "var(--mono)",
  fontSize: 12,
  padding: "7px 10px",
  background: "var(--bg-0)",
  color: "var(--ink-0)",
  border: "1px solid var(--line-soft)",
  borderRadius: 5,
  width: "100%",
};

const label: React.CSSProperties = {
  fontFamily: "var(--mono)",
  fontSize: 10,
  color: "var(--ink-3)",
  letterSpacing: "0.12em",
  textTransform: "uppercase",
  marginBottom: 4,
  display: "block",
};

/** Onboarding + live status for a desk's from-scratch paper fund. */
export function FundMandatePanel({ market }: { market: Market }) {
  const [mandate, setMandate] = useState<FundMandate | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [capital, setCapital] = useState("1000000");
  const [cash, setCash] = useState("");
  const [posture, setPosture] = useState<RiskPosture>("balanced");
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/fund/onboard", { cache: "no-store" });
      const j = (await res.json()) as { mandates?: Record<Market, FundMandate | null> };
      const m = j.mandates?.[market] ?? null;
      setMandate(m);
      if (m) { setCapital(String(m.capital_base)); setCash(String(m.cash)); setPosture(m.risk_posture); }
    } catch {
      setMandate(null);
    } finally {
      setLoaded(true);
    }
  }, [market]);

  useEffect(() => {
    // Defer the reset+load out of the effect body so the state updates land from
    // an async boundary, not a synchronous cascade (mirrors IbkrAccountsPanel).
    const kick = setTimeout(() => {
      setLoaded(false);
      setEditing(false);
      setBanner(null);
      load();
    }, 0);
    return () => clearTimeout(kick);
  }, [load]);

  async function submit() {
    const cap = Number(capital.replace(/[, ]/g, ""));
    if (!Number.isFinite(cap) || cap <= 0) {
      setBanner({ kind: "err", text: "Enter a positive capital base." });
      return;
    }
    // Undeployed cash is only editable when adjusting an existing mandate; a
    // fresh fund always seeds cash = capital base (nothing deployed yet).
    let cashOverride: number | undefined;
    if (mandate) {
      const c = Number(cash.replace(/[, ]/g, ""));
      if (!Number.isFinite(c) || c < 0) {
        setBanner({ kind: "err", text: "Undeployed cash must be zero or positive." });
        return;
      }
      if (c > cap) {
        setBanner({ kind: "err", text: "Undeployed cash can't exceed the capital base." });
        return;
      }
      cashOverride = c;
    }
    setBusy(true);
    setBanner(null);
    try {
      const res = await fetch("/api/fund/onboard", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ market, capital_base: cap, risk_posture: posture, ...(cashOverride !== undefined ? { cash: cashOverride } : {}) }),
      });
      const j = (await res.json()) as { created?: boolean; error?: string };
      if (!res.ok) {
        setBanner({ kind: "err", text: j.error || "Onboarding failed." });
      } else {
        setBanner({ kind: "ok", text: j.created ? "✓ Fund launched — the desk will start deploying." : "✓ Mandate updated." });
        setEditing(false);
        await load();
      }
    } catch {
      setBanner({ kind: "err", text: "Onboarding failed — network error." });
    } finally {
      setBusy(false);
      setTimeout(() => setBanner(null), 7000);
    }
  }

  const ccy = market === "US" ? "USD" : "INR";

  const form = (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div>
        <label style={label}>Capital base ({ccy})</label>
        <input style={field} inputMode="numeric" value={capital} onChange={(e) => setCapital(e.target.value)} placeholder="1000000" />
      </div>
      {mandate && (() => {
        const cap = Number(capital.replace(/[, ]/g, ""));
        const c = Number(cash.replace(/[, ]/g, ""));
        const deployed = Number.isFinite(cap) && Number.isFinite(c) ? Math.max(0, cap - c) : 0;
        const over = Number.isFinite(cap) && Number.isFinite(c) && c > cap;
        return (
          <div>
            <label style={label}>Undeployed cash ({ccy})</label>
            <input
              style={{ ...field, borderColor: over ? "var(--red)" : "var(--line-soft)" }}
              inputMode="numeric"
              value={cash}
              onChange={(e) => setCash(e.target.value)}
              placeholder="0"
            />
            <div className="mono" style={{ fontSize: 10, color: over ? "var(--red)" : "var(--ink-3)", marginTop: 4 }}>
              {over
                ? "can't exceed the capital base"
                : `deployed = ${fmtMoney(deployed, market)} · adjusting this reconciles the book`}
            </div>
          </div>
        );
      })()}
      <div>
        <label style={label}>Risk posture</label>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6 }}>
          {POSTURES.map((p) => (
            <button
              key={p}
              onClick={() => setPosture(p)}
              style={{
                fontFamily: "var(--mono)", fontSize: 10.5, letterSpacing: "0.04em",
                padding: "7px 6px", borderRadius: 5, cursor: "pointer", textTransform: "capitalize",
                border: `1px solid ${posture === p ? "var(--md-accent)" : "var(--line-soft)"}`,
                background: posture === p ? "color-mix(in srgb, var(--md-accent) 16%, transparent)" : "transparent",
                color: posture === p ? "var(--md-accent)" : "var(--ink-2)",
              }}
            >
              {p}
            </button>
          ))}
        </div>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button style={{ ...btn, opacity: busy ? 0.6 : 1 }} disabled={busy} onClick={submit}>
          {busy ? "…" : mandate ? "Update mandate" : "Launch fund"}
        </button>
        {mandate && (
          <button
            onClick={() => setEditing(false)}
            style={{ ...btn, background: "transparent", color: "var(--ink-2)", border: "1px solid var(--line-soft)" }}
          >
            cancel
          </button>
        )}
      </div>
    </div>
  );

  return (
    <div style={{ padding: "10px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
      {banner && (
        <div
          className="mono"
          style={{
            fontSize: 11, padding: "6px 10px", borderRadius: 5,
            color: banner.kind === "ok" ? "var(--green)" : "var(--red)",
            border: `1px solid ${banner.kind === "ok" ? "var(--green)" : "var(--red)"}`,
          }}
        >
          {banner.text}
        </div>
      )}

      {!loaded ? (
        <div className="dim" style={{ fontFamily: "var(--mono)", fontSize: 11 }}>loading…</div>
      ) : !mandate || editing ? (
        <>
          {!mandate && (
            <div className="dim" style={{ fontFamily: "var(--mono)", fontSize: 11, lineHeight: 1.6 }}>
              No {market} fund yet. Name a capital base and a risk posture — the swarm builds the book
              from scratch, deploying into names as convictions clear. No brokerage required.
            </div>
          )}
          {form}
        </>
      ) : (
        <MandateStatus mandate={mandate} market={market} ccy={ccy} onEdit={() => setEditing(true)} />
      )}
    </div>
  );
}

function MandateStatus({
  mandate, market, ccy, onEdit,
}: { mandate: FundMandate; market: Market; ccy: string; onEdit: () => void }) {
  const deployed = Math.max(0, mandate.capital_base - mandate.cash);
  const deployedPct = mandate.capital_base ? (deployed / mandate.capital_base) * 100 : 0;
  const rows: Array<[string, string]> = [
    ["Capital base", fmtMoney(mandate.capital_base, market)],
    ["Deployed", `${fmtMoney(deployed, market)} · ${deployedPct.toFixed(1)}%`],
    ["Cash undeployed", fmtMoney(mandate.cash, market)],
    ["Posture", mandate.risk_posture],
    ["Caps", `≤${mandate.max_name_weight_pct}%/name · ≤${mandate.max_gross_pct}% gross · ${mandate.max_names} names`],
    ["Pacing", `${mandate.deploy_cap_pct_per_cycle}% of base per cycle`],
  ];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
        <span className="mono" style={{ fontSize: 11, color: "var(--green)", letterSpacing: "0.06em" }}>
          ● {ccy} fund active
        </span>
        <button
          onClick={onEdit}
          style={{ fontFamily: "var(--mono)", fontSize: 10, padding: "3px 10px", borderRadius: 5, cursor: "pointer", background: "transparent", color: "var(--ink-2)", border: "1px solid var(--line-soft)" }}
        >
          adjust
        </button>
      </div>
      {/* Deployment progress */}
      <div style={{ height: 6, borderRadius: 3, background: "var(--line-soft)", overflow: "hidden" }}>
        <div style={{ width: `${Math.min(100, deployedPct)}%`, height: "100%", background: "var(--md-accent)" }} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 0 }}>
        {rows.map(([k, v], i) => (
          <div
            key={i}
            style={{
              display: "grid", gridTemplateColumns: "120px 1fr", gap: 8,
              padding: "6px 0", borderBottom: i < rows.length - 1 ? "1px solid var(--line-soft)" : 0,
              fontFamily: "var(--mono)", fontSize: 11,
            }}
          >
            <span style={{ color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: "0.08em", fontSize: 10 }}>{k}</span>
            <span style={{ color: "var(--ink-1)", textTransform: k === "Posture" ? "capitalize" : "none" }}>{v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
