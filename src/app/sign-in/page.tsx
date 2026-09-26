"use client";

import { CSSProperties, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  signInOperator,
  bootstrapOperatorOnce,
  isOperatorEmail,
} from "@/lib/auth/operator";
import { useTheme } from "@/lib/meridian/theme";

const LABEL: CSSProperties = { fontSize: 13, fontWeight: 500, color: "var(--ink-2)", margin: "0 0 6px 4px" };
const INPUT: CSSProperties = {
  height: 50,
  borderRadius: 14,
  border: "1px solid var(--line)",
  background: "var(--field)",
  color: "var(--ink)",
  padding: "0 16px",
  font: "inherit",
  fontSize: 17,
};

export default function SignInPage() {
  const router = useRouter();
  const [theme, toggleTheme] = useTheme("light", true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [mode, setMode] = useState<"sign-in" | "bootstrap">("sign-in");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const boot = mode === "bootstrap";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      if (!isOperatorEmail(email)) {
        throw new Error("This email isn't on the operator allowlist (NEXT_PUBLIC_OPERATOR_EMAILS).");
      }
      if (boot) {
        await bootstrapOperatorOnce(email, password, name || "Operator");
      } else {
        await signInOperator(email, password);
      }
      router.replace("/desk");
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Sign-in failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="mx-page"
      data-theme={theme}
      style={{
        minHeight: "100vh",
        background: "var(--bg)",
        color: "var(--ink)",
        fontFamily: "var(--f-text)",
        fontSize: 17,
        lineHeight: 1.47,
        letterSpacing: "-0.01em",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <main style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "32px 20px", position: "relative" }}>
        <button
          onClick={toggleTheme}
          aria-label="Toggle appearance"
          style={{ position: "absolute", top: 16, right: 16, width: 36, height: 36, borderRadius: "50%", border: 0, background: "var(--fill)", color: "var(--ink)", cursor: "pointer", fontSize: 15 }}
        >
          {theme === "dark" ? "☀" : "☾"}
        </button>

        <form
          onSubmit={submit}
          style={{
            width: "100%",
            maxWidth: 400,
            background: "var(--surface)",
            borderRadius: 28,
            boxShadow: "var(--shadow)",
            padding: "40px 32px 28px",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <div style={{ width: 56, height: 56, borderRadius: 16, background: "var(--btn)", display: "grid", placeItems: "center", margin: "0 auto 20px" }}>
            <span style={{ width: 24, height: 24, borderRadius: "50%", border: "2.5px solid var(--btn-ink)", display: "grid", placeItems: "center" }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--accent)" }} />
            </span>
          </div>
          <h1 style={{ margin: 0, fontSize: 32, fontWeight: 700, letterSpacing: "-0.035em", textAlign: "center" }}>
            {boot ? "Create the first operator" : "Sign in to Meridian"}
          </h1>
          <p style={{ margin: "6px 0 28px", color: "var(--ink-2)", fontSize: 17, textAlign: "center" }}>
            {boot ? "Set up the first operator for this deployment." : "Take the desk and supervise the swarm."}
          </p>

          <label htmlFor="si-email" style={LABEL}>Email</label>
          <input
            id="si-email"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              setErr(null);
            }}
            placeholder="operator@fund.com"
            style={{ ...INPUT, marginBottom: 16 }}
          />

          {boot && (
            <>
              <label htmlFor="si-name" style={LABEL}>Name</label>
              <input
                id="si-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Your name"
                style={{ ...INPUT, marginBottom: 16 }}
              />
            </>
          )}

          <label htmlFor="si-password" style={LABEL}>Password</label>
          <input
            id="si-password"
            type="password"
            required
            minLength={8}
            autoComplete={boot ? "new-password" : "current-password"}
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setErr(null);
            }}
            placeholder="At least 8 characters"
            style={INPUT}
          />

          {err && (
            <div role="alert" style={{ marginTop: 14, padding: "12px 14px", borderRadius: 12, background: "color-mix(in oklch,var(--down) 12%,transparent)", color: "var(--down)", fontSize: 14 }}>
              {err}
            </div>
          )}

          <button
            type="submit"
            disabled={busy}
            style={{ marginTop: 24, height: 50, border: 0, borderRadius: 14, background: "var(--btn)", color: "var(--btn-ink)", font: "inherit", fontSize: 17, fontWeight: 600, cursor: "pointer", opacity: busy ? 0.6 : 1 }}
          >
            {busy ? (boot ? "Creating…" : "Signing in…") : boot ? "Create operator" : "Sign in"}
          </button>

          <button
            type="button"
            onClick={() => {
              setErr(null);
              setMode(boot ? "sign-in" : "bootstrap");
            }}
            style={{ marginTop: 16, border: 0, background: "transparent", color: "var(--accent-ink)", font: "inherit", fontSize: 15, cursor: "pointer" }}
          >
            {boot ? "Back to sign in" : "First time here? Create an operator"}
          </button>
        </form>

        <div style={{ marginTop: 28, fontSize: 12, color: "var(--ink-3)", textAlign: "center" }}>
          Operator access only · <Link href="/">Back to Meridian</Link>
        </div>
      </main>
    </div>
  );
}
