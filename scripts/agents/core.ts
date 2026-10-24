/**
 * The fund's daily index-core rebalance (src/lib/fund/core.ts): trade the core
 * ETF to the session's stored fund plan (construct.ts), its core weight plus
 * the name buys the plan has yet to make, at a live quote on the fund book as
 * it is marked now. Buys spend cash only; sells are capped at the shares held.
 *
 * Fills follow the desk's standing approval: with MERIDIAN_AUTO_APPROVE=1 the
 * desk loop fills it; without, the loop holds it and the operator fills it by
 * hand with scripts/core-rebalance.ts. Every fill is behind the circuit
 * breaker (paper-book.ts). No plan for the session, no trade.
 */
import { emit, writeAudit, type Market } from "./appwrite";
import { markFundBook } from "./fund-book";
import { getQuote } from "./quotes";
import { exchangeDate } from "./market-hours";
import { fillPaperSell, fillPaperTrade } from "./paper-book";
import { storedPlan } from "./construct";
import { coreTargetWeight, coreTrade } from "../../src/lib/fund/core";
import { DESK_INDEX } from "../../src/lib/market/indices";

export type CoreRun =
  | { status: "skipped"; reason: string }
  | { status: "at-target" | "held" | "unfilled" | "filled"; ticker: string; target: number; held: number; shares: number; price: number; detail: string };

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

/** `execute`: fill the trade (the desk's standing approval, or the operator's CLI run); otherwise hold it. */
export async function rebalanceCore(market: Market, agentId: string, opts: { execute: boolean; dry?: boolean; now?: Date }): Promise<CoreRun> {
  const now = opts.now ?? new Date();
  const session = exchangeDate(market, now);
  const plan = await storedPlan(market, "fund", session);
  if (!plan) return { status: "skipped", reason: `no ${market} fund plan for ${session}` };
  const target = coreTargetWeight(plan);
  const ticker = DESK_INDEX[market].etf;
  if (target == null) return { status: "skipped", reason: `the ${session} plan has no ${ticker} core line` };

  const book = await markFundBook(market, now);
  if (!book.mandate || !(book.equity > 0)) return { status: "skipped", reason: `no ${market} fund NAV` };
  const heldName = book.names.find((n) => n.ticker.toUpperCase() === ticker);
  const price = heldName?.price ?? (await getQuote(ticker, market));
  if (price == null) return { status: "skipped", reason: `no live ${ticker} quote` };
  const held = heldName?.qty ?? 0;
  const shares = coreTrade(target, book.equity, price, held, book.cash);
  const base = { ticker, target, held, shares, price };
  const what = `${shares > 0 ? "BUY" : "SELL"} ${Math.abs(shares)} ${ticker} @ ${price.toFixed(2)}`;
  const toward = `core ${pct((held * price) / book.equity)} → ${pct(target)} of ${book.equity.toFixed(0)} NAV (plan ${session})`;
  if (shares === 0) return { status: "at-target", ...base, detail: `${ticker} at target: ${toward}` };
  if (opts.dry) return { status: "held", ...base, detail: `dry run: ${what}, ${toward}` };
  if (!opts.execute) {
    await emit(agentId, "handoff",
      `HOLD core ${what} — ${toward}; awaiting operator (scripts/core-rebalance.ts ${market}, or MERIDIAN_AUTO_APPROVE=1)`, { ...base, session });
    return { status: "held", ...base, detail: `held: ${what}, ${toward}` };
  }

  const fill = shares > 0
    ? await fillPaperTrade({ ticker, qty: shares, market, agentId })
    : await fillPaperSell({ ticker, qty: -shares, market, agentId });
  if (!fill.id || fill.filled_qty === 0) {
    const why = fill.halted ?? (fill.unquoted ? "no live quote" : "nothing to fill against");
    await emit(agentId, "handoff", `HOLD core ${what} — ${why}`, { ...base, session, halted: fill.halted });
    return { status: "unfilled", ...base, detail: `${what} not filled: ${why}` };
  }
  const done = `${shares > 0 ? "BUY" : "SELL"} ${fill.filled_qty} ${ticker} @ ${fill.fill_price.toFixed(2)}${fill.capped ? ` (capped from ${Math.abs(shares)})` : ""}`;
  await writeAudit("broker", "core_rebalance", ticker, "allow", `Core rebalance fill: ${done}; ${toward}`);
  await emit(agentId, "trade", `FILL core ${done} — ${toward}`, { ...base, session, trade_id: fill.id, filled_qty: fill.filled_qty });
  return { status: "filled", ...base, shares: Math.sign(shares) * fill.filled_qty, detail: `${done}, ${toward}` };
}
