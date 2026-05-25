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
