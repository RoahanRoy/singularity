"use client";

import { account } from "@/lib/appwrite/client";

// Appwrite JWTs live 15 minutes; refresh well before that.
const JWT_TTL_MS = 10 * 60_000;
let cached: { jwt: string; exp: number } | null = null;

async function sessionJwt(): Promise<string | null> {
  if (cached && Date.now() < cached.exp) return cached.jwt;
  try {
    const { jwt } = await account.createJWT();
    cached = { jwt, exp: Date.now() + JWT_TTL_MS };
    return jwt;
  } catch {
    cached = null;
    return null; // no session — the route answers 401
  }
}

/** Forget the cached JWT (call on sign-out). */
export function clearOperatorJwt(): void {
  cached = null;
}

/**
 * fetch() for operator-only API routes: attaches the signed-in session's JWT
 * as a bearer token, which the route verifies with requireOperator().
 */
export async function operatorFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const jwt = await sessionJwt();
  if (jwt) headers.set("Authorization", `Bearer ${jwt}`);
  return fetch(input, { ...init, headers });
}
