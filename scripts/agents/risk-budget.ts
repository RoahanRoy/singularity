/**
 * The operator's risk budget per desk (`risk_budgets`, append-only: the
 * latest row applies, earlier ones are the record of what was set when) and
 * the pre-trade measurement the desk sizes and gates against
 * (src/lib/fund/risk-budget.ts).
 *
 * `measureTrade` marks the fund book (fund-book.ts), pulls each name's daily
 * history and runs the portfolio risk engine on the book as it is and with the
 * trade added — funded from cash, then by selling the index core, as the
 * paper broker fills it (paper-book.ts). Anything it can't measure stages the
 * trade rather than guess:
 * no budget, a held name without a live quote, a held or traded name without a
 * full window of history, no index history.
 */
import { db, DB } from "./appwrite";
import { markFundBook } from "./fund-book";
import { measure, withHistory } from "./portfolio-risk";
import { DESK_INDEX } from "../../src/lib/market/indices";
import { appendRiskBudget, getRiskBudget, type RiskBudgetRow } from "../../src/lib/fund/budget-store";
import type { PortfolioRisk } from "../../src/lib/quant/portfolio-risk";

type Market = "US" | "IN";

export type RiskBudget = RiskBudgetRow;

/** The desk's current risk budget, or null before the operator has set one. */
export const loadBudget = (market: Market) => getRiskBudget(db, DB, market);

/** Record a new budget for the desk. Appends; the prior rows stay as history. */
export const setBudget = (market: Market, targetTe: number, setBy: string, note?: string) =>
  appendRiskBudget(db, DB, market, targetTe, setBy, note);

export type TradeRisk =
  | { ok: false; reason: string }
  | {
      ok: true;
      budget: RiskBudget;
      nav: number;
      cash: number;
      /** The index core's ETF and its value held at a live mark (0 when none is held). */
      core: string;
      coreValue: number;
      index: string;
      before: PortfolioRisk;
      /** The name's weight in NAV before the trade and its active vol (annual). */
      nameWeightBefore: number;
      nameActiveVol: number;
      /** The book's risk report with `add` (a weight of NAV) bought at `price`, past cash out of the core. */
      after: (add: number) => PortfolioRisk;
    };

export async function measureTrade(market: Market, ticker: string, price: number, now: Date = new Date()): Promise<TradeRisk> {
  const budget = await loadBudget(market);
  if (!budget) return { ok: false, reason: `no ${market} risk budget set (scripts/set-risk-budget.ts)` };
  const book = await markFundBook(market, now);
  if (!book.mandate || !(book.equity > 0)) return { ok: false, reason: `no ${market} fund mandate, no NAV to measure against` };
  if (book.unpriced_pct > 0) return { ok: false, reason: `${book.unpriced_pct}% of the ${market} fund book has no live quote this session` };
  if (!(price > 0)) return { ok: false, reason: `no price for ${ticker}` };

  const t = ticker.toUpperCase();
  const held = book.names.filter((n) => n.qty > 0).map((n) => ({ ticker: n.ticker.toUpperCase(), qty: n.qty, price: n.price! }));
  const names = held.some((h) => h.ticker === t) ? held : [...held, { ticker: t, qty: 0, price }];
  const hist = await withHistory(market, names);
  if (!hist) return { ok: false, reason: `no ${DESK_INDEX[market].symbol} history` };

  const nav = book.equity;
  const core = DESK_INDEX[market].etf;
  const coreHeld = t === core ? undefined : hist.holdings.find((h) => h.ticker === core && h.qty > 0);
  const coreValue = coreHeld ? coreHeld.qty * coreHeld.price : 0;
  const at = (add: number) => {
    const fromCore = Math.min(coreValue, Math.max(0, add * nav - book.cash));
    const holdings = hist.holdings.map((h) =>
      h.ticker === t ? { ...h, qty: h.qty + (add * nav) / price, price }
        : h === coreHeld ? { ...h, qty: h.qty - fromCore / h.price } : h,
    );
    return measure(nav, holdings, hist.index);
  };
  const before = at(0);
  if (!before) return { ok: false, reason: `under a year of ${DESK_INDEX[market].symbol} history` };
  // A zero-qty name still gets measured: its row carries the active vol.
  const name = before.names.find((n) => n.ticker === t);
  if (!name) return { ok: false, reason: `${t} has no full year of daily history to measure` };
  if (before.unmeasured.length) {
    return { ok: false, reason: `held ${before.unmeasured.map((u) => u.ticker).join(", ")} can't be measured (${before.unmeasured[0].reason})` };
  }
  return {
    ok: true,
    budget,
    nav,
    cash: book.cash,
    core,
    coreValue: Number(coreValue.toFixed(2)),
    index: DESK_INDEX[market].name,
    before,
    nameWeightBefore: name.weight,
    nameActiveVol: name.active_vol,
    after: (add) => at(add)!,
  };
}
