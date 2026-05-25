"use client";

import { ReactNode, createContext, useContext, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getCurrentOperator, type OperatorUser } from "@/lib/auth/operator";

type AuthState =
  | { status: "loading"; user: null }
  | { status: "authed"; user: OperatorUser }
  | { status: "anon"; user: null };

const AuthCtx = createContext<AuthState>({ status: "loading", user: null });

export function useOperator(): OperatorUser | null {
  return useContext(AuthCtx).user;
}

export function AuthGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [state, setState] = useState<AuthState>({ status: "loading", user: null });

  useEffect(() => {
    let alive = true;
    getCurrentOperator()
      .then((u) => {
        if (!alive) return;
        if (u) setState({ status: "authed", user: u });
        else setState({ status: "anon", user: null });
      })
      .catch(() => alive && setState({ status: "anon", user: null }));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (state.status === "anon") router.replace("/sign-in");
  }, [state.status, router]);

  if (state.status !== "authed") {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "grid",
          placeItems: "center",
          background: "#0a0b0e",
          color: "#8b8d97",
          fontFamily: "var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace)",
          fontSize: 12,
          letterSpacing: "0.12em",
        }}
      >
        {state.status === "loading" ? "VERIFYING OPERATOR..." : "REDIRECTING..."}
      </div>
    );
  }

  return <AuthCtx.Provider value={state}>{children}</AuthCtx.Provider>;
}
