import { Client, Account, Databases, Storage, Functions } from "appwrite";

export const DATABASE_ID = process.env.NEXT_PUBLIC_APPWRITE_DATABASE_ID || "meridian";

let _client: Client | null = null;

function getClient(): Client {
  if (_client) return _client;
  const endpoint = process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT;
  const projectId = process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID;
  if (!endpoint || !projectId) {
    throw new Error("Appwrite env vars missing (NEXT_PUBLIC_APPWRITE_ENDPOINT / NEXT_PUBLIC_APPWRITE_PROJECT_ID)");
  }
  _client = new Client().setEndpoint(endpoint).setProject(projectId);
  return _client;
}

export const client: Client = new Proxy({} as Client, {
  get(_t, prop) {
    const c = getClient();
    const v = (c as unknown as Record<string | symbol, unknown>)[prop as string];
    return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(c) : v;
  },
});

export const account = new Proxy({} as Account, {
  get(_t, prop) {
    const a = new Account(getClient());
    const v = (a as unknown as Record<string | symbol, unknown>)[prop as string];
    return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(a) : v;
  },
});

export const databases = new Proxy({} as Databases, {
  get(_t, prop) {
    const d = new Databases(getClient());
    const v = (d as unknown as Record<string | symbol, unknown>)[prop as string];
    return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(d) : v;
  },
});

export const storage = new Proxy({} as Storage, {
  get(_t, prop) {
    const s = new Storage(getClient());
    const v = (s as unknown as Record<string | symbol, unknown>)[prop as string];
    return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(s) : v;
  },
});

export const functions = new Proxy({} as Functions, {
  get(_t, prop) {
    const f = new Functions(getClient());
    const v = (f as unknown as Record<string | symbol, unknown>)[prop as string];
    return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(f) : v;
  },
});
