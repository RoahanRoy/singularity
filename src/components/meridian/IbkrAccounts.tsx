"use client";

import { useCallback, useEffect, useState } from "react";
import { listIbkrAccounts, subscribeIbkrAccounts } from "@/lib/appwrite/queries";
import type { IbkrAccount } from "@/lib/appwrite/schema";

const STATUS_COLOR: Record<IbkrAccount["status"], string> = {
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

type Gateway = { url: string; authenticated: boolean; reachable: boolean };

export function IbkrAccountsPanel() {
  const [accounts, setAccounts] = useState<IbkrAccount[] | null>(null);
  const [gateway, setGateway] = useState<Gateway | null>(null);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [banner, setBanner] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  // The brokerage session lives in the local gateway — poll its auth state so
  // the operator knows whether they still need to log in there.
  const pollStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/ibkr/status", { cache: "no-store" });
      const j = (await res.json()) as { gateway?: string; authenticated?: boolean; error?: string };
      setGateway({
        url: j.gateway || "https://localhost:5000",
        authenticated: Boolean(j.authenticated),
        reachable: !j.error,
      });
    } catch {
      setGateway((g) => (g ? { ...g, reachable: false, authenticated: false } : null));
    }
  }, []);

  useEffect(() => {
    // Defer the first poll out of the effect body (setState lands after the
    // fetch resolves, i.e. from an external system — not a sync cascading render).
    const kick = setTimeout(pollStatus, 0);
    const t = setInterval(pollStatus, 10000);
    return () => { clearTimeout(kick); clearInterval(t); };
  }, [pollStatus]);

  useEffect(() => {
    const cancelled = { v: false };
    listIbkrAccounts()
      .then((rows) => { if (!cancelled.v) setAccounts(rows); })
      .catch(() => { if (!cancelled.v) setAccounts([]); });
    const unsub = subscribeIbkrAccounts((row) => {
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

  async function connect() {
    setConnecting(true);
    setBanner(null);
    try {
      const res = await fetch("/api/ibkr/connect", { method: "POST" });
      const j = (await res.json()) as { connected?: string[]; error?: string };
      if (!res.ok) {
        setBanner({ kind: "err", text: j.error || "Connect failed." });
      } else {
        setBanner({ kind: "ok", text: `✓ Connected ${j.connected?.length ?? 0} IBKR account(s) — holdings synced.` });
      }
    } catch {
      setBanner({ kind: "err", text: "Connect failed — is the gateway running?" });
    } finally {
      setConnecting(false);
      pollStatus();
      setTimeout(() => setBanner(null), 7000);
    }
  }

  async function syncNow(docId: string) {
    setSyncing(docId);
    try {
      await fetch("/api/ibkr/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: docId }),
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

  const gatewayReady = gateway?.reachable && gateway?.authenticated;

  return (
    <div style={{ padding: "10px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
      {banner && (
        <div
          className="mono"
          style={{
            fontSize: 11,
            padding: "6px 10px",
            borderRadius: 5,
            color: banner.kind === "ok" ? "var(--green)" : "var(--red)",
            border: `1px solid ${banner.kind === "ok" ? "var(--green)" : "var(--red)"}`,
          }}
        >
          {banner.text}
        </div>
      )}

      {/* Gateway state — IBKR's session lives in the local Client Portal Gateway. */}
      <div
        className="mono"
        style={{
          fontSize: 10.5,
          lineHeight: 1.5,
          padding: "6px 10px",
          borderRadius: 5,
          border: "1px solid var(--line-soft)",
          color: "var(--ink-2)",
        }}
      >
        {gateway === null ? (
          "checking gateway…"
        ) : !gateway.reachable ? (
          <>Gateway not reachable at <span style={{ color: "var(--ink-0)" }}>{gateway.url}</span>. Launch the IBKR Client Portal Gateway, then refresh.</>
        ) : gateway.authenticated ? (
          <span style={{ color: "var(--green)" }}>● Gateway authenticated — ready to connect.</span>
        ) : (
          <>● Gateway up but not logged in. Open <a href={gateway.url} target="_blank" rel="noreferrer" style={{ color: "var(--md-accent)" }}>{gateway.url}</a> and complete IBKR login.</>
        )}
      </div>

      <button style={{ ...btn, opacity: gatewayReady ? 1 : 0.5, cursor: gatewayReady ? "pointer" : "not-allowed" }} disabled={!gatewayReady || connecting} onClick={connect}>
        {connecting ? "connecting…" : "+ Connect IBKR account"}
      </button>

      {accounts === null ? (
        <div className="dim" style={{ fontFamily: "var(--mono)", fontSize: 11 }}>loading…</div>
      ) : accounts.length === 0 ? (
        <div className="dim" style={{ fontFamily: "var(--mono)", fontSize: 11, lineHeight: 1.6 }}>
          No IBKR accounts connected. Log into the gateway and connect one to pull your real
          US equity positions and seed the US fund the swarm will track.
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
                <span style={{ color: "var(--ink-0)" }}>{a.label} · {a.ibkr_account_id}</span>
                <span className="dim" style={{ fontSize: 10 }}>
                  {a.status === "needs_reauth"
                    ? "gateway session dropped — re-login"
                    : `${a.holdings_count} holdings · synced ${relTime(a.last_synced_at)}`}
                </span>
              </div>
              {a.status === "needs_reauth" ? (
                <button
                  style={{ ...btn, background: "var(--amber)", padding: "3px 10px" }}
                  disabled={connecting}
                  onClick={connect}
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
