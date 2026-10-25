/**
 * The fund's daily index-core rebalance (src/lib/fund/core.ts): trade the core
 * ETF to the session's stored fund plan (construct.ts), its core weight plus
 * the name buys the plan has yet to make, at a live quote on the fund book as
 * it is marked now. Buys spend cash only; sells are capped at the shares held.
 *
 * Fills follow the desk's standing approval: with MERIDIAN_AUTO_APPROVE=1 the
 * desk loop fills it. Without, it fills under the operator's approval from the
 * Book (src/lib/fund/core-approval.ts: same side, at most the shares approved),
 * or by hand with scripts/core-rebalance.ts; otherwise the loop holds it.
 * Every fill is behind the circuit breaker (paper-book.ts). No plan for the
 * session, no trade.
 */
import { db, DB, emit, writeAudit, type Market } from "./appwrite";
import { markFundBook } from "./fund-book";
import { getQuote } from "./quotes";
import { exchangeDate } from "./market-hours";
import { fillPaperSell, fillPaperTrade } from "./paper-book";
import { storedPlan } from "./construct";
import { coreTargetWeight, coreTrade } from "../../src/lib/fund/core";
import {
  CORE_APPROVAL_COLLECTION,
  capToApproval,
  coreApprovalId,
  parseCoreApproval,
  type CoreApproval,
} from "../../src/lib/fund/core-approval";
import { DESK_INDEX } from "../../src/lib/market/indices";

export type CoreRun =
  | { status: "skipped"; reason: string }
  | { status: "at-target" | "held" | "unfilled" | "filled"; ticker: string; target: number; held: number; shares: number; price: number; detail: string };

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

/** The desk's open approval from the Book, or null. */
export async function openCoreApproval(market: Market): Promise<CoreApproval | null> {
  try {
    const doc = await db.getDocument(DB, CORE_APPROVAL_COLLECTION, coreApprovalId(market));
    const a = parseCoreApproval(doc.value_json);
    return a?.status === "approved" ? a : null;
  } catch (err) {
    if ((err as { code?: number }).code !== 404) console.warn(`[core] could not read the ${market} approval: ${(err as Error).message}`);
    return null;
  }
}

async function closeApproval(market: Market, a: CoreApproval, status: "filled" | "spent", detail: string): Promise<void> {
  const next: CoreApproval = { ...a, status, done_at: new Date().toISOString(), detail };
  await db.updateDocument(DB, CORE_APPROVAL_COLLECTION, coreApprovalId(market), { value_json: JSON.stringify(next) });
}

/**
 * `execute`: fill the trade (the desk's standing approval, or the operator's CLI
 * run). `approval`: fill it under the operator's Book approval, capped to it.
 * Neither: hold it.
 */
export async function rebalanceCore(
  market: Market,
  agentId: string,
  opts: { execute: boolean; approval?: CoreApproval | null; dry?: boolean; now?: Date },
): Promise<CoreRun> {
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
  let shares = coreTrade(target, book.equity, price, held, book.cash);
  const toward = `core ${pct((held * price) / book.equity)} → ${pct(target)} of ${book.equity.toFixed(0)} NAV (plan ${session})`;
  const approval = !opts.execute && !opts.dry ? opts.approval ?? null : null;
  let hold = `awaiting operator (approve it on the Book, run scripts/core-rebalance.ts ${market}, or set MERIDIAN_AUTO_APPROVE=1)`;
  let approved = false;
  if (approval && shares !== 0) {
    const capped = capToApproval(shares, approval);
    if ("hold" in capped) hold = capped.hold;
    else [shares, approved] = [capped.shares, true];
  }
  const base = { ticker, target, held, shares, price };
  const what = `${shares > 0 ? "BUY" : "SELL"} ${Math.abs(shares)} ${ticker} @ ${price.toFixed(2)}`;
  if (shares === 0) {
    if (approval) await closeApproval(market, approval, "spent", `${ticker} already at target: ${toward}`);
    return { status: "at-target", ...base, detail: `${ticker} at target: ${toward}` };
  }
  if (opts.dry) return { status: "held", ...base, detail: `dry run: ${what}, ${toward}` };
  if (!opts.execute && !approved) {
    await emit(agentId, "handoff", `HOLD core ${what} — ${toward}; ${hold}`, { ...base, session });
    return { status: "held", ...base, detail: `held: ${what}, ${toward}; ${hold}` };
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
  const under = approved ? ` under the operator's approval of ${approval!.side} ${approval!.max_shares} (plan ${approval!.plan_session})` : "";
  await writeAudit("broker", "core_rebalance", ticker, "allow", `Core rebalance fill: ${done}; ${toward}${under}`);
  if (approved) await closeApproval(market, approval!, "filled", `${done}; ${toward}`);
  await emit(agentId, "trade", `FILL core ${done} — ${toward}`, { ...base, session, trade_id: fill.id, filled_qty: fill.filled_qty });
  return { status: "filled", ...base, shares: Math.sign(shares) * fill.filled_qty, detail: `${done}, ${toward}` };
}
