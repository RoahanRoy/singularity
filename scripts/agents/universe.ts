/**
 * Multi-sector US large-cap universe. Hand-picked liquid names per GICS sector.
 * One ticker is selected per cycle (round-robin via cursor file) so the loop
 * stays cheap on tokens. Sector is resolved from the ticker so the orchestrator
 * can route to the right sector analyst.
 */
import { readState, writeState } from "./state-store";
import {
  FULL_UNIVERSE,
  INDIA_SECTOR_UNIVERSE,
  INDIA_UNIVERSE,
  SECTOR_UNIVERSE,
  type Sector,
} from "../../src/lib/market/universe";

export { FULL_UNIVERSE, INDIA_SECTOR_UNIVERSE, INDIA_UNIVERSE, SECTOR_UNIVERSE, type Sector };

// Flat, ticker-major ordering for round-robin cycling.
export const TECH_UNIVERSE = SECTOR_UNIVERSE.tech;

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

const INDIA_TICKER_TO_SECTOR: Record<string, Sector> = (() => {
  const m: Record<string, Sector> = {};
  for (const [sector, tickers] of Object.entries(INDIA_SECTOR_UNIVERSE) as [Sector, readonly string[]][]) {
    for (const t of tickers) m[t] = sector;
  }
  return m;
})();

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

const CURSOR = ".agents-cursor";
const INDIA_CURSOR = ".agents-cursor-india";

/** Advance a persisted round-robin cursor over `pool` and return the pick. */
async function advance(file: string, pool: readonly string[]): Promise<string> {
  const prev = await readState<number>(file);
  const i = prev !== null && Number.isFinite(Number(prev)) ? (Number(prev) + 1) % pool.length : 0;
  await writeState(file, i);
  return pool[i % pool.length];
}

/**
 * Round-robin across the held India book (preferred) or the static NSE
 * universe as a fallback when nothing is connected yet.
 */
export function nextIndiaTicker(held: readonly string[] = []): Promise<string> {
  return advance(INDIA_CURSOR, held.length ? held : INDIA_UNIVERSE);
}

/**
 * Round-robin across the held US book (preferred) or the full multi-sector
 * universe as a fallback when nothing is connected yet. Mirrors the India
 * loop's nextIndiaTicker() so the analyst chain walks the actual portfolio.
 */
export function nextTicker(held: readonly string[] = []): Promise<string> {
  return advance(CURSOR, held.length ? held : FULL_UNIVERSE);
}
