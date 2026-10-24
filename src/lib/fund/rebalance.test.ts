import { test } from "node:test";
import assert from "node:assert/strict";
import { freshVerdicts, verdictOf, type Verdict } from "./rebalance";
import type { QuantReport } from "@/lib/appwrite/schema";

const NOW = Date.parse("2026-10-23T12:00:00Z");
const recent = "2026-10-22T16:00:00Z";

test("freshVerdicts keeps the newest verdict per ticker within the window", () => {
  const v = (ticker: string, runAt: string, composite: number): Verdict => ({
    ticker, direction: "long", composite, confidence: 0.5, price: 100, currency: "USD", runAt,
  });
  const fresh = freshVerdicts([
    v("AAA", "2026-10-21T16:00:00Z", 10),
    v("AAA", recent, 20),
    v("OLD", "2026-10-10T16:00:00Z", 30),
  ], NOW, 7 * 86_400_000);
  assert.equal(fresh.get("AAA")?.composite, 20);
  assert.equal(fresh.has("OLD"), false);
});

test("verdictOf reads the ensemble payload and falls back to the row score", () => {
  const base = { ticker: "AAPL", market: "US", agent: "ensemble-combiner", stage: null, kind: "compute", summary: "", run_at: recent, cycle_id: "c" };
  const v = verdictOf({
    ...base, score: 31,
    payload_json: JSON.stringify({ data: { composite: 31, direction: "long", confidence: 0.62, price: 230.5, currency: "USD" } }),
  } as QuantReport)!;
  assert.deepEqual(v, { ticker: "AAPL", direction: "long", composite: 31, confidence: 0.62, price: 230.5, currency: "USD", runAt: recent });
  const bare = verdictOf({ ...base, score: -5, payload_json: "not json" } as QuantReport)!;
  assert.equal(bare.direction, "neutral");
  assert.equal(bare.composite, -5);
  assert.equal(verdictOf({ ...base, score: null, payload_json: null } as QuantReport), null);
});
