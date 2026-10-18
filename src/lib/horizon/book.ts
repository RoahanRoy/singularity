import { createHash } from "node:crypto";
import type { Market } from "@/lib/appwrite/schema";
import type { HorizonExport, HorizonHolding } from "./client";

/** One row of the book, in the desk's currency (INR for IN, USD for US). */
export type BookRow = {
  ticker: string;
  /** Display name, set only where the ticker doesn't say it (a fund). */
  label: string;
  market: Market;
  qty: number;
  mv: number;
  cost: number;
  pnl: number;
  brokers: Set<string>;
};

/** The Indian book is rupees; everything held abroad goes to the US desk. */
function marketOf(h: HorizonHolding): Market {
  return h.currency === "INR" ? "IN" : "US";
}

/**
 * The book's ticker for a holding. A listed instrument keeps its exchange
 * symbol, which is what the desk loops research and price. A fund has no
 * listing: its AMFI scheme code names it exactly, and an unmatched scheme
 * falls back to a digest of its name, so the same fund held by two members
 * still lands on one row. "MF:" marks these for the agent loops to skip.
 */
export function tickerOf(h: HorizonHolding, market: Market): string {
  if (h.symbol) {
    const s = h.symbol.trim().toUpperCase();
    // Yahoo and EDGAR hyphenate a US share class ("BRK-B"); brokers write "BRK B" / "BRK.B".
    return (market === "US" ? s.replace(/[\s.]+/g, "-") : s).slice(0, 16);
  }
  const id =
    h.schemeCode ?? createHash("sha256").update(h.name.trim().toLowerCase()).digest("hex").slice(0, 10);
  return `MF:${id}`.slice(0, 16);
}

/**
 * Fold Horizon's holdings into one row per ticker. Horizon states every
 * figure in rupees; the US desk's are restated in USD at Horizon's own rate,
 * so a euro-settled holding crosses through the rupee at the rates Horizon
 * valued it with. The same instrument held by several members or brokers
 * sums into one row — tickers are unique across both desks (by_ticker index).
 */
export function foldHoldings(data: Pick<HorizonExport, "fx" | "holdings">): {
  rows: BookRow[];
  skipped: { ticker: string; reason: string }[];
} {
  const book = new Map<string, BookRow>();
  const skipped: { ticker: string; reason: string }[] = [];

  for (const h of data.holdings) {
    if (h.kind === "cash" || h.valueInr <= 0) continue;
    const market = marketOf(h);
    const rate = market === "IN" ? 1 : data.fx.usdInr;
    const ticker = tickerOf(h, market);
    if (!(rate > 0)) {
      skipped.push({ ticker, reason: "Horizon sent no USD rate" });
      continue;
    }
    const prior = book.get(ticker);
    if (prior && prior.market !== market) {
      skipped.push({ ticker, reason: `ticker already used on the ${prior.market} book` });
      continue;
    }
    const row = prior ?? {
      ticker,
      label: h.symbol ? "" : h.name,
      market,
      qty: 0,
      mv: 0,
      cost: 0,
      pnl: 0,
      brokers: new Set<string>(),
    };
    row.qty += h.quantity;
    row.mv += h.valueInr / rate;
    row.cost += h.investedInr / rate;
    row.pnl += h.pnlInr / rate;
    if (h.broker) row.brokers.add(h.broker);
    book.set(ticker, row);
  }

  return { rows: [...book.values()], skipped };
}
