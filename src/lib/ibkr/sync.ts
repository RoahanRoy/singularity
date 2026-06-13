import "server-only";
import { ID, Query } from "node-appwrite";
import { createAdminClient, DATABASE_ID } from "@/lib/appwrite/server";
import { COLLECTIONS } from "@/lib/appwrite/schema";
import { authStatus, getAccounts, getPositions, getCashBalance, IbkrAuthError } from "./client";

export type IbkrSyncResult = {
  accountId: string;
  holdings: number;
  navUsd: number;
  pnl: number;
  status: "connected" | "needs_reauth" | "error";
};

/**
 * Pull a connected IBKR account's live positions from the gateway and project
 * them onto the US book — the same shape as the Kite → India sync, but the US
 * desk and natively USD:
 *   - replace this account's `positions` rows (market="US") with fresh marks,
 *   - append a `fund_snapshots` row (market="US") so the US fund's NAV/PnL
 *     accrues a chartable time series,
 *   - stamp the account with holdings_count / equity_cash / last_synced_at.
 *
 * Positions tagged with this `ibkr_account_id` are reconstructed on every sync,
 * so replacing them is non-destructive (they cache the brokerage's truth, not
 * operator-authored data). Equity-cost factor exposures are carried forward.
 */
export async function syncAccount(docId: string): Promise<IbkrSyncResult> {
  const { databases } = createAdminClient();

  const account = await databases.getDocument(DATABASE_ID, COLLECTIONS.ibkr_accounts, docId);
  const ibkrAccountId = String(account.ibkr_account_id || "");

  // The brokerage session lives in the gateway, not here — verify it's live.
  const auth = await authStatus().catch(() => null);
  if (!auth?.authenticated) {
    await databases.updateDocument(DATABASE_ID, COLLECTIONS.ibkr_accounts, docId, { status: "needs_reauth" });
    return { accountId: ibkrAccountId, holdings: 0, navUsd: 0, pnl: 0, status: "needs_reauth" };
  }

  let positions;
  let cash = 0;
  try {
    await getAccounts(); // primes /portfolio/accounts for the session
    [positions, cash] = await Promise.all([getPositions(ibkrAccountId), getCashBalance(ibkrAccountId)]);
  } catch (err) {
    const status = err instanceof IbkrAuthError ? "needs_reauth" : "error";
    await databases.updateDocument(DATABASE_ID, COLLECTIONS.ibkr_accounts, docId, { status });
    return { accountId: ibkrAccountId, holdings: 0, navUsd: 0, pnl: 0, status };
  }

  // The swarm's book tracks equities; map those onto `positions`. NAV still
  // counts every leg's market value plus cash so it reflects the true account.
  const equities = positions.filter((p) => p.assetClass === "STK" && p.position !== 0);
  const totalMV = positions.reduce((s, p) => s + p.marketValue, 0);
  const navUsd = totalMV + cash;
  const totalPnl = positions.reduce((s, p) => s + p.unrealizedPnl, 0);
  const denom = equities.reduce((s, p) => s + p.marketValue, 0) || 1;

  // Replace this account's cached positions, carrying forward factor exposures
  // (slow-moving betas keyed by ticker, not part of the brokerage's truth).
  const existing = await databases.listDocuments(DATABASE_ID, COLLECTIONS.positions, [
    Query.equal("ibkr_account_id", docId),
    Query.limit(500),
  ]);
  const priorFactors = new Map<string, string | null>();
  for (const d of existing.documents) {
    const t = String((d as { ticker?: string }).ticker ?? "");
    const fx = (d as { factor_exposures_json?: string | null }).factor_exposures_json ?? null;
    if (t) priorFactors.set(t, fx);
  }
  await Promise.all(
    existing.documents.map((d) =>
      databases.deleteDocument(DATABASE_ID, COLLECTIONS.positions, d.$id).catch(() => {}),
    ),
  );

  await Promise.all(
    equities.map((p) => {
      const ticker = p.ticker.slice(0, 16);
      return databases.createDocument(DATABASE_ID, COLLECTIONS.positions, ID.unique(), {
        ticker,
        qty: p.position,
        avg_cost: Number(p.avgPrice.toFixed(2)),
        market_value: Number(p.marketValue.toFixed(2)),
        unrealized_pnl: Number(p.unrealizedPnl.toFixed(2)),
        weight: Number((p.marketValue / denom).toFixed(6)),
        factor_exposures_json: priorFactors.get(ticker) ?? null,
        market: "US",
        ibkr_account_id: docId,
      });
    }),
  );

  // Time-series point for the US fund. pnl_daily is the day-over-day NAV change
  // vs the most recent US snapshot (a real session delta), not lifetime P&L.
  const lastSnap = await databases.listDocuments(DATABASE_ID, COLLECTIONS.fund_snapshots, [
    Query.equal("market", "US"),
    Query.orderDesc("captured_at"),
    Query.limit(1),
  ]);
  const prevNav = (lastSnap.documents[0] as { nav_usd?: number } | undefined)?.nav_usd;
  const dayPnl = typeof prevNav === "number" ? navUsd - prevNav : totalPnl;
  await databases
    .createDocument(DATABASE_ID, COLLECTIONS.fund_snapshots, ID.unique(), {
      nav_usd: Number(navUsd.toFixed(2)),
      pnl_daily: Number(dayPnl.toFixed(2)),
      captured_at: new Date().toISOString(),
      market: "US",
    })
    .catch(() => {});

  await databases.updateDocument(DATABASE_ID, COLLECTIONS.ibkr_accounts, docId, {
    status: "connected",
    holdings_count: equities.length,
    equity_cash: Number(cash.toFixed(2)),
    last_synced_at: new Date().toISOString(),
  });

  return { accountId: ibkrAccountId, holdings: equities.length, navUsd, pnl: totalPnl, status: "connected" };
}

/** Sync every connected IBKR account. */
export async function syncAllAccounts(): Promise<IbkrSyncResult[]> {
  const { databases } = createAdminClient();
  const accounts = await databases.listDocuments(DATABASE_ID, COLLECTIONS.ibkr_accounts, [Query.limit(25)]);
  const out: IbkrSyncResult[] = [];
  for (const a of accounts.documents) {
    out.push(await syncAccount(a.$id));
  }
  return out;
}

/**
 * Record the IBKR account(s) the authenticated gateway currently exposes. This
 * is "connecting an account" for IBKR — the brokerage session itself lives in
 * the gateway, so there is no token to store. Upserts one row per account id.
 */
export async function connectFromGateway(): Promise<{ connected: string[]; status: string }> {
  const auth = await authStatus();
  if (!auth.authenticated) {
    return { connected: [], status: "needs_reauth" };
  }

  const { databases } = createAdminClient();
  const accounts = await getAccounts();
  const connected: string[] = [];

  for (const acct of accounts) {
    if (!acct.accountId) continue;
    const existing = await databases.listDocuments(DATABASE_ID, COLLECTIONS.ibkr_accounts, [
      Query.equal("ibkr_account_id", acct.accountId),
      Query.limit(1),
    ]);
    const fields = {
      label: acct.accountTitle || acct.accountId,
      ibkr_account_id: acct.accountId,
      status: "connected" as const,
    };
    let docId: string;
    if (existing.documents[0]) {
      docId = existing.documents[0].$id;
      await databases.updateDocument(DATABASE_ID, COLLECTIONS.ibkr_accounts, docId, fields);
    } else {
      const created = await databases.createDocument(DATABASE_ID, COLLECTIONS.ibkr_accounts, ID.unique(), {
        operator_id: null,
        equity_cash: 0,
        holdings_count: 0,
        last_synced_at: null,
        ...fields,
      });
      docId = created.$id;
    }
    // First sync is best-effort — the account is connected either way.
    await syncAccount(docId).catch(() => {});
    connected.push(acct.accountId);
  }

  return { connected, status: connected.length ? "connected" : "error" };
}
