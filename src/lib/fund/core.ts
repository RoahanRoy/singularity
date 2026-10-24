/**
 * The fund's index core (DESK_INDEX[market].etf): the index exposure the book
 * holds instead of cash, and what name buys are funded from once cash runs
 * out.
 *
 *  - A name buy spends cash first, then sells the fewest whole core shares
 *    that cover the rest, at a live core quote.
 *  - The core's target is the construction plan's core weight plus the name
 *    buys the plan has yet to make: until a name is bought, the cash earmarked
 *    for it sits in the core, so it keeps the index exposure and is there to
 *    sell when the buy fills.
 *
 * Pure. The fills are scripts/agents/paper-book.ts; the daily rebalance is
 * scripts/agents/core.ts.
 */
import type { Plan } from "./plan";

export type CoreHolding = { qty: number; price: number };

/** Whole shares of `price` that cash plus the whole core buys. */
export function affordableQty(price: number, cash: number, core: CoreHolding | null): number {
  if (!(price > 0)) return 0;
  const funds = Math.max(0, cash) + (core ? core.qty * core.price : 0);
  return Math.max(0, Math.floor(funds / price + 1e-9));
}

/** Core shares to sell so cash covers `need`: none while cash does, at most all of it. */
export function coreSellFor(need: number, cash: number, core: CoreHolding | null): number {
  if (!core || !(core.price > 0) || !(need > cash)) return 0;
  return Math.min(core.qty, Math.ceil((need - Math.max(0, cash)) / core.price - 1e-9));
}

/** The core's target weight: the plan's core line plus its pending name buys. Null without a core line. */
export function coreTargetWeight(plan: Pick<Plan, "nav" | "lines">): number | null {
  const core = plan.lines.find((l) => l.role === "core");
  if (!core || !(plan.nav > 0)) return null;
  const pending = plan.lines.filter((l) => l.role === "name" && l.value > 0).reduce((s, l) => s + l.value, 0);
  return Math.min(1, core.to + pending / plan.nav);
}

/**
 * Whole core shares to trade to reach `target` of `nav` at `price`: + buy, capped
 * by cash; − sell, at most the shares held.
 */
export function coreTrade(target: number, nav: number, price: number, held: number, cash: number): number {
  if (!(price > 0) || !(nav > 0)) return 0;
  const want = Math.floor((target * nav) / price + 1e-9);
  if (want > held) return Math.min(want - held, Math.floor(Math.max(0, cash) / price + 1e-9));
  return want < held ? -(held - want) : 0;
}
