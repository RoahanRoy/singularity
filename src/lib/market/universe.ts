/**
 * The desks' research universes: hand-picked liquid names per analyst sector,
 * US large caps and NSE names. Pure data, shared by the desk loops
 * (scripts/agents/universe.ts) and the desk's idea queue.
 */
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

export const FULL_UNIVERSE: readonly string[] = Object.values(SECTOR_UNIVERSE).flatMap((arr) => [...arr]);

// ── India (NSE) ──────────────────────────────────────────────────────────────
// NSE-listed names mapped onto the SAME six analyst sectors as the US desk, so
// the India loop reuses the existing sector-analyst prompts. Banks/NBFC →
// financials, IT services → tech, FMCG/auto → consumer, pharma → healthcare,
// energy/materials → energy, capital goods → industrials.
// Symbols follow NSE's renames: LTIMindtree is LTM, ICICI Prudential Life is
// ICICILIFE, and Tata Motors split into TMPV (cars) and TMCV (trucks).
export const INDIA_SECTOR_UNIVERSE: Record<Sector, readonly string[]> = {
  tech:        ["TCS", "INFY", "HCLTECH", "WIPRO", "TECHM", "LTM", "PERSISTENT", "COFORGE"],
  healthcare:  ["SUNPHARMA", "DRREDDY", "CIPLA", "DIVISLAB", "APOLLOHOSP", "LUPIN", "AUROPHARMA"],
  energy:      ["RELIANCE", "ONGC", "NTPC", "POWERGRID", "COALINDIA", "BPCL", "IOC", "TATAPOWER"],
  // Banks, NBFCs, insurers, AMCs, brokers, and capital-market infrastructure —
  // depositories (CDSL/NSDL), exchanges (BSE/MCX), and registrars/RTAs
  // (CAMS/KFINTECH) are all financials, not consumer.
  financials:  ["HDFCBANK", "ICICIBANK", "SBIN", "KOTAKBANK", "AXISBANK", "BAJFINANCE",
                "BAJAJFINSV", "INDUSINDBK", "SBILIFE", "HDFCLIFE", "ICICILIFE", "ICICIGI",
                "HDFCAMC", "CAMS", "KFINTECH", "CDSL", "BSE", "MCX", "ANGELONE",
                "MUTHOOTFIN", "CHOLAFIN", "SHRIRAMFIN", "PFC", "RECLTD"],
  consumer:    ["HINDUNILVR", "ITC", "NESTLEIND", "TITAN", "MARUTI", "TMPV", "M&M", "BRITANNIA"],
  industrials: ["LT", "ADANIPORTS", "SIEMENS", "BEL", "HAL", "ABB", "BHEL", "GRASIM", "TMCV"],
};

export const INDIA_UNIVERSE: readonly string[] = Object.values(INDIA_SECTOR_UNIVERSE).flatMap((a) => [...a]);

/** A desk's universe. */
export const UNIVERSE: Record<"US" | "IN", readonly string[]> = { US: FULL_UNIVERSE, IN: INDIA_UNIVERSE };
