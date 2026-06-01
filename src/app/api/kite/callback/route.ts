import { exchangeToken } from "@/lib/kite/client";
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
    const session = await exchangeToken(requestToken);
    const accountId = await upsertAccount(session);
    // First sync is best-effort — the account is connected either way.
    await syncAccount(accountId).catch(() => {});
    return Response.redirect(`${base}/?market=IN&kite=connected`, 302);
  } catch (err) {
    console.error("[kite/callback]", (err as Error).message);
    return Response.redirect(`${base}/?market=IN&kite=error`, 302);
  }
}
