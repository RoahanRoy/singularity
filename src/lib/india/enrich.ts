/**
 * India (Kite) book enrichment — the India-desk config over the shared engine.
 *
 * The generic machinery (Yahoo history, betas, NAV reconstruction, pnl fix,
 * scenario seeding) lives in src/lib/market/enrich-core.ts and is shared with
 * the US desk. This file only supplies India specifics: NSE factor proxies, the
 * ".NS" Yahoo suffix, the ~15:30 IST snapshot close, and India stress scenarios.
 *
 * Runs from both the weekly Vercel cron (`/api/cron/enrich-india`) and the
 * one-shot CLI (`scripts/enrich-india.ts`). Both pass a node-appwrite
 * `Databases` instance + database id. All writes are additive/idempotent.
 */
import { type Databases } from "node-appwrite";
import {
  runEnrichment,
  type EnrichConfig,
  type EnrichSummary,
  type FactorProxy,
  type ScenarioSpec,
} from "../market/enrich-core";

const FACTORS: FactorProxy[] = [
  { key: "NIFTY_MKT", symbol: "^NSEI" },
  { key: "IN_BANKS", symbol: "^NSEBANK" },
  { key: "IN_IT", symbol: "^CNXIT" },
  { key: "FX_USDINR", symbol: "INR=X" },
  { key: "GOLD", symbol: "GC=F" },
];

// Seeded only if none exist for market="IN".
const INDIA_SCENARIOS: ScenarioSpec[] = [
  {
    name: "RBI +50bp surprise",
    description: "Unscheduled 50bp repo-rate hike; rate-sensitives and NBFCs re-rate lower.",
    nav_delta: -0.031,
    worst_position: "BAJFINANCE",
    branches: [
      { label: "priced in", prob: 0.55, delta: -0.012, hedged_delta: -0.004 },
      { label: "risk-off bleed", prob: 0.33, delta: -0.041, hedged_delta: -0.016 },
      { label: "credit shock", prob: 0.12, delta: -0.078, hedged_delta: -0.031 },
    ],
  },
  {
    name: "INR -3% vs USD",
    description: "Rupee depreciation on oil + outflows; IT exporters cushion, importers hit.",
    nav_delta: -0.018,
    worst_position: "RELIANCE",
    branches: [
      { label: "orderly", prob: 0.6, delta: -0.009, hedged_delta: -0.002 },
      { label: "outflow spiral", prob: 0.4, delta: -0.034, hedged_delta: -0.013 },
    ],
  },
  {
    name: "Global risk-off (VIX>30)",
    description: "US-led drawdown; high-beta EM equities and recent IPOs lead the fall.",
    nav_delta: -0.057,
    worst_position: "PAYTM",
    branches: [
      { label: "shallow", prob: 0.5, delta: -0.028, hedged_delta: -0.011 },
      { label: "EM contagion", prob: 0.37, delta: -0.066, hedged_delta: -0.027 },
      { label: "liquidity crunch", prob: 0.13, delta: -0.114, hedged_delta: -0.049 },
    ],
  },
  {
    name: "Crude +15% spike",
    description: "Brent shock widens the import bill; OMCs and consumer margins compress.",
    nav_delta: -0.022,
    worst_position: "ASIANPAINT",
    branches: [
      { label: "transient", prob: 0.62, delta: -0.011, hedged_delta: -0.004 },
      { label: "sustained", prob: 0.38, delta: -0.039, hedged_delta: -0.018 },
    ],
  },
];

const INDIA_CONFIG: EnrichConfig = {
  market: "IN",
  factors: FACTORS,
  scenarios: INDIA_SCENARIOS,
  yahooSymbol: (t) => `${t}.NS`,
  snapshotCloseUtc: "10:00:00.000Z", // ~15:30 IST close
  emptyBookHint: "No market=IN positions — connect a Kite account and sync first.",
};

export type { EnrichSummary };

/** Run the full India enrichment against the given Appwrite database. */
export function runIndiaEnrichment(
  databases: Databases,
  dbId: string,
  log: (msg: string) => void = () => {},
): Promise<EnrichSummary> {
  return runEnrichment(databases, dbId, INDIA_CONFIG, log);
}
