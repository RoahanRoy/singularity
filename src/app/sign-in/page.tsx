"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  signInOperator,
  bootstrapOperatorOnce,
  isOperatorEmail,
} from "@/lib/auth/operator";
import { useTheme } from "@/lib/meridian/theme";
import { Brand, ThemeButton } from "@/components/site/Site";

type Field = "email" | "pw" | null;

export default function SignInPage() {
  const router = useRouter();
  const [theme, toggleTheme] = useTheme("light", true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [show, setShow] = useState(false);
  const [mode, setMode] = useState<"sign-in" | "bootstrap">("sign-in");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [errField, setErrField] = useState<Field>(null);
  const boot = mode === "bootstrap";

  function fail(msg: string, field: Field = null) {
    setErr(msg);
    setErrField(field);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail("Enter a valid email address.", "email");
    if (password.length < 8) return fail("Password must be at least 8 characters.", "pw");
    if (!isOperatorEmail(email)) {
      return fail("This email isn't on the operator allowlist (NEXT_PUBLIC_OPERATOR_EMAILS).", "email");
    }
    setBusy(true);
    fail("");
    try {
      if (boot) {
        await bootstrapOperatorOnce(email, password, name.trim() || "Operator");
      } else {
        await signInOperator(email, password);
      }
      router.replace("/desk");
    } catch (e2) {
      fail(e2 instanceof Error ? e2.message : "Sign-in failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx s-page s-auth" data-theme={theme}>
      <section className="s-auth-panel">
        <Brand />
        <div style={{ maxWidth: 440 }}>
          <div className="m-sub">Waiting on the desk</div>
          <p className="s-display" style={{ marginTop: 10, fontSize: "clamp(36px,4.4vw,52px)" }}>
            The agents did the reading. The decisions are yours.
          </p>
          <ul className="s-auth-list">
            <li>Trades the agents staged, each with its thesis, size and the risk check it cleared</li>
            <li>Orders the risk check blocked, with the reason</li>
            <li>Every filing, memo and model call since you last looked</li>
          </ul>
        </div>
        <div className="m-meta">Nothing goes to market until you approve it, unless you turn auto-approve on.</div>
      </section>

      <main className="s-auth-main">
        <div className="s-auth-top">
          <Brand />
          <ThemeButton theme={theme} toggle={toggleTheme} />
        </div>
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: "40px 0" }}>
          <form className="s-form" onSubmit={submit} noValidate>
            <div>
              <h1 style={{ margin: 0, fontFamily: "var(--m-serif)", fontSize: 36, fontWeight: 500, letterSpacing: "-0.01em", lineHeight: 1.1 }}>
                {boot ? "Create the first operator" : "Sign in to the desk"}
              </h1>
              <p style={{ margin: "8px 0 0", color: "var(--ink-2)", textWrap: "pretty" }}>
                {boot
                  ? "Set up the first operator for this deployment. The email must be on the operator allowlist."
                  : "Pick up where the agents left off."}
              </p>
            </div>

            {boot && (
              <label className="s-field">
                Name
                <input name="name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Operator" />
              </label>
            )}
            <label className="s-field">
              Email
              <input
                type="email"
                name="email"
                autoComplete="email"
                value={email}
                aria-invalid={errField === "email"}
                onChange={(e) => {
                  setEmail(e.target.value);
                  fail("");
                }}
              />
            </label>
            <label className="s-field">
              <span className="row">
                <span>Password</span>
                <button type="button" className="m-link" style={{ fontWeight: 500 }} onClick={() => setShow(!show)}>
                  {show ? "Hide" : "Show"}
                </button>
              </span>
              <input
                type={show ? "text" : "password"}
                name="password"
                autoComplete={boot ? "new-password" : "current-password"}
                value={password}
                aria-invalid={errField === "pw"}
                onChange={(e) => {
                  setPassword(e.target.value);
                  fail("");
                }}
              />
              <span className="hint">At least 8 characters.</span>
            </label>

            {err && (
              <div role="alert" style={{ fontSize: 13, color: "var(--down)" }}>
                {err}
              </div>
            )}

            <button type="submit" className="s-cta" disabled={busy}>
              {busy ? (boot ? "Creating…" : "Signing in…") : boot ? "Create operator" : "Sign in"}
            </button>
            {!boot && (
              <Link href="/guided" className="s-cta2" style={{ fontSize: 14 }}>
                Explore with sample data
              </Link>
            )}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, fontSize: 13, color: "var(--ink-2)" }}>
              <span>{boot ? "Already set up?" : "First deployment?"}</span>
              <button
                type="button"
                className="m-link"
                style={{ fontWeight: 500 }}
                onClick={() => {
                  fail("");
                  setMode(boot ? "sign-in" : "bootstrap");
                }}
              >
                {boot ? "Sign in" : "Create the first operator"}
              </button>
            </div>
          </form>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 16px", fontSize: 12, color: "var(--ink-3)" }}>
          <span>Operator access only</span>
          <Link href="/" style={{ marginLeft: "auto" }}>
            Back to Meridian
          </Link>
        </div>
      </main>
    </div>
  );
}
