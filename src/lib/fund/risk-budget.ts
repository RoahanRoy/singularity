/**
 * The fund's risk budget: one operator choice per desk — a target annual
 * tracking error against the desk index (`risk_budgets`, stored with the date
 * it was set) — and every limit the desk trades under, derived from it and
 * from measured volatility. No other limit is a number someone picked.
 *
 *  - Trade gate. A buy clears when the fund book's tracking error after the
 *    trade is at or under the target, or no higher than it is now (deploying
 *    cash closes the gap to the index, so a book above target may still buy), and
 *    the name's own active risk — its weight after the trade times the vol of
 *    its return less the index's — stays within the whole target.
 *  - Size cap. The largest add that clears the gate (`largestAdd`).
 *  - Day-loss halt. Under the target, book vol can reach at most index vol +
 *    target (beta at most 1 + target / index vol, residual risk nil), so a
 *    day's loss beyond that vol's one-in-a-hundred move is outside the budget.
 *  - Lag halt. Flow-free underperformance of the index beyond the
 *    one-in-a-hundred band the target implies over the sessions since the
 *    fund's first mark: target · z99 · √(sessions / 252).
 *
 * 99% is a method convention (the tail the risk report already measures), not
 * a decision number; the decision number is the target.
 */
import { normInv } from "../quant/stats";
import { TRADING_DAYS } from "../quant/risk";

export const Z99 = normInv(0.99);

/** The largest one-day loss, as a fraction of equity, the budget allows before halting. */
export function dayLossLimit(targetTe: number, indexVol: number): number {
  return (Z99 * (indexVol + targetTe)) / Math.sqrt(TRADING_DAYS);
}

/** The flow-free lag behind the index, as a log return, that halts after `sessions`. */
export function lagLimit(targetTe: number, sessions: number): number {
  return Z99 * targetTe * Math.sqrt(Math.max(0, sessions) / TRADING_DAYS);
}

export type GateInput = {
  target: number;
  /** Fund book TE now and after the trade (annual). */
  teBefore: number;
  teAfter: number;
  /** The name's weight in NAV after the trade, and its active vol (annual). */
  nameWeightAfter: number;
  nameActiveVol: number;
};

// Floating-point slack, so a size computed right at a limit (largestAdd) clears it.
const ROUNDING = 1e-9;

/** Which parts of the budget a trade breaks; empty when it clears. */
export function gateTrade(g: GateInput): string[] {
  const out: string[] = [];
  const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
  if (g.teAfter > Math.max(g.target, g.teBefore) + ROUNDING) {
    out.push(`tracking error ${pct(g.teBefore)} → ${pct(g.teAfter)} breaches the ${pct(g.target)} target`);
  }
  const own = g.nameWeightAfter * g.nameActiveVol;
  if (own > g.target + ROUNDING) {
    out.push(`the name's own active risk ${pct(own)} (${pct(g.nameWeightAfter)} × ${pct(g.nameActiveVol)} active vol) exceeds the ${pct(g.target)} target`);
  }
  return out;
}

/**
 * The largest weight to add to a name that still clears the gate, within
 * [0, wMax] (wMax: the cash the trade can spend, as a weight). Tracking error
 * is convex in the added weight, so the weights that clear form an interval
 * from 0; its upper end is found by bisection.
 */
export function largestAdd(
  teAt: (add: number) => number,
  o: { target: number; teBefore: number; nameWeightBefore: number; nameActiveVol: number; wMax: number },
): number {
  const own = o.nameActiveVol > 0 ? o.target / o.nameActiveVol - o.nameWeightBefore : o.wMax;
  const hi0 = Math.max(0, Math.min(o.wMax, own));
  const ceiling = Math.max(o.target, o.teBefore);
  const clears = (add: number) => teAt(add) <= ceiling;
  if (clears(hi0)) return hi0;
  let lo = 0, hi = hi0;
  for (let i = 0; i < 40 && hi - lo > 1e-6; i++) {
    const mid = (lo + hi) / 2;
    if (clears(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}
