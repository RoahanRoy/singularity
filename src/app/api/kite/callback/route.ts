import { NextResponse, type NextRequest } from "next/server";
import { exchangeToken, listApps, type KiteSession } from "@/lib/kite/client";
import { upsertAccount, syncAccount } from "@/lib/kite/sync";
import { KITE_AUTH_COOKIE, kiteAuthCookieOptions, verifyOperatorJwt } from "@/lib/appwrite/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function appBase(req: Request): string {
  return process.env.KITE_REDIRECT_BASE || new URL(req.url).origin;
}

/** Redirect back to the India desk, dropping the one-shot auth cookie. */
function back(base: string, flag: "connected" | "error"): NextResponse {
  const res = NextResponse.redirect(`${base}/desk?market=IN&kite=${flag}`, 302);
  res.cookies.set(KITE_AUTH_COOKIE, "", kiteAuthCookieOptions(0));
  return res;
}

/**
 * Kite redirects here after login with ?request_token=…&status=success.
 * The operator's JWT comes from the cookie /api/kite/login set (a browser
 * redirect carries no Authorization header); without a valid one we refuse
 * before touching the token. Then we exchange the token, persist the account,
 * do a first holdings sync, and bounce the operator back into the India desk.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const requestToken = url.searchParams.get("request_token");
  const status = url.searchParams.get("status");
  const base = appBase(req);

  const denied = await verifyOperatorJwt(req.cookies.get(KITE_AUTH_COOKIE)?.value ?? "");
  if (denied) {
    console.warn(`[kite/callback] refused: operator auth ${denied.status}`);
    return back(base, "error");
  }

  if (status !== "success" || !requestToken) {
    return back(base, "error");
  }

  try {
    // The callback URL is shared by every app, and a request_token can only be
    // exchanged by the app that issued it, so try each configured app until one
    // succeeds. The winning app's key is stored on the account.
    const apps = listApps();
    if (apps.length === 0) throw new Error("no Kite apps configured");
    let session: KiteSession | null = null;
    let usedApiKey = "";
    let lastErr: Error | null = null;
    for (const app of apps) {
      try {
        session = await exchangeToken(requestToken, app);
        usedApiKey = app.apiKey;
        break;
      } catch (err) {
        lastErr = err as Error;
      }
    }
    if (!session) throw lastErr ?? new Error("Kite token exchange failed");

    const accountId = await upsertAccount(session, usedApiKey);
    // First sync is best-effort — the account is connected either way.
    await syncAccount(accountId).catch(() => {});
    return back(base, "connected");
  } catch (err) {
    console.error("[kite/callback]", (err as Error).message);
    return back(base, "error");
  }
}
