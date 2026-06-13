import { connectFromGateway } from "@/lib/ibkr/sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Register the IBKR account(s) the authenticated gateway exposes and do a first
 * holdings sync. Called by the "Connect IBKR account" button after the operator
 * has logged into the Client Portal Gateway in their browser.
 */
export async function POST() {
  try {
    const result = await connectFromGateway();
    if (result.status === "needs_reauth") {
      return Response.json(
        { error: "IBKR gateway is not authenticated — open the gateway URL and log in, then retry." },
        { status: 409 },
      );
    }
    return Response.json(result);
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}
