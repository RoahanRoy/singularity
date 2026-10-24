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
 *  - Each name's cap is the desk's one-name risk limit (risk-budget.ts): the
 *    weight at which its own active risk, weight × active vol, uses the whole
 *    target tracking error — target ÷ active vol, the vol measured by the
 *    latest risk report. A listed name over its cap is trimmed whatever the
 *    verdict. A name with no measured active vol has no cap: held, it is left
 *    as it is (a short still trims); unheld, it isn't bought.
 *  - New buys come from the strongest unheld longs (composite × confidence),
 *    each sized at its cap × confidence.
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
  /** The desk's target tracking error (annual fraction) from its risk budget. */
  targetTe: number;
  /** Measured annual active vol (return less the index's) by ticker. */
  activeVol: Record<string, number>;
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
  notes: string[];
};

const DAY_MS = 86_400_000;

/** How strongly a verdict points long: composite × confidence. Buys and ideas rank by it. */
export const edgeOf = (v: Pick<Verdict, "composite" | "confidence">) => v.composite * v.confidence;

/** The newest verdict per ticker among those run within `maxAgeMs` of `now`. */
export function freshVerdicts(verdicts: readonly Verdict[], now: number, maxAgeMs: number): Map<string, Verdict> {
  const fresh = new Map<string, Verdict>();
  for (const v of verdicts) {
    const t = Date.parse(v.runAt);
    if (!Number.isFinite(t) || now - t > maxAgeMs) continue;
    const prev = fresh.get(v.ticker);
    if (!prev || Date.parse(prev.runAt) < t) fresh.set(v.ticker, v);
  }
  return fresh;
}

export function planRebalance(input: RebalanceInput): RebalancePlan {
  const now = input.now ?? Date.now();
  const minTrade = (input.minTradePct ?? 0.5) / 100;
  const notes: string[] = [];

  const fresh = freshVerdicts(input.verdicts, now, (input.maxAgeDays ?? 7) * DAY_MS);

  const bookValue = input.holdings.reduce((s, h) => s + Math.max(0, h.marketValue), 0);
  const cash = Math.max(0, input.cash);
  const capital = bookValue + cash;
  const empty: RebalancePlan = {
    capital, trades: [], unrated: [], sellProceeds: 0, buyCost: 0, cashAfter: cash, notes,
  };
  if (capital <= 0 || !(input.targetTe > 0)) return empty;

  const w = (x: number) => x / capital;
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  // The name's cap in currency and how it was derived; null without a measured active vol.
  const capOf = (ticker: string) => {
    const av = input.activeVol[ticker];
    if (!(av > 0)) return null;
    const weight = Math.min(1, input.targetTe / av);
    return { value: weight * capital, text: `the ${pct(weight)} name cap (${pct(input.targetTe)} target ÷ ${pct(av)} active vol)` };
  };
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
  let sellProceeds = 0;
  let uncapped = 0;

  for (const h of input.holdings) {
    held.add(h.ticker);
    const mv = Math.max(0, h.marketValue);
    if (h.isFund) {
      unrated.push({ ticker: h.ticker, label: h.label, reason: "fund · no quant coverage" });
      continue;
    }
    const v = fresh.get(h.ticker);
    const price = h.qty > 0 && mv > 0 ? mv / h.qty : priceFor(v);
    const cap = capOf(h.ticker);
    if (!cap) uncapped++;

    let target = mv;
    let reason = cap ? `over ${cap.text}` : "";
    if (!v) {
      unrated.push({ ticker: h.ticker, label: h.label, reason: "no quant verdict in the last week" });
    } else if (v.direction === "short") {
      target = mv / 2;
      reason = `${describe(v)}: trim by half`;
    } else if (v.direction === "long") {
      if (!cap) {
        unrated.push({ ticker: h.ticker, label: h.label, reason: `${describe(v)} · no measured active vol to size against` });
        continue;
      }
      target = Math.max(mv, cap.value * v.confidence);
      reason = `${describe(v)}: size toward ${pct(w(cap.value * v.confidence))}`;
    }
    if (cap && target > cap.value) {
      target = cap.value;
      if (v?.direction !== "short") reason = `${v ? describe(v) + " · " : ""}over ${cap.text}`;
      else reason += `, then down to ${cap.text}`;
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
      wants.push({ ticker: h.ticker, label: h.label, action: "add", from: mv, want: target - mv, price, reason, rank: v ? edgeOf(v) : 0 });
    }
  }

  if (uncapped) {
    notes.push(`${uncapped} held name${uncapped === 1 ? " has" : "s have"} no measured active vol: no cap is checked on ${uncapped === 1 ? "it" : "them"}.`);
  }

  // Pass 2: new names, strongest first.
  const candidates = [...fresh.values()]
    .filter((v) => v.direction === "long" && !held.has(v.ticker))
    .sort((a, b) => edgeOf(b) - edgeOf(a));
  let unpriced = 0;
  let unmeasured = 0;
  for (const v of candidates) {
    const price = priceFor(v);
    if (!price) { unpriced++; continue; }
    const cap = capOf(v.ticker);
    if (!cap) { unmeasured++; continue; }
    wants.push({
      ticker: v.ticker, action: "buy", from: 0, want: cap.value * v.confidence, price,
      reason: `${describe(v)}: new position at ${pct(w(cap.value * v.confidence))}, under ${cap.text}`,
      rank: edgeOf(v),
    });
  }
  if (unpriced) notes.push(`${unpriced} unheld long${unpriced === 1 ? "" : "s"} skipped: no ${input.currency} price on the verdict.`);
  if (unmeasured) notes.push(`${unmeasured} unheld long${unmeasured === 1 ? "" : "s"} skipped: no measured active vol to size against.`);

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
    capital, trades, unrated, sellProceeds, buyCost, cashAfter: cash + sellProceeds - buyCost, notes,
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
