import { NextResponse } from "next/server";
import { getApp, loginUrl } from "@/lib/kite/client";
import { bearerToken, KITE_AUTH_COOKIE, kiteAuthCookieOptions, requireOperator } from "@/lib/appwrite/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Appwrite JWTs live 15 minutes; past that the callback rejects it anyway.
const KITE_AUTH_TTL_S = 15 * 60;

/**
 * Start the Kite Connect login. Returns `{ url }` of the hosted login page for
 * the client to navigate to (a POST via operatorFetch, so the operator's JWT
 * rides along). `?app=<slug>` selects which configured app to authenticate
 * against (each Personal app is locked to one Zerodha user); defaults to the
 * first app.
 *
 * Zerodha redirects the browser back to /api/kite/callback with no
 * Authorization header, so we park the JWT in an HttpOnly cookie scoped to
 * that path; the callback re-verifies it before exchanging the token.
 */
export async function POST(req: Request) {
  const denied = await requireOperator(req);
  if (denied) return denied;
  const slug = new URL(req.url).searchParams.get("app") || undefined;
  let url: string;
  try {
    url = loginUrl(getApp(slug));
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
  const res = NextResponse.json({ url });
  res.cookies.set(KITE_AUTH_COOKIE, bearerToken(req), kiteAuthCookieOptions(KITE_AUTH_TTL_S));
  return res;
}
