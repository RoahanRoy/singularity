/**
 * Verdict flips — when a covered name's view needs redoing without a filing.
 *
 * A memo was written on the facts of the day: the ensemble verdict the analyst
 * saw is the newest one at or before the memo. When a later sweep calls the
 * name the other way (long ↔ short, the ensemble's own ±20 direction band), the
 * memo argues against the desk's current evidence and the name is researched
 * again. A move into or out of neutral isn't a flip: a name hovering at the
 * band's edge would otherwise re-run every day on noise.
 *
 * Pure. Loading the memo times and the verdicts is scripts/agents/flips.ts.
 */
import type { Verdict } from "./rebalance";

export type Flip = {
  ticker: string;
  /** The verdict the last memo was written on. */
  basis: Verdict;
  /** The fresh verdict that calls it the other way. */
  current: Verdict;
  memoAt: string;
};

/** The flip, or null: `basis` and `current` point opposite ways and `current` came after the memo. */
export function flipOf(basis: Verdict | null, current: Verdict | null, memoAt: string): Flip | null {
  if (!basis || !current) return null;
  const opposite =
    (basis.direction === "long" && current.direction === "short") ||
    (basis.direction === "short" && current.direction === "long");
  if (!opposite) return null;
  if (!(Date.parse(current.runAt) > Date.parse(memoAt))) return null;
  return { ticker: current.ticker.toUpperCase(), basis, current, memoAt };
}
