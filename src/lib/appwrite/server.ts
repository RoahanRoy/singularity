import "server-only";
import { cookies } from "next/headers";
import { Client, Account, Databases, Storage, Users } from "node-appwrite";

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
 * Route-handler guard for operator-only endpoints. The UI signs in with the
 * browser SDK, so the server never sees that session; instead the client sends
 * a short-lived Appwrite JWT (see operatorFetch) which we verify here. The
 * client-side email allowlist is UX only — the `operator` label is the check.
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
  const header = req.headers.get("authorization") ?? "";
  const secret = process.env.CRON_SECRET;
  if (opts.allowMachine && secret && header === `Bearer ${secret}`) return null;

  const jwt = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!jwt) return Response.json({ error: "sign in required" }, { status: 401 });

  let labels: string[];
  try {
    const user = await new Account(base().setJWT(jwt)).get();
    labels = user.labels ?? [];
  } catch {
    return Response.json({ error: "session expired — sign in again" }, { status: 401 });
  }
  if (!labels.includes(OPERATOR_LABEL)) {
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
