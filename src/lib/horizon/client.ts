import "server-only";

/**
 * Horizon — the operator's own finance app, where every real investment is
 * maintained (Kite, Zerodha Coin, Groww, IBKR, Trading 212, Revolut, across
 * family members). It serves that book read-only at /api/export/holdings,
 * authenticated by a shared bearer token, so Meridian can use it as the source
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

/** Horizon refused the token (401) — the two apps' secrets don't match. */
export class HorizonAuthError extends Error {}

export function horizonConfig(): { url: string; token: string } | null {
  const url = (process.env.HORIZON_URL || "").replace(/\/+$/, "");
  const token = process.env.HORIZON_EXPORT_TOKEN || "";
  if (!url || !token) return null;
  return { url, token };
}

/**
 * When Horizon is configured it is the book of record for real holdings, and
 * the direct Kite / IBKR syncs stand down — the same holdings arriving by both
 * routes would be counted twice.
 */
export function horizonConfigured(): boolean {
  return horizonConfig() !== null;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

export async function fetchHoldings(): Promise<HorizonExport> {
  const cfg = horizonConfig();
  if (!cfg) throw new Error("HORIZON_URL / HORIZON_EXPORT_TOKEN are not set");

  const res = await fetch(`${cfg.url}/api/export/holdings`, {
    headers: { Authorization: `Bearer ${cfg.token}` },
    cache: "no-store",
    // Horizon resolves fund NAVs on a cold cache; give it room, not forever.
    signal: AbortSignal.timeout(55_000),
  });
  if (res.status === 401) throw new HorizonAuthError("Horizon rejected the export token");
  if (!res.ok) {
    let detail = "";
    try {
      detail = str(((await res.json()) as { error?: unknown }).error);
    } catch {
      // non-JSON error page
    }
    throw new Error(`Horizon export ${res.status}${detail ? ` — ${detail}` : ""}`);
  }

  const raw = (await res.json()) as Record<string, unknown>;
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
