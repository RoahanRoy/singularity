/**
 * Multi-sector US large-cap universe. Hand-picked liquid names per GICS sector.
 * One ticker is selected per cycle (round-robin via cursor file) so the loop
 * stays cheap on tokens. Sector is resolved from the ticker so the orchestrator
 * can route to the right sector analyst.
 */
import fs from "node:fs";
import path from "node:path";

export type Sector =
  | "tech"
  | "healthcare"
  | "energy"
  | "financials"
  | "consumer"
  | "industrials";

export const SECTOR_UNIVERSE: Record<Sector, readonly string[]> = {
  tech:        ["AAPL", "MSFT", "GOOGL", "NVDA", "META", "AMZN", "TSLA", "AVGO", "AMD",  "CRM"],
  healthcare:  ["UNH",  "JNJ",  "LLY",   "PFE",  "MRK",  "ABBV", "TMO",  "ABT",  "DHR",  "BMY"],
  energy:      ["XOM",  "CVX",  "COP",   "EOG",  "SLB",  "PSX",  "MPC",  "OXY",  "VLO",  "WMB"],
  financials:  ["JPM",  "BAC",  "WFC",   "GS",   "MS",   "C",    "BLK",  "SCHW", "AXP",  "SPGI"],
  consumer:    ["WMT",  "COST", "HD",    "MCD",  "NKE",  "SBUX", "TGT",  "LOW",  "PG",   "KO"],
  industrials: ["BA",   "CAT",  "DE",    "GE",   "HON",  "UPS",  "LMT",  "RTX",  "UNP",  "MMM"],
};

// Flat, ticker-major ordering for round-robin cycling.
export const TECH_UNIVERSE = SECTOR_UNIVERSE.tech;
export const FULL_UNIVERSE: readonly string[] = Object.values(SECTOR_UNIVERSE).flatMap((arr) => [...arr]);

const TICKER_TO_SECTOR: Record<string, Sector> = (() => {
  const m: Record<string, Sector> = {};
  for (const [sector, tickers] of Object.entries(SECTOR_UNIVERSE) as [Sector, readonly string[]][]) {
    for (const t of tickers) m[t] = sector;
  }
  return m;
})();

export function sectorOf(ticker: string): Sector {
  return TICKER_TO_SECTOR[ticker.toUpperCase()] ?? "tech";
}

const CURSOR = path.resolve(".agents-cursor");

/** Round-robin across the full multi-sector universe. */
export function nextTicker(): string {
  let i = 0;
  if (fs.existsSync(CURSOR)) i = (Number(fs.readFileSync(CURSOR, "utf8")) + 1) % FULL_UNIVERSE.length;
  fs.writeFileSync(CURSOR, String(i));
  return FULL_UNIVERSE[i];
}
