/**
 * Operator email allowlist (NEXT_PUBLIC_OPERATOR_EMAILS). Shared by the client
 * AuthGate and the server-side requireOperator() guard, so it carries no
 * "use client" / "server-only" directive.
 */
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
