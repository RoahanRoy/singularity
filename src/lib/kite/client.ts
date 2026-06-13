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

/**
 * A registered Kite Connect app. Zerodha's Personal apps are single-user (locked
 * to the Zerodha id that created them), so to aggregate a second account we run a
 * second Personal app owned by that account. Each app's key+secret live in env
 * (never the DB); accounts reference their app by `api_key`.
 *
 * Env layout: app "1" is KITE_API_KEY / KITE_API_SECRET (+ optional KITE_APP_LABEL);
 * apps 2..5 are KITE_API_KEY_<n> / KITE_API_SECRET_<n> (+ optional KITE_APP_LABEL_<n>).
 */
export type KiteApp = { slug: string; label: string; apiKey: string; apiSecret: string };

function readApp(slug: string, keyEnv: string, secretEnv: string, labelEnv: string): KiteApp | null {
  const apiKey = process.env[keyEnv];
  const apiSecret = process.env[secretEnv];
  if (!apiKey || !apiSecret) return null;
  return { slug, label: process.env[labelEnv] || `App ${slug}`, apiKey, apiSecret };
}

/** Every Kite app configured in the environment, in slug order. */
export function listApps(): KiteApp[] {
  const apps: KiteApp[] = [];
  const first = readApp("1", "KITE_API_KEY", "KITE_API_SECRET", "KITE_APP_LABEL");
  if (first) apps.push(first);
  for (let n = 2; n <= 5; n++) {
    const a = readApp(String(n), `KITE_API_KEY_${n}`, `KITE_API_SECRET_${n}`, `KITE_APP_LABEL_${n}`);
    if (a) apps.push(a);
  }
  return apps;
}

/** Resolve an app by slug (default: the first configured app). */
export function getApp(slug?: string): KiteApp {
  const apps = listApps();
  if (apps.length === 0) throw new Error("KITE_API_KEY is not set");
  if (!slug) return apps[0];
  const found = apps.find((a) => a.slug === slug);
  if (!found) throw new Error(`Kite app "${slug}" is not configured`);
  return found;
}

/** Resolve the app a stored account belongs to, by its api_key. */
export function getAppByKey(apiKey: string): KiteApp | null {
  return listApps().find((a) => a.apiKey === apiKey) ?? null;
}

/** Where Kite sends the operator back after login. */
export function redirectUrl(): string {
  const base = process.env.KITE_REDIRECT_BASE || "http://localhost:3000";
  return `${base.replace(/\/$/, "")}/api/kite/callback`;
}

/** The hosted Kite login URL the operator is sent to, for a given app. */
export function loginUrl(app: KiteApp): string {
  return `${KITE_LOGIN}?v=${KITE_VERSION}&api_key=${encodeURIComponent(app.apiKey)}`;
}

export type KiteSession = {
  user_id: string;
  user_name?: string;
  access_token: string;
  public_token?: string;
};

/**
 * Exchange a `request_token` (from the login redirect) for an access token,
 * against a specific app. checksum = SHA-256(api_key + request_token + api_secret).
 */
export async function exchangeToken(requestToken: string, app: KiteApp): Promise<KiteSession> {
  const checksum = createHash("sha256")
    .update(app.apiKey + requestToken + app.apiSecret)
    .digest("hex");

  const body = new URLSearchParams({
    api_key: app.apiKey,
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

function authHeader(apiKey: string, accessToken: string): Record<string, string> {
  return {
    "X-Kite-Version": KITE_VERSION,
    Authorization: `token ${apiKey}:${accessToken}`,
  };
}

/**
 * Fetch the operator's equity holdings. Throws KiteAuthError on a 403/401 so
 * the caller can flip the stored account to `needs_reauth` (tokens expire daily).
 */
export async function getHoldings(apiKey: string, accessToken: string): Promise<KiteHolding[]> {
  const res = await fetch(`${KITE_API}/portfolio/holdings`, { headers: authHeader(apiKey, accessToken) });
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
export async function getEquityCash(apiKey: string, accessToken: string): Promise<number> {
  try {
    const res = await fetch(`${KITE_API}/user/margins/equity`, { headers: authHeader(apiKey, accessToken) });
    if (!res.ok) return 0;
    const json = (await res.json().catch(() => null)) as
      | { status?: string; data?: { net?: number } }
      | null;
    return Number(json?.data?.net ?? 0) || 0;
  } catch {
    return 0;
  }
}
