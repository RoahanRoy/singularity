/**
 * Rebalance — what to buy and sell on the real book, as advice.
 *
 * The desk loop only trades when the investment committee approves a memo, so
 * on its own it never says what to do with holdings that already exist. This
 * module turns the quant desk's latest ensemble verdict per ticker into an
 * advisory trade list over the real (Horizon/IBKR) book: nothing here places an
 * order — the operator reads the list and trades by hand.
 *
 * Rules, in order:
 *  - The capital being planned is the book's market value plus the mandate's
 *    undeployed cash, which is treated as fresh money to put to work.
 *  - Funds and names without a fresh verdict are held as they are (beyond the
 *    name cap below): there is no quant view to act on.
 *  - A short verdict trims the position by half; neutral holds; a long tops the
 *    name up toward cap × confidence (never selling a long down to it).
 *  - No listed name may exceed max_name_weight_pct of the capital; the excess is
 *    trimmed whatever the verdict.
 *  - New buys come from the strongest unheld longs (composite × confidence),
 *    one per open slot under max_names, each sized at cap × confidence.
 *  - Buys are paid for by the cash plus sell proceeds and scaled down pro rata
 *    when they would cost more, so the plan never spends money it doesn't have.
 *  - Trades smaller than minTradePct of the capital are dropped as noise.
 *
 * Pure: no I/O, so the Portfolio screen and the tests share it.
 */
import type { QuantReport } from "@/lib/appwrite/schema";

export type Direction = "long" | "short" | "neutral";

export type RebalanceHolding = {
  ticker: string;
  label?: string | null;
  /** Market value in the desk currency. */
  marketValue: number;
  qty: number;
  isFund: boolean;
};

export type Verdict = {
  ticker: string;
  direction: Direction;
  composite: number;
  confidence: number;
  price: number | null;
  currency: string | null;
  runAt: string;
};

export type RebalanceInput = {
  holdings: RebalanceHolding[];
  /** Newest verdict per ticker; stale ones are ignored. */
  verdicts: Verdict[];
  /** Undeployed mandate cash, added as new money. */
  cash: number;
  maxNames: number;
  maxNameWeightPct: number;
  /** Desk currency ("USD" | "INR"): a verdict priced in anything else can't size a new buy. */
  currency: string;
  /** Indian exchanges trade whole shares; US brokers take fractions. */
  wholeShares: boolean;
  now?: number;
  maxAgeDays?: number;
  minTradePct?: number;
};

export type RebalanceAction = "trim" | "add" | "buy";

export type RebalanceTrade = {
  ticker: string;
  label?: string | null;
  action: RebalanceAction;
  /** Absolute trade value in the desk currency. */
  value: number;
  /** Shares to trade, or null when no price is known. */
  shares: number | null;
  price: number | null;
  fromWeight: number;
  toWeight: number;
  reason: string;
};

export type RebalancePlan = {
  /** Book market value + mandate cash: the base every weight is a share of. */
  capital: number;
  trades: RebalanceTrade[];
  /** Held names the plan leaves alone for want of a view, with why. */
  unrated: { ticker: string; label?: string | null; reason: string }[];
  sellProceeds: number;
  buyCost: number;
  cashAfter: number;
  listedNames: number;
  openSlots: number;
  /** Fresh unheld longs that got no slot because the book is at its name limit. */
  longsBlocked: number;
  notes: string[];
};

const DAY_MS = 86_400_000;

export function planRebalance(input: RebalanceInput): RebalancePlan {
  const now = input.now ?? Date.now();
  const maxAge = (input.maxAgeDays ?? 7) * DAY_MS;
  const minTrade = (input.minTradePct ?? 0.5) / 100;
  const notes: string[] = [];

  const fresh = new Map<string, Verdict>();
  for (const v of input.verdicts) {
    const t = Date.parse(v.runAt);
    if (!Number.isFinite(t) || now - t > maxAge) continue;
    const prev = fresh.get(v.ticker);
    if (!prev || Date.parse(prev.runAt) < t) fresh.set(v.ticker, v);
  }

  const bookValue = input.holdings.reduce((s, h) => s + Math.max(0, h.marketValue), 0);
  const cash = Math.max(0, input.cash);
  const capital = bookValue + cash;
  const empty: RebalancePlan = {
    capital, trades: [], unrated: [], sellProceeds: 0, buyCost: 0, cashAfter: cash,
    listedNames: 0, openSlots: 0, longsBlocked: 0, notes,
  };
  if (capital <= 0) return empty;

  const capPct = input.maxNameWeightPct;
  const cap = (capPct / 100) * capital;
  const w = (x: number) => x / capital;
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const roundShares = (s: number) => (input.wholeShares ? Math.floor(s) : Math.floor(s * 100) / 100);
  const priceFor = (v: Verdict | undefined) =>
    v && v.price != null && v.price > 0 && v.currency === input.currency ? v.price : null;
  const describe = (v: Verdict) =>
    `quant ${v.direction} (composite ${v.composite > 0 ? "+" : ""}${Math.round(v.composite)}, confidence ${v.confidence.toFixed(2)})`;

  const trades: RebalanceTrade[] = [];
  const unrated: RebalancePlan["unrated"] = [];

  // Pass 1: sells, trims and the wanted size of adds on held names.
  type Want = { ticker: string; label?: string | null; action: "add" | "buy"; from: number; want: number; price: number | null; reason: string; rank: number };
  const wants: Want[] = [];
  const held = new Set<string>();
  let listedNames = 0;
  let sellProceeds = 0;

  for (const h of input.holdings) {
    held.add(h.ticker);
    const mv = Math.max(0, h.marketValue);
    if (h.isFund) {
      unrated.push({ ticker: h.ticker, label: h.label, reason: "fund · no quant coverage" });
      continue;
    }
    listedNames++;
    const v = fresh.get(h.ticker);
    const price = h.qty > 0 && mv > 0 ? mv / h.qty : priceFor(v);

    let target = mv;
    let reason: string;
    if (!v) {
      reason = `over the ${capPct}% name cap`;
      unrated.push({ ticker: h.ticker, label: h.label, reason: "no quant verdict in the last week" });
    } else if (v.direction === "short") {
      target = mv / 2;
      reason = `${describe(v)}: trim by half`;
    } else if (v.direction === "long") {
      target = Math.max(mv, cap * v.confidence);
      reason = `${describe(v)}: size toward ${pct(w(cap * v.confidence))}`;
    } else {
      reason = `over the ${capPct}% name cap`;
    }
    if (target > cap) {
      target = cap;
      if (v?.direction !== "short") reason = `${v ? describe(v) + " · " : ""}over the ${capPct}% name cap`;
      else reason += `, then down to the ${capPct}% name cap`;
    }

    if (target < mv) {
      let value = mv - target;
      let shares: number | null = null;
      if (price) {
        shares = Math.min(h.qty, roundShares(value / price));
        value = shares * price;
      }
      if (value < minTrade * capital || shares === 0) continue;
      sellProceeds += value;
      trades.push({
        ticker: h.ticker, label: h.label, action: "trim",
        value, shares, price, fromWeight: w(mv), toWeight: w(mv - value), reason,
      });
    } else if (target > mv) {
      wants.push({ ticker: h.ticker, label: h.label, action: "add", from: mv, want: target - mv, price, reason, rank: v ? v.composite * v.confidence : 0 });
    }
  }

  // Pass 2: new names, one per open slot, strongest first.
  const openSlots = Math.max(0, input.maxNames - listedNames);
  const candidates = [...fresh.values()]
    .filter((v) => v.direction === "long" && !held.has(v.ticker))
    .sort((a, b) => b.composite * b.confidence - a.composite * a.confidence);
  let longsBlocked = 0;
  let unpriced = 0;
  let slots = openSlots;
  for (const v of candidates) {
    const price = priceFor(v);
    if (!price) { unpriced++; continue; }
    if (slots === 0) { longsBlocked++; continue; }
    slots--;
    wants.push({
      ticker: v.ticker, action: "buy", from: 0, want: Math.min(cap, cap * v.confidence), price,
      reason: `${describe(v)}: new position at ${pct(w(Math.min(cap, cap * v.confidence)))}`,
      rank: v.composite * v.confidence,
    });
  }
  if (unpriced) notes.push(`${unpriced} unheld long${unpriced === 1 ? "" : "s"} skipped: no ${input.currency} price on the verdict.`);
  if (longsBlocked) {
    notes.push(
      `${longsBlocked} unheld long${longsBlocked === 1 ? "" : "s"} left out: the book holds ${listedNames} listed names against a ${input.maxNames}-name limit.`,
    );
  }

  // Pass 3: fund the buys from cash plus proceeds, scaled down if they'd overspend.
  const budget = cash + sellProceeds;
  const wanted = wants.reduce((s, x) => s + x.want, 0);
  const scale = wanted > budget ? budget / wanted : 1;
  if (scale < 1) notes.push(`Buys scaled to ${Math.round(scale * 100)}% of their target size to stay within cash.`);

  let buyCost = 0;
  for (const x of wants.sort((a, b) => b.rank - a.rank)) {
    let value = Math.min(x.want * scale, budget - buyCost);
    let shares: number | null = null;
    if (x.price) {
      shares = roundShares(value / x.price);
      value = shares * x.price;
    }
    if (value < minTrade * capital || shares === 0) continue;
    buyCost += value;
    trades.push({
      ticker: x.ticker, label: x.label, action: x.action, value, shares, price: x.price,
      fromWeight: w(x.from), toWeight: w(x.from + value), reason: x.reason,
    });
  }

  const order: Record<RebalanceAction, number> = { trim: 0, add: 1, buy: 2 };
  trades.sort((a, b) => order[a.action] - order[b.action] || b.value - a.value);

  return {
    capital, trades, unrated, sellProceeds, buyCost, cashAfter: cash + sellProceeds - buyCost,
    listedNames, openSlots, longsBlocked, notes,
  };
}

/** The verdict an ensemble-combiner report carries, or null when it carries none. */
export function verdictOf(r: QuantReport): Verdict | null {
  let data: Record<string, unknown> = {};
  try {
    const p: unknown = r.payload_json ? JSON.parse(r.payload_json) : null;
    const d = p && typeof p === "object" ? (p as { data?: unknown }).data : null;
    if (d && typeof d === "object") data = d as Record<string, unknown>;
  } catch {
    // fall through to the row's own score
  }
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);
  const composite = num(data.composite) ?? r.score;
  if (composite == null) return null;
  const dir = data.direction;
  return {
    ticker: r.ticker,
    direction: dir === "long" || dir === "short" ? dir : "neutral",
    composite,
    confidence: Math.min(1, Math.max(0, num(data.confidence) ?? 0)),
    price: num(data.price),
    currency: typeof data.currency === "string" ? data.currency : null,
    runAt: r.run_at,
  };
}
