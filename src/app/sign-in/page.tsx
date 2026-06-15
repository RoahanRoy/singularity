"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  signInOperator,
  bootstrapOperatorOnce,
  isOperatorEmail,
} from "@/lib/auth/operator";
import "../glass.css";
import "./sign-in.css";

export default function SignInPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [mode, setMode] = useState<"sign-in" | "bootstrap">("sign-in");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [theme, setTheme] = useState<"light" | "dark">("light");

  // Share the landing's theme preference so the look stays consistent.
  useEffect(() => {
    const stored = window.localStorage.getItem("lp-theme");
    if (stored === "dark" || stored === "light") setTheme(stored);
    else if (window.matchMedia("(prefers-color-scheme: dark)").matches) setTheme("dark");
  }, []);
  const toggleTheme = () =>
    setTheme((t) => {
      const next = t === "light" ? "dark" : "light";
      window.localStorage.setItem("lp-theme", next);
      return next;
    });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      if (!isOperatorEmail(email)) {
        throw new Error(
          "This email is not on the operator allowlist (NEXT_PUBLIC_OPERATOR_EMAILS).",
        );
      }
      if (mode === "sign-in") {
        await signInOperator(email, password);
      } else {
        await bootstrapOperatorOnce(email, password, name || "Operator");
      }
      router.replace("/desk");
    } catch (e2) {
      const msg = e2 instanceof Error ? e2.message : "Sign-in failed.";
      setErr(msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="lg si" data-theme={theme}>
      <div className="lg-field" aria-hidden>
        <span className="blob b1" />
        <span className="blob b2" />
        <span className="blob b3" />
        <span className="grain" />
      </div>

      <button
        type="button"
        className="lg-themetoggle si-theme"
        onClick={toggleTheme}
        aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
      >
        {theme === "dark" ? "☀" : "☾"}
      </button>

      <div className="lg-content si-stage">
        <form onSubmit={submit} className="lg-glass si-card">
          <div className="si-brand">
            <span className="lg-mark" aria-hidden />
            <div>
              <div className="si-brandname">MERIDIAN</div>
              <div className="si-brandsub">Autonomous Capital Intelligence</div>
            </div>
          </div>

          <h1 className="si-title">
            {mode === "sign-in" ? (
              <>Operator <em>sign-in</em></>
            ) : (
              <>First-run <em>bootstrap</em></>
            )}
          </h1>
          <p className="si-lede">
            {mode === "sign-in"
              ? "Authenticate to take the desk and supervise the swarm."
              : "Create the first operator for this deployment."}
          </p>

          <label className="si-label">Email</label>
          <input
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="si-input"
            placeholder="operator@fund.com"
          />

          {mode === "bootstrap" && (
            <>
              <label className="si-label">Name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="si-input"
                placeholder="Operator"
              />
            </>
          )}

          <label className="si-label">Password</label>
          <input
            type="password"
            required
            minLength={8}
            autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="si-input"
            placeholder="••••••••"
          />

          {err && <div className="si-error">{err}</div>}

          <button type="submit" disabled={busy} className="lg-btn lg-btn--solid si-submit">
            {busy ? "···" : mode === "sign-in" ? "Sign in" : "Create operator"}
          </button>

          <button
            type="button"
            className="si-switch"
            onClick={() => {
              setErr(null);
              setMode(mode === "sign-in" ? "bootstrap" : "sign-in");
            }}
          >
            {mode === "sign-in"
              ? "First-time setup → create operator"
              : "← back to sign-in"}
          </button>
        </form>

        <div className="si-foot mono">
          MERIDIAN OS · {new Date().getFullYear()} · operator access only
        </div>
      </div>
    </div>
  );
}
