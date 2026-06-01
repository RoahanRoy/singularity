import { loginUrl } from "@/lib/kite/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Kick off the Kite Connect login by redirecting to the hosted login page. */
export function GET() {
  try {
    return Response.redirect(loginUrl(), 302);
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}
