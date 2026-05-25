"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  signInOperator,
  bootstrapOperatorOnce,
  isOperatorEmail,
} from "@/lib/auth/operator";

export default function SignInPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [mode, setMode] = useState<"sign-in" | "bootstrap">("sign-in");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

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
      router.replace("/");
    } catch (e2) {
      const msg = e2 instanceof Error ? e2.message : "Sign-in failed.";
      setErr(msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        background: "var(--bg, #0a0b0e)",
        color: "var(--ink-0, #e8e8ea)",
        fontFamily: "var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace)",
        padding: 24,
      }}
    >
      <form
        onSubmit={submit}
        style={{
          width: 380,
          border: "1px solid #2a2c33",
          borderRadius: 8,
          padding: 28,
          background: "#101218",
        }}
      >
        <div style={{ fontSize: 11, letterSpacing: "0.18em", color: "#8b8d97" }}>
          MERIDIAN
        </div>
        <h1 style={{ fontSize: 20, margin: "4px 0 22px", letterSpacing: "0.02em" }}>
          {mode === "sign-in" ? "Operator sign-in" : "First-run bootstrap"}
        </h1>

        <label style={labelStyle}>Email</label>
        <input
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          style={inputStyle}
        />

        {mode === "bootstrap" && (
          <>
            <label style={labelStyle}>Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              style={inputStyle}
              placeholder="Operator"
            />
          </>
        )}

        <label style={labelStyle}>Password</label>
        <input
          type="password"
          required
          minLength={8}
          autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          style={inputStyle}
        />

        {err && (
          <div
            style={{
              marginTop: 12,
              padding: "8px 10px",
              border: "1px solid #5a2727",
              background: "#2a1010",
              color: "#f3a5a5",
              fontSize: 12,
              borderRadius: 4,
            }}
          >
            {err}
          </div>
        )}

        <button
          type="submit"
          disabled={busy}
          style={{
            marginTop: 18,
            width: "100%",
            padding: "10px 12px",
            background: busy ? "#3a3d46" : "#e8e8ea",
            color: busy ? "#a0a3ad" : "#0a0b0e",
            border: 0,
            borderRadius: 4,
            fontWeight: 600,
            letterSpacing: "0.04em",
            cursor: busy ? "default" : "pointer",
          }}
        >
          {busy ? "..." : mode === "sign-in" ? "Sign in" : "Create operator"}
        </button>

        <button
          type="button"
          onClick={() => {
            setErr(null);
            setMode(mode === "sign-in" ? "bootstrap" : "sign-in");
          }}
          style={{
            marginTop: 12,
            width: "100%",
            padding: "8px",
            background: "transparent",
            color: "#8b8d97",
            border: 0,
            fontSize: 12,
            cursor: "pointer",
          }}
        >
          {mode === "sign-in"
            ? "First-time setup → create operator"
            : "← back to sign-in"}
        </button>
      </form>
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 11,
  letterSpacing: "0.1em",
  color: "#8b8d97",
  marginTop: 12,
  marginBottom: 4,
  textTransform: "uppercase",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "9px 10px",
  background: "#0a0b0e",
  border: "1px solid #2a2c33",
  color: "#e8e8ea",
  borderRadius: 4,
  fontFamily: "inherit",
  fontSize: 13,
  boxSizing: "border-box",
};
