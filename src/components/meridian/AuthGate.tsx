"use client";

import { ReactNode, createContext, useContext, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getCurrentOperator, type OperatorUser } from "@/lib/auth/operator";
import { useTheme } from "@/lib/meridian/theme";

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
  const [theme] = useTheme("light");

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

  // Same paper theme and preference as the Shell it stands in for.
  if (state.status !== "authed") {
    return (
      <div className="mx" data-theme={theme} style={{ alignItems: "center", justifyContent: "center" }}>
        <div role="status" className="m-sub" style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span className="m-dot m-pulse" style={{ background: "var(--accent)" }} aria-hidden />
          {state.status === "loading" ? "Checking your sign-in…" : "Redirecting to sign-in…"}
        </div>
      </div>
    );
  }

  return <AuthCtx.Provider value={state}>{children}</AuthCtx.Provider>;
}
