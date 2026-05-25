"use client";

import { ID } from "appwrite";
import { account } from "@/lib/appwrite/client";

export type OperatorUser = {
  $id: string;
  email: string;
  name: string;
};

function allowlist(): string[] {
  const raw = process.env.NEXT_PUBLIC_OPERATOR_EMAILS || "";
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function isOperatorEmail(email: string | undefined | null): boolean {
  if (!email) return false;
  const list = allowlist();
  if (list.length === 0) return false;
  return list.includes(email.toLowerCase());
}

export async function getCurrentOperator(): Promise<OperatorUser | null> {
  try {
    const u = await account.get();
    if (!isOperatorEmail(u.email)) return null;
    return { $id: u.$id, email: u.email, name: u.name || u.email };
  } catch {
    return null;
  }
}

export async function signInOperator(email: string, password: string): Promise<OperatorUser> {
  if (!isOperatorEmail(email)) {
    throw new Error("This email is not on the operator allowlist.");
  }
  try {
    await account.deleteSession("current");
  } catch {
    // no active session
  }
  await account.createEmailPasswordSession(email, password);
  const u = await account.get();
  return { $id: u.$id, email: u.email, name: u.name || u.email };
}

export async function signOutOperator(): Promise<void> {
  try {
    await account.deleteSession("current");
  } catch {
    // already gone
  }
}

export async function bootstrapOperatorOnce(
  email: string,
  password: string,
  name = "Operator",
): Promise<OperatorUser> {
  if (!isOperatorEmail(email)) {
    throw new Error("This email is not on the operator allowlist.");
  }
  await account.create(ID.unique(), email, password, name);
  return signInOperator(email, password);
}
