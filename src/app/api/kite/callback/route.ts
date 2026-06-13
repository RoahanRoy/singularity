import { exchangeToken, listApps, type KiteSession } from "@/lib/kite/client";
import { upsertAccount, syncAccount } from "@/lib/kite/sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function appBase(req: Request): string {
  return process.env.KITE_REDIRECT_BASE || new URL(req.url).origin;
}

/**
 * Kite redirects here after login with ?request_token=…&status=success.
 * We exchange the token, persist the account, do a first holdings sync, then
 * bounce the operator back into the India desk.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const requestToken = url.searchParams.get("request_token");
  const status = url.searchParams.get("status");
  const base = appBase(req);

  if (status !== "success" || !requestToken) {
    return Response.redirect(`${base}/?market=IN&kite=error`, 302);
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
    return Response.redirect(`${base}/?market=IN&kite=connected`, 302);
  } catch (err) {
    console.error("[kite/callback]", (err as Error).message);
    return Response.redirect(`${base}/?market=IN&kite=error`, 302);
  }
}
