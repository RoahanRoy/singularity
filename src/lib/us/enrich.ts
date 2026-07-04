/**
 * US (IBKR) book enrichment — the US-desk config over the shared engine.
 *
 * Mirror of src/lib/india/enrich.ts: the generic machinery lives in
 * src/lib/market/enrich-core.ts; this file supplies US specifics — broad
 * factor proxies (market/tech/size/rates/USD), bare Yahoo symbols (no suffix),
 * the ~16:00 ET snapshot close, and US stress scenarios.
 *
 * Runs from both the weekly Vercel cron (`/api/cron/enrich-us`) and the
 * one-shot CLI (`scripts/enrich-us.ts`). All writes are additive/idempotent.
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
  { key: "US_MKT", symbol: "^GSPC" },      // S&P 500 — broad market
  { key: "US_TECH", symbol: "^NDX" },      // Nasdaq-100 — tech/growth tilt
  { key: "US_SMALL", symbol: "^RUT" },     // Russell 2000 — size factor
  { key: "RATES_10Y", symbol: "^TNX" },    // 10Y Treasury yield — duration
  { key: "USD", symbol: "DX-Y.NYB" },      // Dollar index — currency
];

// Seeded only if none exist for market="US".
const US_SCENARIOS: ScenarioSpec[] = [
  {
    name: "Fed +50bp surprise",
    description: "Unscheduled 50bp hike; long-duration growth and rate-sensitives re-rate lower.",
    nav_delta: -0.038,
    worst_position: "NVDA",
    branches: [
      { label: "priced in", prob: 0.5, delta: -0.015, hedged_delta: -0.005 },
      { label: "growth de-rate", prob: 0.37, delta: -0.048, hedged_delta: -0.019 },
      { label: "credit stress", prob: 0.13, delta: -0.089, hedged_delta: -0.036 },
    ],
  },
  {
    name: "AI capex air-pocket",
    description: "Hyperscaler capex guidance cut; AI-accelerator and semi-cap names lead the fall.",
    nav_delta: -0.062,
    worst_position: "NVDA",
    branches: [
      { label: "digestion", prob: 0.55, delta: -0.03, hedged_delta: -0.012 },
      { label: "capex reset", prob: 0.33, delta: -0.072, hedged_delta: -0.029 },
      { label: "bubble unwind", prob: 0.12, delta: -0.128, hedged_delta: -0.055 },
    ],
  },
  {
    name: "Global risk-off (VIX>30)",
    description: "Broad drawdown; high-beta megacap tech and recent IPOs de-rate hardest.",
    nav_delta: -0.051,
    worst_position: "META",
    branches: [
      { label: "shallow", prob: 0.52, delta: -0.026, hedged_delta: -0.01 },
      { label: "correction", prob: 0.36, delta: -0.061, hedged_delta: -0.025 },
      { label: "liquidity crunch", prob: 0.12, delta: -0.107, hedged_delta: -0.046 },
    ],
  },
  {
    name: "Crude +15% spike",
    description: "Oil shock lifts input costs and inflation expectations; margins and multiples compress.",
    nav_delta: -0.024,
    worst_position: "AMZN",
    branches: [
      { label: "transient", prob: 0.63, delta: -0.012, hedged_delta: -0.004 },
      { label: "sustained", prob: 0.37, delta: -0.043, hedged_delta: -0.019 },
    ],
  },
];

const US_CONFIG: EnrichConfig = {
  market: "US",
  factors: FACTORS,
  scenarios: US_SCENARIOS,
  yahooSymbol: (t) => t, // US symbols need no suffix
  snapshotCloseUtc: "20:00:00.000Z", // ~16:00 ET close (EDT)
  emptyBookHint: "No market=US positions — connect an IBKR account and sync first.",
};

export type { EnrichSummary };

/** Run the full US enrichment against the given Appwrite database. */
export function runUsEnrichment(
  databases: Databases,
  dbId: string,
  log: (msg: string) => void = () => {},
): Promise<EnrichSummary> {
  return runEnrichment(databases, dbId, US_CONFIG, log);
}
