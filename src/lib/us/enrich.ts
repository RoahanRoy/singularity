/**
 * US (IBKR) book enrichment — the US-desk config over the shared engine.
 *
 * Mirror of src/lib/india/enrich.ts: the generic machinery lives in
 * src/lib/market/enrich-core.ts; this file supplies US specifics — broad
 * factor proxies (market/tech/size/rates/USD), bare Yahoo symbols (no suffix),
 * and the ~16:00 ET snapshot close.
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
} from "../market/enrich-core";

const FACTORS: FactorProxy[] = [
  { key: "US_MKT", symbol: "^GSPC" },      // S&P 500 — broad market
  { key: "US_TECH", symbol: "^NDX" },      // Nasdaq-100 — tech/growth tilt
  { key: "US_SMALL", symbol: "^RUT" },     // Russell 2000 — size factor
  { key: "RATES_10Y", symbol: "^TNX" },    // 10Y Treasury yield — duration
  { key: "USD", symbol: "DX-Y.NYB" },      // Dollar index — currency
];

const US_CONFIG: EnrichConfig = {
  market: "US",
  factors: FACTORS,
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
