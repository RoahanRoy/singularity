/**
 * The quant desk's ensemble verdicts: what each ticker's latest
 * ensemble-combiner report says, and which are fresh. The construction plan
 * (plan.ts, scripts/agents/construct.ts) sizes both books from them; the
 * coverage and flip sweeps rank by them.
 *
 * Pure: no I/O.
 */
import type { QuantReport } from "@/lib/appwrite/schema";

export type Direction = "long" | "short" | "neutral";

export type Verdict = {
  ticker: string;
  direction: Direction;
  composite: number;
  confidence: number;
  price: number | null;
  currency: string | null;
  runAt: string;
};

/** How strongly a verdict points long: composite × confidence. Buys and ideas rank by it. */
export const edgeOf = (v: Pick<Verdict, "composite" | "confidence">) => v.composite * v.confidence;

/** The newest verdict per ticker among those run within `maxAgeMs` of `now`. */
export function freshVerdicts(verdicts: readonly Verdict[], now: number, maxAgeMs: number): Map<string, Verdict> {
  const fresh = new Map<string, Verdict>();
  for (const v of verdicts) {
    const t = Date.parse(v.runAt);
    if (!Number.isFinite(t) || now - t > maxAgeMs) continue;
    const prev = fresh.get(v.ticker);
    if (!prev || Date.parse(prev.runAt) < t) fresh.set(v.ticker, v);
  }
  return fresh;
}

/** The verdict an ensemble-combiner report carries, or null when it carries none. */
export function verdictOf(r: QuantReport): Verdict | null {
  let data: Record<string, unknown> = {};
  try {
    const p: unknown = r.payload_json ? JSON.parse(r.payload_json) : null;
    const d = p && typeof p === "object" ? (p as { data?: unknown }).data : null;
    if (d && typeof d === "object") data = d as Record<string, unknown>;
  } catch {
    // fall through to the row's own score
  }
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);
  const composite = num(data.composite) ?? r.score;
  if (composite == null) return null;
  const dir = data.direction;
  return {
    ticker: r.ticker,
    direction: dir === "long" || dir === "short" ? dir : "neutral",
    composite,
    confidence: Math.min(1, Math.max(0, num(data.confidence) ?? 0)),
    price: num(data.price),
    currency: typeof data.currency === "string" ? data.currency : null,
    runAt: r.run_at,
  };
}
