import "server-only";

/**
 * Horizon — the operator's own finance app, where every real investment is
 * maintained (Kite, Zerodha Coin, Groww, IBKR, Trading 212, Revolut, across
 * family members). It serves that book read-only at /api/export/holdings,
 * and its trade log at /api/export/trades, authenticated by a shared bearer token, so Meridian can use it as the source
 * of the real book instead of linking each brokerage itself.
 *
 * Env (server-only):
 *   HORIZON_URL           e.g. https://horizon-seven-hazel.vercel.app (no trailing slash)
 *   HORIZON_EXPORT_TOKEN  same value as Horizon's HOLDINGS_EXPORT_TOKEN
 *
 * Responses are treated as untrusted data: only the known fields are read.
 */

/** One holding as Horizon's export states it. Rupee figures are Horizon's own. */
export type HorizonHolding = {
  key: string;
  name: string;
  /** Exchange symbol ("INFY", "AAPL"); null for a mutual fund. */
  symbol: string | null;
  kind: "stock" | "fund" | "cash" | string;
  member: string;
  broker: string;
  /** What the position is denominated in; "INR" for the Indian book. */
  currency: string;
  schemeCode: string | null;
  quantity: number;
  valueInr: number;
  investedInr: number;
  pnlInr: number;
};

export type HorizonExport = {
  generatedAt: string;
  fx: { eurInr: number; usdInr: number; stale: boolean };
  holdings: HorizonHolding[];
  warnings: string[];
};

/** One buy or sell as Horizon's trade log states it, in the trade's own currency. */
export type HorizonTrade = {
  id: string;
  executedAt: string;
  kind: "stock" | "fund" | string;
  /** Exchange symbol; null for a fund order. */
  symbol: string | null;
  name: string | null;
  broker: string;
  side: "buy" | "sell";
  quantity: number;
  price: number | null;
  amount: number;
  currency: string;
  /** Horizon priced it off the day's close or NAV (a standing instruction's instalment). */
  estimated: boolean;
};

/** Horizon refused the token (401) — the two apps' secrets don't match. */
export class HorizonAuthError extends Error {}

/** Horizon answered 404: its deploy predates the feed asked for. */
export class HorizonMissingFeedError extends Error {}

export function horizonConfig(): { url: string; token: string } | null {
  const url = (process.env.HORIZON_URL || "").replace(/\/+$/, "");
  const token = process.env.HORIZON_EXPORT_TOKEN || "";
  if (!url || !token) return null;
  return { url, token };
}

/**
 * When Horizon is configured it is the book of record for real holdings, and
 * the direct IBKR sync stands down — the same holdings arriving by both routes
 * would be counted twice.
 */
export function horizonConfigured(): boolean {
  return horizonConfig() !== null;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

async function getFeed(path: string, timeoutMs: number): Promise<Record<string, unknown>> {
  const cfg = horizonConfig();
  if (!cfg) throw new Error("HORIZON_URL / HORIZON_EXPORT_TOKEN are not set");

  const res = await fetch(`${cfg.url}${path}`, {
    headers: { Authorization: `Bearer ${cfg.token}` },
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 401) throw new HorizonAuthError("Horizon rejected the export token");
  if (res.status === 404 && !res.headers.get("content-type")?.includes("json")) {
    throw new HorizonMissingFeedError(`Horizon has no ${path} yet — deploy the current Horizon`);
  }
  if (!res.ok) {
    let detail = "";
    try {
      detail = str(((await res.json()) as { error?: unknown }).error);
    } catch {
      // non-JSON error page
    }
    throw new Error(`Horizon export ${res.status}${detail ? ` — ${detail}` : ""}`);
  }
  return (await res.json()) as Record<string, unknown>;
}

export async function fetchHoldings(): Promise<HorizonExport> {
  // Horizon resolves fund NAVs on a cold cache; give it room, not forever.
  const raw = await getFeed("/api/export/holdings", 55_000);
  const fx = (raw.fx ?? {}) as Record<string, unknown>;
  const rows = Array.isArray(raw.holdings) ? (raw.holdings as Record<string, unknown>[]) : [];
  return {
    generatedAt: str(raw.generatedAt),
    fx: { eurInr: num(fx.eurInr), usdInr: num(fx.usdInr), stale: fx.stale === true },
    holdings: rows.map((h) => ({
      key: str(h.key),
      name: str(h.name),
      symbol: strOrNull(h.symbol),
      kind: str(h.kind),
      member: str(h.member),
      broker: str(h.broker),
      currency: str(h.currency).toUpperCase(),
      schemeCode: strOrNull(h.schemeCode),
      quantity: num(h.quantity),
      valueInr: num(h.valueInr),
      investedInr: num(h.investedInr),
      pnlInr: num(h.pnlInr),
    })),
    warnings: Array.isArray(raw.warnings) ? raw.warnings.filter((w): w is string => typeof w === "string") : [],
  };
}

export async function fetchTrades(): Promise<{ generatedAt: string; trades: HorizonTrade[] }> {
  const raw = await getFeed("/api/export/trades", 30_000);
  const rows = Array.isArray(raw.trades) ? (raw.trades as Record<string, unknown>[]) : [];
  return {
    generatedAt: str(raw.generatedAt),
    trades: rows
      .map((t) => ({
        id: str(t.id),
        executedAt: str(t.executedAt),
        kind: str(t.kind),
        symbol: strOrNull(t.symbol),
        name: strOrNull(t.name),
        broker: str(t.broker),
        side: t.side === "sell" ? ("sell" as const) : ("buy" as const),
        quantity: num(t.quantity),
        price: typeof t.price === "number" && Number.isFinite(t.price) ? t.price : null,
        amount: num(t.amount),
        currency: str(t.currency).toUpperCase(),
        estimated: t.estimated === true,
      }))
      .filter((t) => t.id && !Number.isNaN(Date.parse(t.executedAt))),
  };
}
