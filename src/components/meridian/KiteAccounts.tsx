"use client";

import { useEffect, useState } from "react";
import { listKiteAccounts, subscribeKiteAccounts } from "@/lib/appwrite/queries";
import type { KiteAccount } from "@/lib/appwrite/schema";

const STATUS_COLOR: Record<KiteAccount["status"], string> = {
  connected: "var(--green)",
  needs_reauth: "var(--amber)",
  error: "var(--red)",
};

function relTime(iso: string | null): string {
  if (!iso) return "never";
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (!Number.isFinite(s)) return "—";
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function KiteAccountsPanel() {
  const [accounts, setAccounts] = useState<KiteAccount[] | null>(null);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [banner, setBanner] = useState<"connected" | "error" | null>(null);

  useEffect(() => {
    const flag = new URLSearchParams(window.location.search).get("kite");
    if (flag === "connected" || flag === "error") {
      setBanner(flag);
      const t = setTimeout(() => setBanner(null), 6000);
      return () => clearTimeout(t);
    }
  }, []);

  useEffect(() => {
    const cancelled = { v: false };
    listKiteAccounts()
      .then((rows) => { if (!cancelled.v) setAccounts(rows); })
      .catch(() => { if (!cancelled.v) setAccounts([]); });
    const unsub = subscribeKiteAccounts((row) => {
      if (cancelled.v) return;
      setAccounts((prev) => {
        const list = prev ?? [];
        const ix = list.findIndex((a) => a.$id === row.$id);
        if (ix < 0) return [row, ...list];
        const next = list.slice();
        next[ix] = row;
        return next;
      });
    });
    return () => { cancelled.v = true; unsub(); };
  }, []);

  async function syncNow(accountId: string) {
    setSyncing(accountId);
    try {
      await fetch("/api/kite/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId }),
      });
    } catch {
      // status row will simply not change
    } finally {
      setTimeout(() => setSyncing(null), 600);
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

  return (
    <div style={{ padding: "10px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
      {banner && (
        <div
          className="mono"
          style={{
            fontSize: 11,
            padding: "6px 10px",
            borderRadius: 5,
            color: banner === "connected" ? "var(--green)" : "var(--red)",
            border: `1px solid ${banner === "connected" ? "var(--green)" : "var(--red)"}`,
          }}
        >
          {banner === "connected" ? "✓ Kite account connected — holdings synced." : "✗ Kite connection failed. Try again."}
        </div>
      )}

      <button style={btn} onClick={() => { window.location.href = "/api/kite/login"; }}>
        + Connect KITE account
      </button>

      {accounts === null ? (
        <div className="dim" style={{ fontFamily: "var(--mono)", fontSize: 11 }}>loading…</div>
      ) : accounts.length === 0 ? (
        <div className="dim" style={{ fontFamily: "var(--mono)", fontSize: 11, lineHeight: 1.6 }}>
          No Kite accounts connected. Connect one to pull your real NSE/BSE holdings and
          seed the India fund the swarm will track.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {accounts.map((a) => (
            <div
              key={a.$id}
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
              <span style={{ color: STATUS_COLOR[a.status] ?? "var(--ink-3)", fontSize: 13, lineHeight: 1 }}>●</span>
              <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                <span style={{ color: "var(--ink-0)" }}>{a.label} · {a.kite_user_id}</span>
                <span className="dim" style={{ fontSize: 10 }}>
                  {a.status === "needs_reauth"
                    ? "token expired — reconnect"
                    : `${a.holdings_count} holdings · synced ${relTime(a.last_synced_at)}`}
                </span>
              </div>
              {a.status === "needs_reauth" ? (
                <button
                  style={{ ...btn, background: "var(--amber)", padding: "3px 10px" }}
                  onClick={() => { window.location.href = "/api/kite/login"; }}
                >
                  reconnect
                </button>
              ) : (
                <button
                  className="send"
                  style={{ fontSize: 10, padding: "3px 10px" }}
                  disabled={syncing === a.$id}
                  onClick={() => syncNow(a.$id)}
                >
                  {syncing === a.$id ? "…" : "sync now"}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
