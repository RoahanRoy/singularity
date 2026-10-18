"use client";

import { useCallback, useEffect, useState } from "react";
import type { Market } from "@/lib/appwrite/schema";
import { operatorFetch } from "@/lib/auth/operator-fetch";

export type HorizonStatus = {
  configured: boolean;
  holdings?: Record<Market, number>;
  lastSyncedAt?: string | null;
  error?: string;
};

type SyncResult = {
  status: "synced" | "fresh" | "unauthorized" | "error";
  holdings: Record<Market, number>;
  superseded: number;
  skipped: { ticker: string; reason: string }[];
  error?: string;
};

function relTime(iso: string | null | undefined): string {
  if (!iso) return "never";
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (!Number.isFinite(s)) return "—";
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/**
 * Whether Horizon is the book source (server env), and what it has on each
 * desk. `null` until the first answer, so callers can hold off rendering the
 * direct IBKR panel instead of flashing it.
 */
export function useHorizonStatus(): { status: HorizonStatus | null; refresh: () => void } {
  const [status, setStatus] = useState<HorizonStatus | null>(null);
  const refresh = useCallback(() => {
    operatorFetch("/api/horizon/status", { cache: "no-store" })
      .then((r) => r.json())
      .then((j: HorizonStatus) => setStatus(j))
      .catch(() => setStatus((s) => s ?? { configured: false }));
  }, []);
  useEffect(() => {
    // Deferred out of the effect body: setState lands when the fetch resolves.
    const kick = setTimeout(refresh, 0);
    return () => clearTimeout(kick);
  }, [refresh]);
  return { status, refresh };
}

export function HorizonSourcePanel({
  market,
  status,
  onSynced,
}: {
  market: Market;
  status: HorizonStatus;
  onSynced: () => void;
}) {
  const [syncing, setSyncing] = useState(false);
  const [banner, setBanner] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  async function syncNow() {
    setSyncing(true);
    setBanner(null);
    try {
      const res = await operatorFetch("/api/horizon/sync", { method: "POST" });
      const j = (await res.json()) as { result?: SyncResult; error?: string };
      const r = j.result;
      if (!res.ok || !r) {
        setBanner({
          kind: "err",
          text:
            r?.status === "unauthorized"
              ? "Horizon rejected the token — HORIZON_EXPORT_TOKEN must match Horizon's HOLDINGS_EXPORT_TOKEN."
              : r?.error || j.error || "Sync failed.",
        });
      } else {
        const parts = [`${r.holdings.IN} India · ${r.holdings.US} US holdings`];
        if (r.superseded) parts.push(`${r.superseded} direct broker rows replaced`);
        if (r.skipped.length) parts.push(`${r.skipped.length} skipped (${r.skipped.map((s) => s.ticker).join(", ")})`);
        setBanner({ kind: "ok", text: `✓ Synced from Horizon — ${parts.join(" · ")}.` });
        onSynced();
      }
    } catch {
      setBanner({ kind: "err", text: "Sync failed — is Horizon reachable?" });
    } finally {
      setSyncing(false);
      setTimeout(() => setBanner(null), 9000);
    }
  }

  const btn: React.CSSProperties = {
    fontFamily: "var(--mono)",
    fontSize: 11,
    letterSpacing: "0.06em",
    padding: "6px 12px",
    background: "var(--md-accent)",
    color: "#0a0b0e",
    border: 0,
    borderRadius: 5,
    cursor: "pointer",
  };

  const onDesk = status.holdings?.[market] ?? 0;

  return (
    <div style={{ padding: "10px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
      {banner && (
        <div
          className="mono"
          style={{
            fontSize: 11,
            lineHeight: 1.5,
            padding: "6px 10px",
            borderRadius: 5,
            color: banner.kind === "ok" ? "var(--green)" : "var(--red)",
            border: `1px solid ${banner.kind === "ok" ? "var(--green)" : "var(--red)"}`,
          }}
        >
          {banner.text}
        </div>
      )}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "auto 1fr auto",
          alignItems: "center",
          gap: 10,
          padding: "8px 10px",
          border: "1px solid var(--line-soft)",
          borderRadius: 6,
          fontFamily: "var(--mono)",
          fontSize: 11,
        }}
      >
        <span
          style={{
            color: status.error ? "var(--red)" : status.lastSyncedAt ? "var(--green)" : "var(--amber)",
            fontSize: 13,
            lineHeight: 1,
          }}
        >
          ●
        </span>
        <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
          <span style={{ color: "var(--ink-0)" }}>Horizon · every broker, every member</span>
          <span className="dim" style={{ fontSize: 10 }}>
            {status.error
              ? status.error
              : status.lastSyncedAt
                ? `${onDesk} holdings on this desk · synced ${relTime(status.lastSyncedAt)}`
                : "not synced yet"}
          </span>
        </div>
        <button style={btn} disabled={syncing} onClick={syncNow}>
          {syncing ? "syncing…" : "sync now"}
        </button>
      </div>

      <div className="dim" style={{ fontFamily: "var(--mono)", fontSize: 10.5, lineHeight: 1.6 }}>
        Horizon is the book of record: rupee holdings (Kite, Coin, Groww) land on the India desk,
        everything held abroad on the US desk in USD. The direct IBKR link stands down while it is
        configured. Running desk loops re-pull it every 15 minutes.
      </div>
    </div>
  );
}
