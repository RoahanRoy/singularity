import { getApp, loginUrl } from "@/lib/kite/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Kick off the Kite Connect login by redirecting to the hosted login page.
 * `?app=<slug>` selects which configured app to authenticate against (each
 * Personal app is locked to one Zerodha user); defaults to the first app.
 */
export function GET(request: Request) {
  const slug = new URL(request.url).searchParams.get("app") || undefined;
  try {
    return Response.redirect(loginUrl(getApp(slug)), 302);
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}
