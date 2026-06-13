import { listApps } from "@/lib/kite/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The Kite apps configured in the environment, for the "Connect account" UI.
 * Returns only the slug, label, and api_key — never the secret. The api_key is
 * not sensitive (it's sent to Kite in the public login URL) and lets the client
 * map an existing account to the app it should reconnect through.
 */
export function GET() {
  const apps = listApps().map((a) => ({ slug: a.slug, label: a.label, apiKey: a.apiKey }));
  return Response.json({ apps });
}
