"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ID } from "node-appwrite";
import { createAdminClient, tryCreateSessionClient, SESSION_COOKIE } from "./server";

export async function signUp(formData: FormData) {
  const email = String(formData.get("email"));
  const password = String(formData.get("password"));
  const name = String(formData.get("name") ?? "Operator");

  const { account } = createAdminClient();
  await account.create(ID.unique(), email, password, name);
  const session = await account.createEmailPasswordSession(email, password);

  const store = await cookies();
  store.set(SESSION_COOKIE, session.secret, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    expires: new Date(session.expire),
  });

  redirect("/");
}

export async function signIn(formData: FormData) {
  const email = String(formData.get("email"));
  const password = String(formData.get("password"));

  const { account } = createAdminClient();
  const session = await account.createEmailPasswordSession(email, password);

  const store = await cookies();
  store.set(SESSION_COOKIE, session.secret, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    expires: new Date(session.expire),
  });

  redirect("/");
}

export async function signOut() {
  const session = await tryCreateSessionClient();
  if (session) {
    try {
      await session.account.deleteSession("current");
    } catch {
      // session may already be invalid server-side
    }
  }
  const store = await cookies();
  store.delete(SESSION_COOKIE);
  redirect("/sign-in");
}

export async function getCurrentUser() {
  const session = await tryCreateSessionClient();
  if (!session) return null;
  try {
    return await session.account.get();
  } catch {
    return null;
  }
}
