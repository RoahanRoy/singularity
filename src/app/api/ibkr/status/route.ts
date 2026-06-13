import { authStatus, gatewayUrl } from "@/lib/ibkr/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Is the local Client Portal Gateway up and holding an authenticated IBKR
 * session? The "Connect IBKR" UI polls this to know whether the operator still
 * needs to log into the gateway in their browser.
 */
export async function GET() {
  try {
    const auth = await authStatus();
    return Response.json({ gateway: gatewayUrl(), ...auth });
  } catch (err) {
    return Response.json({ gateway: gatewayUrl(), authenticated: false, connected: false, competing: false, error: (err as Error).message });
  }
}
