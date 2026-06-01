import "server-only";
import { createHash } from "node:crypto";

/**
 * Zerodha Kite Connect HTTP client. Server-only — the API secret never leaves
 * the server, and Kite responses are treated as untrusted data (we read only
 * the known fields we map).
 *
 * Docs: https://kite.trade/docs/connect/v3/
 *   - Login:   https://kite.zerodha.com/connect/login?v=3&api_key=…  →  redirect
 *              back to the app's redirect_url with ?request_token=…&status=success
 *   - Session: POST https://api.kite.trade/session/token  (request_token + checksum)
 *   - Holdings: GET https://api.kite.trade/portfolio/holdings
 */

const KITE_LOGIN = "https://kite.zerodha.com/connect/login";
const KITE_API = "https://api.kite.trade";
const KITE_VERSION = "3";

function apiKey(): string {
  const k = process.env.KITE_API_KEY;
  if (!k) throw new Error("KITE_API_KEY is not set");
  return k;
}

function apiSecret(): string {
  const s = process.env.KITE_API_SECRET;
  if (!s) throw new Error("KITE_API_SECRET is not set");
  return s;
}

/** Where Kite sends the operator back after login. */
export function redirectUrl(): string {
  const base = process.env.KITE_REDIRECT_BASE || "http://localhost:3000";
  return `${base.replace(/\/$/, "")}/api/kite/callback`;
}

/** The hosted Kite login URL the operator is sent to. */
export function loginUrl(): string {
  return `${KITE_LOGIN}?v=${KITE_VERSION}&api_key=${encodeURIComponent(apiKey())}`;
}

export type KiteSession = {
  user_id: string;
  user_name?: string;
  access_token: string;
  public_token?: string;
};

/**
 * Exchange a `request_token` (from the login redirect) for an access token.
 * checksum = SHA-256(api_key + request_token + api_secret).
 */
export async function exchangeToken(requestToken: string): Promise<KiteSession> {
  const checksum = createHash("sha256")
    .update(apiKey() + requestToken + apiSecret())
    .digest("hex");

  const body = new URLSearchParams({
    api_key: apiKey(),
    request_token: requestToken,
    checksum,
  });

  const res = await fetch(`${KITE_API}/session/token`, {
    method: "POST",
    headers: {
      "X-Kite-Version": KITE_VERSION,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  const json = (await res.json().catch(() => null)) as
    | { status?: string; data?: Record<string, unknown>; message?: string }
    | null;

  if (!res.ok || !json || json.status !== "success" || !json.data) {
    throw new Error(`Kite token exchange failed: ${json?.message || res.status}`);
  }
  const d = json.data;
  return {
    user_id: String(d.user_id ?? ""),
    user_name: d.user_name ? String(d.user_name) : undefined,
    access_token: String(d.access_token ?? ""),
    public_token: d.public_token ? String(d.public_token) : undefined,
  };
}

export type KiteHolding = {
  tradingsymbol: string;
  exchange: string;
  quantity: number;
  average_price: number;
  last_price: number;
  pnl: number;
};

export class KiteAuthError extends Error {}

function authHeader(accessToken: string): Record<string, string> {
  return {
    "X-Kite-Version": KITE_VERSION,
    Authorization: `token ${apiKey()}:${accessToken}`,
  };
}

/**
 * Fetch the operator's equity holdings. Throws KiteAuthError on a 403/401 so
 * the caller can flip the stored account to `needs_reauth` (tokens expire daily).
 */
export async function getHoldings(accessToken: string): Promise<KiteHolding[]> {
  const res = await fetch(`${KITE_API}/portfolio/holdings`, { headers: authHeader(accessToken) });
  if (res.status === 401 || res.status === 403) {
    throw new KiteAuthError("Kite access token expired or invalid");
  }
  const json = (await res.json().catch(() => null)) as
    | { status?: string; data?: unknown[]; message?: string }
    | null;
  if (!res.ok || !json || json.status !== "success" || !Array.isArray(json.data)) {
    throw new Error(`Kite holdings fetch failed: ${json?.message || res.status}`);
  }
  return json.data.map((raw) => {
    const h = raw as Record<string, unknown>;
    return {
      tradingsymbol: String(h.tradingsymbol ?? ""),
      exchange: String(h.exchange ?? "NSE"),
      quantity: Number(h.quantity ?? 0),
      average_price: Number(h.average_price ?? 0),
      last_price: Number(h.last_price ?? 0),
      pnl: Number(h.pnl ?? 0),
    };
  });
}

/** Available cash margin (equity segment), used for NAV cash + buying power. */
export async function getEquityCash(accessToken: string): Promise<number> {
  try {
    const res = await fetch(`${KITE_API}/user/margins/equity`, { headers: authHeader(accessToken) });
    if (!res.ok) return 0;
    const json = (await res.json().catch(() => null)) as
      | { status?: string; data?: { net?: number } }
      | null;
    return Number(json?.data?.net ?? 0) || 0;
  } catch {
    return 0;
  }
}
