import "server-only";
import { cookies } from "next/headers";
import { Client, Account, Databases, Storage, Users } from "node-appwrite";
import { isOperatorEmail } from "@/lib/auth/allowlist";

const endpoint = process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT!;
const projectId = process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID!;
const apiKey = process.env.APPWRITE_API_KEY!;

export const DATABASE_ID = process.env.NEXT_PUBLIC_APPWRITE_DATABASE_ID!;
export const SESSION_COOKIE = "meridian-session";

function base() {
  return new Client().setEndpoint(endpoint).setProject(projectId);
}

export async function createSessionClient() {
  const client = base();
  const store = await cookies();
  const session = store.get(SESSION_COOKIE);
  if (!session?.value) {
    throw new Error("No active session");
  }
  client.setSession(session.value);
  return {
    account: new Account(client),
    databases: new Databases(client),
    storage: new Storage(client),
  };
}

export async function tryCreateSessionClient() {
  try {
    return await createSessionClient();
  } catch {
    return null;
  }
}

/** Appwrite user label that grants operator access — DB permissions use the same label. */
export const OPERATOR_LABEL = "operator";

/**
 * Short-lived, HttpOnly cookie carrying the operator's Appwrite JWT across the
 * Zerodha login round-trip: /api/kite/login sets it, /api/kite/callback (a
 * browser redirect, so no Authorization header) verifies and clears it.
 */
export const KITE_AUTH_COOKIE = "meridian-kite-auth";

/** Cookie options for KITE_AUTH_COOKIE; maxAge 0 clears it. */
export function kiteAuthCookieOptions(maxAge: number) {
  return {
    path: "/api/kite/callback",
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    maxAge,
  };
}

/** The bearer token from an Authorization header, or "" if there is none. */
export function bearerToken(req: Request): string {
  const header = req.headers.get("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

/**
 * Route-handler guard for operator-only endpoints. The UI signs in with the
 * browser SDK, so the server never sees that session; instead the client sends
 * a short-lived Appwrite JWT (see operatorFetch) which we verify here. The
 * caller must carry the `operator` label and be on NEXT_PUBLIC_OPERATOR_EMAILS
 * (the same allowlist the AuthGate enforces client-side).
 *
 * `allowMachine` also admits `Bearer ${CRON_SECRET}` — for routes the desk
 * loops call headlessly (holdings sync), same secret the cron routes use.
 *
 * Returns null when the caller is allowed, otherwise the 401/403 to send.
 */
export async function requireOperator(
  req: Request,
  opts: { allowMachine?: boolean } = {},
): Promise<Response | null> {
  const token = bearerToken(req);
  const secret = process.env.CRON_SECRET;
  if (opts.allowMachine && secret && token === secret) return null;
  return verifyOperatorJwt(token);
}

/** The JWT half of requireOperator, for callers that get the JWT elsewhere. */
export async function verifyOperatorJwt(jwt: string): Promise<Response | null> {
  if (!jwt) return Response.json({ error: "sign in required" }, { status: 401 });

  let user: { email: string; labels?: string[] };
  try {
    user = await new Account(base().setJWT(jwt)).get();
  } catch {
    return Response.json({ error: "session expired — sign in again" }, { status: 401 });
  }
  if (!(user.labels ?? []).includes(OPERATOR_LABEL) || !isOperatorEmail(user.email)) {
    return Response.json({ error: "operator access required" }, { status: 403 });
  }
  return null;
}

export function createAdminClient() {
  if (!apiKey) {
    throw new Error("APPWRITE_API_KEY is not set");
  }
  const client = base().setKey(apiKey);
  return {
    account: new Account(client),
    databases: new Databases(client),
    storage: new Storage(client),
    users: new Users(client),
  };
}
