/**
 * India book enrichment — the India-desk config over the shared engine.
 *
 * The generic machinery (Yahoo history, betas, pnl fix) lives in
 * src/lib/market/enrich-core.ts and is shared with the US desk. This file only
 * supplies India specifics: NSE factor proxies and the ".NS" Yahoo suffix.
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
} from "../market/enrich-core";

const FACTORS: FactorProxy[] = [
  { key: "NIFTY_MKT", symbol: "^NSEI" },
  { key: "IN_BANKS", symbol: "^NSEBANK" },
  { key: "IN_IT", symbol: "^CNXIT" },
  { key: "FX_USDINR", symbol: "INR=X" },
  { key: "GOLD", symbol: "GC=F" },
];

const INDIA_CONFIG: EnrichConfig = {
  market: "IN",
  factors: FACTORS,
  yahooSymbol: (t) => `${t}.NS`,
  emptyBookHint: "No market=IN positions — sync Horizon from Portfolio first.",
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
