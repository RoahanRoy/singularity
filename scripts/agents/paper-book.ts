/**
 * The paper broker's fills on the fund book (fund-book.ts): positions rows with
 * no brokerage account id and no horizon_source, which a Horizon/IBKR sync
 * never touches, and the mandate's cash.
 *
 * Every fill is at a live quote (no quote, no fill: the caller holds the
 * order) and behind the circuit breaker. Names are only bought; the index core
 * (src/lib/fund/core.ts) is bought with cash and sold to fund name buys past
 * cash, or by the daily core rebalance (core.ts). A sell never deletes a row:
 * a position sold out stays at qty 0.
 */
import { db, DB, ID, writeAudit, type Market } from "./appwrite";
import { getQuote } from "./quotes";
import { checkCircuitBreaker } from "./circuit-breaker";
import { fundRows, type FundRow } from "./fund-book";
import { getMandate, deployableCash, debitCash, creditCash } from "../../src/lib/fund/mandate";
import { affordableQty, coreSellFor, type CoreHolding } from "../../src/lib/fund/core";
import { DESK_INDEX } from "../../src/lib/market/indices";
import type { FundMandate } from "../../src/lib/appwrite/schema";

const toVenue = (venue?: string | null) => (venue ? `paper-${venue}` : "paper-IBKR").slice(0, 32);

/** Restate every fund position's weight as its share of fund NAV (`cash` plus the positions). */
async function restateWeights(book: FundRow[], cash: number): Promise<void> {
  // Weights as fractions (0..1) of fund NAV. Small book, so writing each row
  // per fill is cheap.
  const nav = cash + book.reduce((s, p) => s + Math.abs(p.market_value), 0);
  if (!(nav > 0)) return;
  await Promise.all(
    book.map((p) =>
      db.updateDocument(DB, "positions", p.$id, {
        weight: Number((p.market_value / nav).toFixed(6)),
      }).catch(() => {}),
    ),
  );
}

/**
 * Book a paper BUY: add to (or open) the ticker's fund position at `price`,
 * then restate the weights (`cash`: the mandate's cash after this fill).
 */
async function bookPaperBuy(ticker: string, qty: number, price: number, market: Market, cash: number): Promise<void> {
  const book = await fundRows(market);
  const existing = book.find((p) => p.ticker.toUpperCase() === ticker.toUpperCase());

  if (existing) {
    const newQty = existing.qty + qty;
    const newAvg = newQty > 0 ? (existing.qty * existing.avg_cost + qty * price) / newQty : price;
    existing.qty = newQty;
    existing.avg_cost = newAvg;
    existing.market_value = newQty * price;
    await db.updateDocument(DB, "positions", existing.$id, {
      qty: newQty,
      avg_cost: Number(newAvg.toFixed(4)),
      market_value: Number((newQty * price).toFixed(2)),
      unrealized_pnl: Number(((price - newAvg) * newQty).toFixed(2)),
    });
  } else {
    const created = await db.createDocument(DB, "positions", ID.unique(), {
      ticker: ticker.toUpperCase(),
      qty,
      avg_cost: Number(price.toFixed(4)),
      market_value: Number((qty * price).toFixed(2)),
      unrealized_pnl: 0,
      weight: 0, // set by the restate pass below
      factor_exposures_json: null,
      market,
    });
    book.push({ $id: created.$id, ticker, qty, avg_cost: price, market_value: qty * price });
  }
  await restateWeights(book, cash);
}

/** Book a paper SELL: take `qty` off the ticker's fund position at `price` (a sold-out row stays, at qty 0). */
async function bookPaperSell(ticker: string, qty: number, price: number, market: Market, cash: number): Promise<void> {
  const book = await fundRows(market);
  const existing = book.find((p) => p.ticker.toUpperCase() === ticker.toUpperCase());
  if (!existing) throw new Error(`no ${ticker} fund position to sell`);
  const newQty = Math.max(0, existing.qty - qty);
  existing.qty = newQty;
  existing.market_value = newQty * price;
  await db.updateDocument(DB, "positions", existing.$id, {
    qty: newQty,
    market_value: Number((newQty * price).toFixed(2)),
    unrealized_pnl: Number(((price - existing.avg_cost) * newQty).toFixed(2)),
  });
  await restateWeights(book, cash);
}

/**
 * Record a filled paper sell: the trades row, the book, and the proceeds to the
 * mandate's cash. Returns the mandate as it stands after. The fill is real once
 * the trades row is written, so a booking or credit failure is logged, not unwound.
 */
async function recordSell(
  input: { ticker: string; qty: number; price: number; market: Market; venue: string; agentId: string },
  mandate: FundMandate,
): Promise<{ id: string; mandate: FundMandate }> {
  const { ticker, qty, price, market } = input;
  const proceeds = Number((qty * price).toFixed(2));
  const trade = await db.createDocument(DB, "trades", ID.unique(), {
    ticker: ticker.toUpperCase(),
    side: "sell",
    qty,
    price,
    venue: input.venue,
    agent_id: input.agentId,
    status: "filled",
    filled_at: new Date().toISOString(),
    market,
  });
  try {
    await bookPaperSell(ticker, qty, price, market, mandate.cash + proceeds);
  } catch (err) {
    console.warn(`[broker] paper book update failed for ${ticker} sell:`, (err as Error).message);
  }
  let cash = mandate.cash;
  try {
    cash = await creditCash(db, DB, mandate, proceeds);
  } catch (err) {
    console.warn(`[broker] cash credit failed for ${ticker} sell:`, (err as Error).message);
  }
  return { id: trade.$id, mandate: { ...mandate, cash } };
}

/** The fund's index core as held now, at a live quote; null when none is held or it has no quote. */
export async function coreHolding(market: Market): Promise<CoreHolding | null> {
  const t = DESK_INDEX[market].etf;
  const row = (await fundRows(market)).find((p) => p.ticker.toUpperCase() === t && p.qty > 0);
  if (!row) return null;
  const q = await getQuote(t, market);
  return q == null ? null : { qty: row.qty, price: Number(q.toFixed(2)) };
}

export type Fill = {
  id: string | null;
  fill_price: number;
  filled_qty: number;
  capped: boolean;
  halted: string | null;
  unquoted: boolean;
  /** Core shares sold to fund a name buy, and the sell's trades row. */
  core_sold: number;
  core_trade_id: string | null;
};

/**
 * A paper BUY fill: a live quote, a trades row, and the book update. Without a
 * live quote nothing fills (`unquoted`), so the caller holds the order rather
 * than booking it at a made-up price. Shared by the auto-execute path, the
 * operator-approved path and the core rebalance so all fill identically.
 *
 * The mandate bites here: a name buy spends its cash, then sells the fewest
 * index-core shares that cover the rest (at a live core quote); the qty is
 * capped to what the two buy. `filled_qty === 0` means the fund is out of both
 * — nothing is booked and the caller should hold the order for a later cycle.
 * A core buy spends cash only.
 *
 * The circuit breaker runs first, ahead of any quote or write: a non-null
 * `halted` means the desk's loss/drawdown limits (or an unmarkable book) have
 * stopped new fills, or there is no fund mandate to fill against — nothing is
 * booked and the caller must not retry blindly.
 */
export async function fillPaperTrade(
  input: { ticker: string; qty: number; market: Market; venue?: string | null; agentId: string },
): Promise<Fill> {
  const { ticker, market } = input;
  const t = ticker.toUpperCase();
  const none = { id: null, core_sold: 0, core_trade_id: null };

  const breaker = await checkCircuitBreaker(market, input.agentId);
  if (breaker.halted) {
    const reason = `circuit breaker: ${breaker.reason ?? "halted"}`;
    await writeAudit("circuit-breaker", "fill_blocked", t, "block", `BUY ${input.qty} ${t} not filled: ${reason}`);
    return { ...none, fill_price: 0, filled_qty: 0, capped: false, halted: reason, unquoted: false };
  }

  const quoted = await getQuote(ticker, market);
  if (quoted == null) {
    await writeAudit("broker", "fill_blocked", t, "block", `BUY ${input.qty} ${t} not filled: no live quote`);
    return { ...none, fill_price: 0, filled_qty: 0, capped: false, halted: null, unquoted: true };
  }
  const price = Number(quoted.toFixed(2));
  const venue = toVenue(input.venue);

  // No mandate → no cash → no fill.
  let mandate = await getMandate(db, DB, market).catch(() => null);
  if (!mandate) {
    const reason = `no ${market} fund mandate to fill against`;
    await writeAudit("broker", "fill_blocked", t, "block", `BUY ${input.qty} ${t} not filled: ${reason}`);
    return { ...none, fill_price: price, filled_qty: 0, capped: false, halted: reason, unquoted: false };
  }
  const cash = deployableCash(mandate);
  const coreTicker = DESK_INDEX[market].etf;
  const core = t !== coreTicker && input.qty * price > cash ? await coreHolding(market).catch(() => null) : null;

  let qty = input.qty;
  let capped = false;
  const affordable = affordableQty(price, cash, core);
  if (affordable < qty) { qty = affordable; capped = true; }
  if (qty <= 0) return { ...none, fill_price: price, filled_qty: 0, capped: true, halted: null, unquoted: false };

  let coreSold = 0;
  let coreTradeId: string | null = null;
  const sell = coreSellFor(qty * price, cash, core);
  if (sell > 0 && core) {
    const s = await recordSell({ ticker: coreTicker, qty: sell, price: core.price, market, venue, agentId: input.agentId }, mandate);
    mandate = s.mandate;
    coreSold = sell;
    coreTradeId = s.id;
    await writeAudit("broker", "core_funding", coreTicker, "allow",
      `SELL ${sell} ${coreTicker} @ ${core.price} to fund BUY ${qty} ${t} @ ${price} past ${cash.toFixed(2)} cash`);
  }

  const trade = await db.createDocument(DB, "trades", ID.unique(), {
    ticker: t,
    side: "buy",
    qty,
    price,
    venue,
    agent_id: input.agentId,
    status: "filled",
    filled_at: new Date().toISOString(),
    market,
  });

  // Reflect the fill in the paper book. Best-effort: a booking failure must not
  // undo a recorded fill, so we log and continue.
  try {
    await bookPaperBuy(ticker, qty, price, market, Math.max(0, mandate.cash - qty * price));
  } catch (err) {
    console.warn(`[broker] paper book update failed for ${ticker}:`, (err as Error).message);
  }

  // Debit deployed capital from the mandate. Best-effort: the fill is already
  // real, so a debit failure is logged, not unwound.
  try {
    await debitCash(db, DB, mandate, Number((qty * price).toFixed(2)));
  } catch (err) {
    console.warn(`[broker] cash debit failed for ${ticker}:`, (err as Error).message);
  }

  return { id: trade.$id, fill_price: price, filled_qty: qty, capped, halted: null, unquoted: false, core_sold: coreSold, core_trade_id: coreTradeId };
}

/**
 * A paper SELL fill of a fund position, at a live quote and behind the circuit
 * breaker like a buy; capped at the shares held. The core rebalance's sell.
 */
export async function fillPaperSell(
  input: { ticker: string; qty: number; market: Market; venue?: string | null; agentId: string },
): Promise<Fill> {
  const { ticker, market } = input;
  const t = ticker.toUpperCase();
  const none = { id: null, core_sold: 0, core_trade_id: null };

  const breaker = await checkCircuitBreaker(market, input.agentId);
  if (breaker.halted) {
    const reason = `circuit breaker: ${breaker.reason ?? "halted"}`;
    await writeAudit("circuit-breaker", "fill_blocked", t, "block", `SELL ${input.qty} ${t} not filled: ${reason}`);
    return { ...none, fill_price: 0, filled_qty: 0, capped: false, halted: reason, unquoted: false };
  }
  const quoted = await getQuote(ticker, market);
  if (quoted == null) {
    await writeAudit("broker", "fill_blocked", t, "block", `SELL ${input.qty} ${t} not filled: no live quote`);
    return { ...none, fill_price: 0, filled_qty: 0, capped: false, halted: null, unquoted: true };
  }
  const price = Number(quoted.toFixed(2));
  const mandate = await getMandate(db, DB, market).catch(() => null);
  if (!mandate) {
    const reason = `no ${market} fund mandate to fill against`;
    await writeAudit("broker", "fill_blocked", t, "block", `SELL ${input.qty} ${t} not filled: ${reason}`);
    return { ...none, fill_price: price, filled_qty: 0, capped: false, halted: reason, unquoted: false };
  }
  const held = (await fundRows(market)).find((p) => p.ticker.toUpperCase() === t)?.qty ?? 0;
  const qty = Math.min(input.qty, held);
  if (qty <= 0) return { ...none, fill_price: price, filled_qty: 0, capped: true, halted: null, unquoted: false };
  const s = await recordSell({ ticker: t, qty, price, market, venue: toVenue(input.venue), agentId: input.agentId }, mandate);
  return { ...none, id: s.id, fill_price: price, filled_qty: qty, capped: qty < input.qty, halted: null, unquoted: false };
}
