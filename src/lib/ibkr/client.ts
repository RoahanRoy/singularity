import "server-only";
import { request as httpsRequest, Agent } from "node:https";
import { setTimeout as delay } from "node:timers/promises";

/**
 * Interactive Brokers Client Portal Web API client. Server-only.
 *
 * Unlike Kite (hosted OAuth redirect), IBKR's Client Portal API runs behind a
 * **local gateway** the operator launches and authenticates in a browser:
 *
 *   1. Download + run the Client Portal Gateway (Java) — it listens on
 *      https://localhost:5000 with a self-signed cert.
 *   2. Open https://localhost:5000 and complete the IBKR SSO login.
 *   3. This app then talks REST to the gateway; the brokerage session lives in
 *      the gateway, not here, so we store no IBKR password or token.
 *
 * Because the session is brokerage-side, "connecting an account" here just means
 * recording which IBKR account id(s) the authenticated gateway exposes. The
 * session goes stale after inactivity → status flips to `needs_reauth` and the
 * operator re-logs into the gateway (mirrors Kite's daily token expiry).
 *
 * Docs: https://www.interactivebrokers.com/api/doc.html (Client Portal Web API)
 *   - Auth status: POST /iserver/auth/status
 *   - Keepalive:   POST /tickle
 *   - Accounts:    GET  /portfolio/accounts
 *   - Positions:   GET  /portfolio/{accountId}/positions/{pageId}
 *   - Cash:        GET  /portfolio/{accountId}/ledger
 *
 * The gateway cert is self-signed, so we use a node:https Agent scoped to these
 * requests (rejectUnauthorized:false applies only here, never globally).
 */

const API_PREFIX = "/v1/api";

/** Base URL of the running Client Portal Gateway. */
export function gatewayUrl(): string {
  return (process.env.IBKR_GATEWAY_URL || "https://localhost:5000").replace(/\/$/, "");
}

export class IbkrAuthError extends Error {}

// Self-signed-cert agent, reused across requests. Only honored for HTTPS.
const insecureAgent = new Agent({ rejectUnauthorized: false });

type Json = Record<string, unknown> | unknown[] | null;

/**
 * Low-level JSON call against the gateway. Uses node:https so we can accept the
 * gateway's self-signed cert via a scoped agent (native fetch can't take one).
 * Throws IbkrAuthError on 401, so callers can flip the account to needs_reauth.
 */
function gatewayRequest(method: "GET" | "POST", path: string, body?: unknown): Promise<Json> {
  const url = new URL(`${gatewayUrl()}${API_PREFIX}${path}`);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const isHttps = url.protocol === "https:";

  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method,
        agent: isHttps ? insecureAgent : undefined,
        headers: {
          "User-Agent": "meridian/1.0",
          Accept: "application/json",
          ...(payload
            ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
            : {}),
        },
        timeout: 8000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          if (status === 401) {
            reject(new IbkrAuthError("IBKR gateway session not authenticated"));
            return;
          }
          const text = Buffer.concat(chunks).toString("utf8");
          if (status < 200 || status >= 300) {
            reject(new Error(`IBKR ${method} ${path} failed: ${status} ${text.slice(0, 200)}`));
            return;
          }
          try {
            resolve(text ? (JSON.parse(text) as Json) : null);
          } catch {
            reject(new Error(`IBKR ${method} ${path}: non-JSON response`));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error(`IBKR ${method} ${path}: gateway timed out`)));
    req.on("error", (err) =>
      reject(
        new Error(
          `IBKR gateway unreachable at ${gatewayUrl()} — is the Client Portal Gateway running? (${(err as Error).message})`,
        ),
      ),
    );
    if (payload) req.write(payload);
    req.end();
  });
}

export type IbkrAuthStatus = {
  authenticated: boolean;
  connected: boolean;
  competing: boolean;
};

/**
 * Whether the gateway holds a live, authenticated brokerage session. `tickle`
 * also serves as a keepalive, so we call it before the status check.
 */
export async function authStatus(): Promise<IbkrAuthStatus> {
  await gatewayRequest("POST", "/tickle").catch(() => {});
  const raw = (await gatewayRequest("POST", "/iserver/auth/status").catch(() => null)) as Record<
    string,
    unknown
  > | null;
  return {
    authenticated: Boolean(raw?.authenticated),
    connected: Boolean(raw?.connected),
    competing: Boolean(raw?.competing),
  };
}

export type IbkrAccount = { accountId: string; accountTitle?: string };

/**
 * List the account(s) the authenticated gateway exposes. The portfolio
 * endpoints require /portfolio/accounts to be hit once per session first, so
 * this doubles as that priming call.
 */
export async function getAccounts(): Promise<IbkrAccount[]> {
  const raw = (await gatewayRequest("GET", "/portfolio/accounts")) as unknown[] | null;
  if (!Array.isArray(raw)) return [];
  return raw.map((r) => {
    const a = r as Record<string, unknown>;
    return {
      accountId: String(a.accountId ?? a.id ?? ""),
      accountTitle: a.accountTitle ? String(a.accountTitle) : undefined,
    };
  });
}

export type IbkrPosition = {
  conid: number;
  ticker: string;
  description: string;
  position: number;
  avgPrice: number;
  marketPrice: number;
  marketValue: number;
  unrealizedPnl: number;
  currency: string;
  assetClass: string;
};

function rawPage(accountId: string, page: number): Promise<unknown[]> {
  return gatewayRequest(
    "GET",
    `/portfolio/${encodeURIComponent(accountId)}/positions/${page}`,
  ).then((raw) => (Array.isArray(raw) ? raw : [])) as Promise<unknown[]>;
}

/**
 * Load page 0, polling until the count is stable. The Client Portal gateway
 * loads positions **asynchronously** server-side: a cold call returns a partial
 * (or empty) page, then more rows appear over the next ~second. Trusting the
 * first read silently drops holdings — so we re-read until two consecutive
 * non-empty reads agree (or attempts run out), keeping the largest seen.
 */
async function loadFirstPageStable(accountId: string): Promise<unknown[]> {
  let best: unknown[] = [];
  let prevLen = -1;
  for (let attempt = 0; attempt < 12; attempt++) {
    const raw = await rawPage(accountId, 0);
    if (raw.length > best.length) best = raw;
    // Two equal, non-empty reads in a row ⇒ the server has finished loading.
    if (raw.length > 0 && raw.length === prevLen) return best;
    prevLen = raw.length;
    await delay(500);
  }
  return best;
}

/**
 * Fetch all positions for an account. Page 0 is polled until stable (the gateway
 * warms up lazily); further pages are read straight through, 30 rows per page.
 * Throws IbkrAuthError if the gateway session has dropped.
 */
export async function getPositions(accountId: string): Promise<IbkrPosition[]> {
  const out: IbkrPosition[] = [];
  const pushAll = (rows: unknown[]) => {
    for (const r of rows) {
      const p = r as Record<string, unknown>;
      out.push({
        conid: Number(p.conid ?? 0),
        ticker: String(p.ticker ?? p.contractDesc ?? "").trim(),
        description: String(p.contractDesc ?? p.name ?? ""),
        position: Number(p.position ?? 0),
        // avgPrice is per-share cost; avgCost is the IBKR fallback field.
        avgPrice: Number(p.avgPrice ?? p.avgCost ?? 0),
        marketPrice: Number(p.mktPrice ?? 0),
        marketValue: Number(p.mktValue ?? 0),
        unrealizedPnl: Number(p.unrealizedPnl ?? 0),
        currency: String(p.currency ?? "USD"),
        assetClass: String(p.assetClass ?? "STK"),
      });
    }
  };

  const first = await loadFirstPageStable(accountId);
  pushAll(first);
  if (first.length < 30) return out; // single short page ⇒ that's everything.

  for (let page = 1; page < 50; page++) {
    const raw = await rawPage(accountId, page);
    if (raw.length === 0) break;
    pushAll(raw);
    if (raw.length < 30) break; // IBKR pages are 30 rows; a short page is the last.
  }
  return out;
}

/**
 * USD cash balance from the account ledger, used for NAV cash + buying power.
 * Best-effort: returns 0 if the ledger can't be read.
 */
export async function getCashBalance(accountId: string): Promise<number> {
  try {
    const raw = (await gatewayRequest(
      "GET",
      `/portfolio/${encodeURIComponent(accountId)}/ledger`,
    )) as Record<string, unknown> | null;
    const usd = raw?.USD as Record<string, unknown> | undefined;
    const base = raw?.BASE as Record<string, unknown> | undefined;
    const cash = usd?.cashbalance ?? base?.cashbalance;
    return Number(cash ?? 0) || 0;
  } catch {
    return 0;
  }
}
