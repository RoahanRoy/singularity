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
  // Banks, NBFCs, insurers, AMCs, brokers, and capital-market infrastructure —
  // depositories (CDSL/NSDL), exchanges (BSE/MCX), and registrars/RTAs
  // (CAMS/KFINTECH) are all financials, not consumer.
  financials:  ["HDFCBANK", "ICICIBANK", "SBIN", "KOTAKBANK", "AXISBANK", "BAJFINANCE",
                "BAJAJFINSV", "INDUSINDBK", "SBILIFE", "HDFCLIFE", "ICICIPRULI", "ICICIGI",
                "HDFCAMC", "CAMS", "KFINTECH", "CDSL", "BSE", "MCX", "ANGELONE",
                "MUTHOOTFIN", "CHOLAFIN", "SHRIRAMFIN", "PFC", "RECLTD"],
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

// Map an exchange-reported industry label (NSE `smIndustry`, SEC SIC text, etc.)
// onto one of the six analyst sectors. This is the PRIMARY classifier — it uses
// the listing venue's own taxonomy rather than a hand-maintained ticker map, so
// it covers names we never enumerated (the curated map is only a fallback). The
// rules are ordered most-specific-first; returns null when nothing matches
// confidently so the caller can fall back.
const INDUSTRY_RULES: ReadonlyArray<[RegExp, Sector]> = [
  [/software|computers|information technology|\bit[\s-]*(services|consulting|enabled)|telecom.*equipment|semiconductor|internet|e-?commerce/i, "tech"],
  [/pharma|healthcare|hospital|\bdrugs?\b|biotech|life science|diagnostic|medical|health care/i, "healthcare"],
  [/bank|financ|nbfc|insurance|asset manag|capital market|deposito|broking|broker|exchange|registrar|securit|holding compan|fintech/i, "financials"],
  [/refiner|\boil\b|\bgas\b|petroleum|power|energy|\bcoal\b|electric utilit|utilit|renewable|metal|mining|mineral|chemical|fertiliser|fertilizer/i, "energy"],
  [/engineering|capital goods|aerospace|defen[cs]e|machinery|\bcement\b|construction|infrastructure|logistics|transport|industrial|electrical equipment|realty|real estate/i, "industrials"],
  [/fmcg|automobile|\bauto\b|consumer|retail|\bfood\b|beverage|textile|personal|household|durables|hotel|media|entertainment|telecom|apparel|jewell|tobacco|paint/i, "consumer"],
];

/**
 * Classify a sector from an exchange-reported industry label. Returns null when
 * the label is missing or doesn't match any rule, so callers fall back to the
 * curated ticker map. Source-agnostic: works for NSE `smIndustry` or any other
 * free-text industry string.
 */
export function sectorFromIndustry(label?: string | null): Sector | null {
  if (!label) return null;
  for (const [re, sector] of INDUSTRY_RULES) if (re.test(label)) return sector;
  return null;
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
