/**
 * Idea pipeline — which names outside the book the desk researches next.
 *
 * The daily quant sweep leaves an ensemble verdict on every covered name. Its
 * composite already carries valuation: the DCF, DDM, residual-income and
 * multiples models vote in it at their prior weight, beside the models that
 * passed an out-of-sample test. An idea is a name in the desk's universe, on
 * neither book, whose fresh verdict is long (the ensemble's own direction
 * band) and whose valuation blend puts fair value at or above the price, ranked
 * by composite × confidence — the key the rebalance planner buys by, so the
 * names researched first are the ones it would size first. A long the
 * valuation calls overpriced is momentum or sentiment against value, not an
 * idea; one with no blend has no measured valuation and waits for one.
 *
 * Ranking is pure. Which ideas are already covered (the desk has written a
 * memo on them, so filings and news on them arrive as updates instead) is an
 * I/O question the desk answers while walking the list (scripts/agents/ideas.ts).
 */
import { edgeOf, freshVerdicts, type Verdict } from "./rebalance";

export type Idea = Verdict & {
  /** composite × confidence. */
  edge: number;
  /** The valuation blend's implied upside, % (≥ 0 for every idea). */
  upsidePct: number;
};

export type IdeaInput = {
  /** Ensemble verdicts, any age; the newest fresh one per ticker counts. */
  verdicts: readonly (Verdict & { upsidePct?: number | null })[];
  universe: readonly string[];
  /** Tickers on the fund or advisory book. */
  held: Iterable<string>;
  now: number;
  /** How old a verdict may be: the sweep's own freshness window. */
  maxAgeMs: number;
};

export type IdeaRanking = {
  ideas: Idea[];
  /** Fresh unheld universe longs left out for want of valuation upside, with why. */
  excluded: { ticker: string; reason: string }[];
};

export function rankIdeas(input: IdeaInput): IdeaRanking {
  const universe = new Set(input.universe.map((t) => t.toUpperCase()));
  const held = new Set([...input.held].map((t) => t.toUpperCase()));
  const fresh = freshVerdicts(input.verdicts, input.now, input.maxAgeMs);
  const ideas: Idea[] = [];
  const excluded: IdeaRanking["excluded"] = [];
  for (const v of fresh.values()) {
    const t = v.ticker.toUpperCase();
    if (v.direction !== "long" || !universe.has(t) || held.has(t)) continue;
    const upside = (v as { upsidePct?: number | null }).upsidePct;
    if (upside == null || !Number.isFinite(upside)) {
      excluded.push({ ticker: t, reason: "no valuation blend" });
      continue;
    }
    if (upside < 0) {
      excluded.push({ ticker: t, reason: `valuation upside ${upside.toFixed(1)}%` });
      continue;
    }
    ideas.push({ ...v, ticker: t, edge: edgeOf(v), upsidePct: upside });
  }
  ideas.sort((a, b) => b.edge - a.edge || a.ticker.localeCompare(b.ticker));
  return { ideas, excluded };
}

/** The blend's implied upside from an ensemble-combiner payload's `data`, or null. */
export function upsideOf(data: unknown): number | null {
  const blend = data && typeof data === "object" ? (data as { blend?: unknown }).blend : null;
  const up = blend && typeof blend === "object" ? (blend as { impliedUpsidePct?: unknown }).impliedUpsidePct : null;
  return typeof up === "number" && Number.isFinite(up) ? up : null;
}
