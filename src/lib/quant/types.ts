/**
 * Normalized market + fundamentals shapes shared by every quant module. The
 * reader (scripts/agents/market-data.ts) maps vendor payloads onto these, so
 * the math never sees vendor field names or sign conventions.
 */

/** One daily (or intraday) OHLCV bar. `close` is split-adjusted; `adjClose` is split- and dividend-adjusted. */
export type Bar = {
  /** Unix seconds (bar open). */
  t: number;
  /** YYYY-MM-DD in the exchange's calendar. */
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  adjClose: number;
  volume: number;
};

export type PriceHistory = {
  symbol: string;
  currency: string | null;
  bars: Bar[];
};

/**
 * Financial statement line items, normalized:
 * - every outflow-type cash-flow item (capex, dividends, buybacks) is a POSITIVE spend;
 * - `changeInWc` keeps the cash-flow-statement sign (negative = working capital
 *   absorbed cash), so ΔNWC = −changeInWc;
 * - `taxRate` is a decimal.
 */
export type FinField =
  | "revenue" | "costOfRevenue" | "grossProfit" | "sga" | "rnd"
  | "operatingIncome" | "ebit" | "ebitda" | "da"
  | "interestExpense" | "interestIncome" | "netInterestIncome"
  | "pretaxIncome" | "taxProvision" | "taxRate" | "netIncome"
  | "dilutedEps" | "dilutedShares" | "sharesOutstanding"
  | "totalAssets" | "currentAssets" | "currentLiabilities" | "inventory"
  | "receivables" | "payables" | "cash" | "cashAndSti"
  | "totalDebt" | "longTermDebt" | "totalLiabilities" | "equity" | "retainedEarnings"
  | "netPpe" | "workingCapital" | "investedCapital" | "tangibleBook"
  | "cfo" | "capex" | "fcf" | "dividendsPaid" | "buybacks" | "changeInWc";

export type FinRow = Partial<Record<FinField, number>> & {
  /** Period end, YYYY-MM-DD. */
  asOf: string;
};

export type Fundamentals = {
  /** Reporting currency (may differ from the listing currency). */
  currency: string | null;
  /** Fiscal years, oldest → newest. */
  annual: FinRow[];
  /** Quarterly (or half-yearly for NSE filers) snapshots, oldest → newest. */
  quarterly: FinRow[];
  /** Trailing-twelve-month flows as of the latest quarter, when published. */
  ttm: FinRow | null;
};

export type Market = "US" | "IN";

/** A number with where it came from, so agents can cite or flag it. */
export type Sourced<T = number> = { value: T; source: string; assumption?: boolean };

/** Returns the field from the newest row that has it (scanning newest → oldest). */
export function latest(rows: readonly FinRow[], field: FinField): number | undefined {
  for (let i = rows.length - 1; i >= 0; i--) {
    const v = rows[i][field];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return undefined;
}

/** TTM flow → latest annual fallback. */
export function ttmOrAnnual(f: Fundamentals, field: FinField): number | undefined {
  const t = f.ttm?.[field];
  if (typeof t === "number" && Number.isFinite(t)) return t;
  return latest(f.annual, field);
}

/** Latest balance-sheet value: quarterly snapshot → annual fallback. */
export function latestBalance(f: Fundamentals, field: FinField): number | undefined {
  return latest(f.quarterly, field) ?? latest(f.annual, field);
}
