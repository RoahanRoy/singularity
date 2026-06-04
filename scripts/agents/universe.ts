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

// ── India (NSE) ──────────────────────────────────────────────────────────────
// NSE-listed names mapped onto the SAME six analyst sectors as the US desk, so
// the India loop reuses the existing sector-analyst prompts. Banks/NBFC →
// financials, IT services → tech, FMCG/auto → consumer, pharma → healthcare,
// energy/materials → energy, capital goods → industrials.
export const INDIA_SECTOR_UNIVERSE: Record<Sector, readonly string[]> = {
  tech:        ["TCS", "INFY", "HCLTECH", "WIPRO", "TECHM", "LTIM", "PERSISTENT", "COFORGE"],
  healthcare:  ["SUNPHARMA", "DRREDDY", "CIPLA", "DIVISLAB", "APOLLOHOSP", "LUPIN", "AUROPHARMA"],
  energy:      ["RELIANCE", "ONGC", "NTPC", "POWERGRID", "COALINDIA", "BPCL", "IOC", "TATAPOWER"],
  financials:  ["HDFCBANK", "ICICIBANK", "SBIN", "KOTAKBANK", "AXISBANK", "BAJFINANCE", "INDUSINDBK", "SBILIFE"],
  consumer:    ["HINDUNILVR", "ITC", "NESTLEIND", "TITAN", "MARUTI", "TATAMOTORS", "M&M", "BRITANNIA"],
  industrials: ["LT", "ADANIPORTS", "SIEMENS", "BEL", "HAL", "ABB", "BHEL", "GRASIM"],
};

const INDIA_TICKER_TO_SECTOR: Record<string, Sector> = (() => {
  const m: Record<string, Sector> = {};
  for (const [sector, tickers] of Object.entries(INDIA_SECTOR_UNIVERSE) as [Sector, readonly string[]][]) {
    for (const t of tickers) m[t] = sector;
  }
  return m;
})();

export const INDIA_UNIVERSE: readonly string[] = Object.values(INDIA_SECTOR_UNIVERSE).flatMap((a) => [...a]);

/** Resolve an NSE ticker to one of the six analyst sectors. */
export function indiaSectorOf(ticker: string): Sector {
  return INDIA_TICKER_TO_SECTOR[ticker.toUpperCase()] ?? "consumer";
}

const CURSOR = path.resolve(".agents-cursor");
const INDIA_CURSOR = path.resolve(".agents-cursor-india");

/**
 * Round-robin across the held India book (preferred) or the static NSE
 * universe as a fallback when nothing is connected yet.
 */
export function nextIndiaTicker(held: readonly string[] = []): string {
  const pool = held.length ? held : INDIA_UNIVERSE;
  let i = 0;
  if (fs.existsSync(INDIA_CURSOR)) i = (Number(fs.readFileSync(INDIA_CURSOR, "utf8")) + 1) % pool.length;
  fs.writeFileSync(INDIA_CURSOR, String(i));
  return pool[i % pool.length];
}

/**
 * Round-robin across the held US book (preferred) or the full multi-sector
 * universe as a fallback when nothing is connected yet. Mirrors the India
 * loop's nextIndiaTicker() so the analyst chain walks the actual portfolio.
 */
export function nextTicker(held: readonly string[] = []): string {
  const pool = held.length ? held : FULL_UNIVERSE;
  let i = 0;
  if (fs.existsSync(CURSOR)) i = (Number(fs.readFileSync(CURSOR, "utf8")) + 1) % pool.length;
  fs.writeFileSync(CURSOR, String(i));
  return pool[i % pool.length];
}
