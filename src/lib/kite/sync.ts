import "server-only";
import { type Databases, ID, Query } from "node-appwrite";
import { createAdminClient, DATABASE_ID } from "@/lib/appwrite/server";
import { COLLECTIONS } from "@/lib/appwrite/schema";
import { getHoldings, getEquityCash, getApp, KiteAuthError } from "./client";

export type SyncResult = {
  accountId: string;
  holdings: number;
  navInr: number;
  pnl: number;
  status: "connected" | "needs_reauth" | "error";
};

/**
 * Pull a connected Kite account's live holdings and project them onto the
 * India book:
 *   - replace this account's `positions` rows (market="IN") with fresh marks,
 *   - stamp the account with holdings_count / equity_cash / last_synced_at,
 *   - append one aggregate `fund_snapshots` row (market="IN") covering *all*
 *     connected accounts, so multiple Kite accounts roll up into a single India
 *     fund NAV the Portfolio screen can chart (see {@link snapshotIndiaFund}).
 *
 * Positions tagged with this `kite_account_id` are reconstructed from Kite on
 * every sync, so replacing them is non-destructive (they are a cache of the
 * brokerage's truth, not operator-authored data).
 *
 * Pass `snapshot: false` to skip the fund snapshot — used by
 * {@link syncAllAccounts} so a multi-account refresh writes exactly one snapshot
 * at the end instead of one competing snapshot per account.
 */
export async function syncAccount(
  accountId: string,
  opts: { snapshot?: boolean } = {},
): Promise<SyncResult> {
  const { databases } = createAdminClient();

  const account = await databases.getDocument(DATABASE_ID, COLLECTIONS.kite_accounts, accountId);
  const accessToken = String(account.access_token || "");
  if (!accessToken) {
    await databases.updateDocument(DATABASE_ID, COLLECTIONS.kite_accounts, accountId, { status: "needs_reauth" });
    return { accountId, holdings: 0, navInr: 0, pnl: 0, status: "needs_reauth" };
  }
  // Each account authenticates against its own Kite app; fall back to the
  // default app for legacy rows whose api_key predates multi-app support.
  const apiKey = String(account.api_key || "") || getApp().apiKey;

  let holdings;
  let cash = 0;
  try {
    [holdings, cash] = await Promise.all([getHoldings(apiKey, accessToken), getEquityCash(apiKey, accessToken)]);
  } catch (err) {
    const status = err instanceof KiteAuthError ? "needs_reauth" : "error";
    await databases.updateDocument(DATABASE_ID, COLLECTIONS.kite_accounts, accountId, { status });
    return { accountId, holdings: 0, navInr: 0, pnl: 0, status };
  }

  const investedMV = holdings.reduce((s, h) => s + h.last_price * h.quantity, 0);
  const navInr = investedMV + cash;
  const totalPnl = holdings.reduce((s, h) => s + h.pnl, 0);
  const denom = investedMV || 1;

  // Replace this account's cached positions. Carry forward any factor exposures
  // computed by the India enrichment (keyed by ticker) so a re-sync doesn't wipe
  // them — they're slow-moving betas, not part of the brokerage's truth.
  const existing = await databases.listDocuments(DATABASE_ID, COLLECTIONS.positions, [
    Query.equal("kite_account_id", accountId),
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
    holdings
      .filter((h) => h.quantity !== 0)
      .map((h) => {
        const mv = h.last_price * h.quantity;
        const ticker = h.tradingsymbol.slice(0, 16);
        return databases.createDocument(DATABASE_ID, COLLECTIONS.positions, ID.unique(), {
          ticker,
          qty: h.quantity,
          avg_cost: Number(h.average_price.toFixed(2)),
          market_value: Number(mv.toFixed(2)),
          unrealized_pnl: Number(h.pnl.toFixed(2)),
          weight: Number((mv / denom).toFixed(6)),
          factor_exposures_json: priorFactors.get(ticker) ?? null,
          market: "IN",
          kite_account_id: accountId,
        });
      }),
  );

  await databases.updateDocument(DATABASE_ID, COLLECTIONS.kite_accounts, accountId, {
    status: "connected",
    holdings_count: holdings.length,
    equity_cash: Number(cash.toFixed(2)),
    last_synced_at: new Date().toISOString(),
  });

  // Roll this account's fresh marks into the combined India fund snapshot.
  if (opts.snapshot !== false) await snapshotIndiaFund(databases);

  return { accountId, holdings: holdings.length, navInr, pnl: totalPnl, status: "connected" };
}

/**
 * Recompute the India fund's aggregate NAV across *every* connected Kite account
 * and append one `fund_snapshots` row (market="IN"). NAV = Σ market value of all
 * IN positions (every account) + Σ equity cash (every account); pnl_daily is the
 * day-over-day NAV change vs the most recent IN snapshot (a real session delta),
 * falling back to lifetime unrealized P&L when there is no prior snapshot.
 *
 * This is what makes multiple Kite accounts behave as one India book — each
 * account caches its own positions, but the fund NAV time series is the sum.
 */
export async function snapshotIndiaFund(databases: Databases): Promise<{ nav: number; pnl: number }> {
  const positions = await databases.listDocuments(DATABASE_ID, COLLECTIONS.positions, [
    Query.equal("market", "IN"),
    Query.limit(1000),
  ]);
  const investedMV = positions.documents.reduce(
    (s, p) => s + Number((p as { market_value?: number }).market_value ?? 0),
    0,
  );
  const totalPnl = positions.documents.reduce(
    (s, p) => s + Number((p as { unrealized_pnl?: number }).unrealized_pnl ?? 0),
    0,
  );

  const accounts = await databases.listDocuments(DATABASE_ID, COLLECTIONS.kite_accounts, [Query.limit(25)]);
  const cash = accounts.documents.reduce(
    (s, a) => s + Number((a as { equity_cash?: number }).equity_cash ?? 0),
    0,
  );
  const navInr = investedMV + cash;

  const lastSnap = await databases.listDocuments(DATABASE_ID, COLLECTIONS.fund_snapshots, [
    Query.equal("market", "IN"),
    Query.orderDesc("captured_at"),
    Query.limit(1),
  ]);
  const prevNav = (lastSnap.documents[0] as { nav_usd?: number } | undefined)?.nav_usd;
  const dayPnl = typeof prevNav === "number" ? navInr - prevNav : totalPnl;

  await databases
    .createDocument(DATABASE_ID, COLLECTIONS.fund_snapshots, ID.unique(), {
      nav_usd: Number(navInr.toFixed(2)),
      pnl_daily: Number(dayPnl.toFixed(2)),
      captured_at: new Date().toISOString(),
      market: "IN",
    })
    .catch(() => {});

  return { nav: navInr, pnl: totalPnl };
}

/** Sync every connected account, then write one combined India fund snapshot. */
export async function syncAllAccounts(): Promise<SyncResult[]> {
  const { databases } = createAdminClient();
  const accounts = await databases.listDocuments(DATABASE_ID, COLLECTIONS.kite_accounts, [Query.limit(25)]);
  const out: SyncResult[] = [];
  for (const a of accounts.documents) {
    out.push(await syncAccount(a.$id, { snapshot: false }));
  }
  if (out.some((r) => r.status === "connected")) await snapshotIndiaFund(databases);
  return out;
}

/**
 * Upsert a Kite account after a successful token exchange. `apiKey` is the key
 * of the app the account authenticated against — stored so re-syncs and
 * reconnects use the same app (each Personal app is one Zerodha user).
 */
export async function upsertAccount(
  session: {
    user_id: string;
    user_name?: string;
    access_token: string;
    public_token?: string;
  },
  apiKey: string,
): Promise<string> {
  const { databases } = createAdminClient();

  const existing = await databases.listDocuments(DATABASE_ID, COLLECTIONS.kite_accounts, [
    Query.equal("kite_user_id", session.user_id),
    Query.limit(1),
  ]);

  const fields = {
    label: session.user_name || session.user_id,
    kite_user_id: session.user_id,
    api_key: apiKey,
    access_token: session.access_token,
    public_token: session.public_token || null,
    status: "connected" as const,
  };

  if (existing.documents[0]) {
    const id = existing.documents[0].$id;
    await databases.updateDocument(DATABASE_ID, COLLECTIONS.kite_accounts, id, fields);
    return id;
  }
  const created = await databases.createDocument(DATABASE_ID, COLLECTIONS.kite_accounts, ID.unique(), {
    operator_id: null,
    equity_cash: 0,
    holdings_count: 0,
    last_synced_at: null,
    ...fields,
  });
  return created.$id;
}
