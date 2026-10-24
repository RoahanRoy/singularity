/**
 * A book's construction plan: what construct.ts sizes, from what the desk
 * measured, and the trades that get there.
 *
 *  - The core is the desk index's ETF, α 0, free between 0 and all of NAV: it
 *    holds the index exposure cash would otherwise forgo, and it is what new
 *    names are funded from.
 *  - A name's α is the ensemble's confidence × the valuation blend's upside
 *    from its fresh sweep verdict. A name the plan may open is one of the
 *    desk's ranked ideas (ideas.ts: a long verdict, upside ≥ 0). A held name
 *    may be added to on the same terms; it can be trimmed only on a book
 *    that sells names (the advisory book; the fund's paper broker buys names
 *    and sells only the core).
 *  - Each name is capped at the desk's one-name limit, target TE ÷ its active
 *    vol (risk-budget.ts). On a book that sells, a name over it is trimmed.
 *  - Held names without a fresh view, or without a valuation blend, stay as
 *    they are. Held names without a full window of history stay too and,
 *    as in the risk report, count as cash in TE: their returns aren't known.
 *  - Shares round down (whole shares where the book trades them), so a trade
 *    never overshoots its planned weight.
 *
 * Pure. Loading the inputs and storing the plan is scripts/agents/construct.ts.
 */
import { construct, type Construction } from "./construct";
import type { Direction } from "./rebalance";
import { onCalendar, rets } from "../quant/portfolio-risk";
import { std } from "../quant/stats";
import { TRADING_DAYS } from "../quant/risk";
import type { Bar } from "../quant/types";

export type PlanBook = "fund" | "advisory";

export type View = { direction: Direction; composite: number; confidence: number; upsidePct: number | null };

/** `value`: the holding at its mark (0 for an idea); `price`: what it trades at now, null without a live quote. */
export type PlanName = { ticker: string; label?: string | null; qty: number; value: number; price: number | null; bars: readonly Bar[] };

export type PlanInput = {
  book: PlanBook;
  nav: number;
  /** Names held, the core among them when it is. */
  holdings: readonly PlanName[];
  /** Unheld names the plan may open (the desk's ranked ideas), qty 0. */
  ideas: readonly PlanName[];
  /** Fresh views by upper-case ticker. */
  views: ReadonlyMap<string, View>;
  /** The index ETF, with its live price. */
  core: { ticker: string; price: number | null; bars: readonly Bar[] };
  index: readonly Bar[];
  /** Daily returns in the window (the risk report's). */
  window: number;
  targetTe: number;
  /** Round shares to whole numbers (the fund's broker, Indian exchanges). */
  wholeShares: boolean;
  /** Whether the book sells names, or only the core. */
  sellsNames: boolean;
};

export type PlanLine = {
  ticker: string;
  label?: string | null;
  role: "core" | "name";
  from: number;
  /** Planned weight, before share rounding. */
  to: number;
  /** Weight after the rounded trade. */
  toRounded: number;
  alpha: number;
  marginalTe: number;
  cap: number | null;
  activeVol: number | null;
  /** Shares to trade: + buy, − sell. */
  shares: number;
  price: number;
  /** Trade value, signed like `shares`. */
  value: number;
  why: string;
};

export type Plan = {
  book: PlanBook;
  nav: number;
  targetTe: number;
  binding: Construction["binding"];
  /** Planned TE and α, before share rounding. */
  te: number;
  alpha: number;
  lines: PlanLine[];
  /** Held names the plan leaves as they are, with why. */
  fixed: { ticker: string; label?: string | null; weight: number; reason: string }[];
  /** Ideas and the core left out, with why. */
  skipped: { ticker: string; reason: string }[];
  /** Holdings after the trades, at their marks plus the trades' value. */
  after: { ticker: string; qty: number; value: number }[];
};

const pct = (x: number, d = 1) => `${(x * 100).toFixed(d)}%`;

export function planBook(input: PlanInput): { plan: Plan } | { skip: string } {
  const { nav, targetTe, window } = input;
  if (!(nav > 0)) return { skip: `NAV ${nav}` };
  if (input.index.length < window + 1) return { skip: `under ${window + 1} index sessions` };
  const dates = input.index.slice(-(window + 1)).map((b) => b.date);
  const idx = rets(input.index.slice(-(window + 1)).map((b) => b.adjClose));
  const zeros = idx.map(() => 0);
  const measured = (bars: readonly Bar[]) => {
    const cal = onCalendar(bars, dates);
    if (!cal) return null;
    const r = rets(cal.closes);
    return { r, activeVol: std(r.map((x, t) => x - idx[t])) * Math.sqrt(TRADING_DAYS) };
  };
  const capOf = (av: number) => (av > 0 ? Math.min(1, targetTe / av) : 1);
  const coreTicker = input.core.ticker.toUpperCase();

  type Slot = {
    ticker: string; label?: string | null; role: "core" | "name"; qty: number; price: number; value: number;
    from: number; lo: number; hi: number; alpha: number; r: number[]; activeVol: number | null; cap: number | null; why: string;
  };
  const slots: Slot[] = [];
  const fixed: Plan["fixed"] = [];
  const skipped: Plan["skipped"] = [];
  const fix = (h: PlanName, w: number, reason: string, r: number[]) => {
    fixed.push({ ticker: h.ticker, label: h.label, weight: w, reason });
    slots.push({ ticker: h.ticker, label: h.label, role: "name", qty: h.qty, price: h.price ?? 0, value: h.value, from: w, lo: w, hi: w, alpha: 0, r, activeVol: null, cap: null, why: reason });
  };

  let coreHeld: PlanName | null = null;
  for (const h of input.holdings) {
    const t = h.ticker.toUpperCase();
    if (t === coreTicker) { coreHeld = h; continue; }
    const w = h.value / nav;
    const m = measured(h.bars);
    if (!m) { fix(h, w, "no full window of history: unmeasured, counted as cash in TE", zeros); continue; }
    if (!(h.price != null && h.price > 0)) { fix(h, w, "no live quote to trade at", m.r); continue; }
    const v = input.views.get(t);
    if (!v) { fix(h, w, "no fresh quant view", m.r); continue; }
    if (v.upsidePct == null) { fix(h, w, `quant ${v.direction}, no valuation blend`, m.r); continue; }
    const cap = capOf(m.activeVol);
    const buyable = v.direction === "long" && v.upsidePct >= 0;
    const lo = input.sellsNames ? 0 : w;
    const hi = input.sellsNames ? (buyable ? cap : Math.min(w, cap)) : buyable ? Math.max(w, cap) : w;
    if (!(hi > lo)) {
      fix(h, w, buyable ? `at its one-name cap ${pct(cap)}, and the book doesn't sell names` : `quant ${v.direction}, upside ${v.upsidePct.toFixed(1)}%: not a buy, and the book doesn't sell names`, m.r);
      continue;
    }
    slots.push({
      ticker: t, label: h.label, role: "name", qty: h.qty, price: h.price, value: h.value, from: w, lo, hi,
      alpha: (v.confidence * v.upsidePct) / 100, r: m.r, activeVol: m.activeVol, cap,
      why: `quant ${v.direction} ${v.composite >= 0 ? "+" : ""}${Math.round(v.composite)}, confidence ${v.confidence.toFixed(2)} × upside ${v.upsidePct.toFixed(1)}%`,
    });
  }

  const held = new Set(slots.map((s) => s.ticker.toUpperCase()));
  for (const i of input.ideas) {
    const t = i.ticker.toUpperCase();
    if (held.has(t) || t === coreTicker) continue;
    const v = input.views.get(t);
    if (!v || v.upsidePct == null || v.direction !== "long" || v.upsidePct < 0) { skipped.push({ ticker: t, reason: "not a long with valuation upside" }); continue; }
    if (!(i.price != null && i.price > 0)) { skipped.push({ ticker: t, reason: "no live quote" }); continue; }
    const m = measured(i.bars);
    if (!m) { skipped.push({ ticker: t, reason: "no full window of history" }); continue; }
    const cap = capOf(m.activeVol);
    slots.push({
      ticker: t, label: i.label, role: "name", qty: 0, price: i.price, value: 0, from: 0, lo: 0, hi: cap,
      alpha: (v.confidence * v.upsidePct) / 100, r: m.r, activeVol: m.activeVol, cap,
      why: `idea: quant long +${Math.round(v.composite)}, confidence ${v.confidence.toFixed(2)} × upside ${v.upsidePct.toFixed(1)}%`,
    });
  }

  const corePrice = input.core.price;
  const coreM = measured(input.core.bars);
  const coreFrom = coreHeld ? coreHeld.value / nav : 0;
  if (!(corePrice != null && corePrice > 0) || !coreM) {
    const reason = !coreM ? "no full window of history" : "no live quote";
    skipped.push({ ticker: coreTicker, reason });
    if (coreHeld) fix(coreHeld, coreFrom, `index core, ${reason}`, coreM?.r ?? zeros);
  } else {
    slots.push({
      ticker: coreTicker, role: "core", qty: coreHeld?.qty ?? 0, price: corePrice, value: coreHeld?.value ?? 0, from: coreFrom, lo: 0, hi: 1,
      alpha: 0, r: coreM.r, activeVol: coreM.activeVol, cap: null, why: "index core: the book's index exposure, and its funding",
    });
  }

  // Nothing to size: the book stays in cash and trails the index by its vol.
  if (!slots.length) {
    const te = std(idx) * Math.sqrt(TRADING_DAYS);
    return { plan: { book: input.book, nav, targetTe, binding: te > targetTe ? "floor" : "bounds", te, alpha: 0, lines: [], fixed, skipped, after: [] } };
  }
  const c = construct({
    assets: slots.map((s) => ({ ticker: s.ticker, alpha: s.alpha, lo: s.lo, hi: s.hi, returns: s.r })),
    index: idx,
    targetTe,
  });
  if (!c) return { skip: "the held weights alone exceed NAV" };

  const round = (x: number) => (input.wholeShares ? Math.floor(x) : Math.floor(x * 100) / 100);
  const lines: PlanLine[] = [];
  const after: Plan["after"] = [];
  slots.forEach((s, i) => {
    const to = c.weights[i];
    const free = s.hi > s.lo;
    let shares = 0;
    if (free && s.price > 0) {
      const raw = ((to - s.from) * nav) / s.price;
      shares = raw >= 0 ? round(raw) : -Math.min(s.qty, round(-raw));
    }
    const qty = s.qty + shares;
    const value = s.value + shares * s.price;
    if (qty > 0) after.push({ ticker: s.ticker, qty, value });
    if (!free) return;
    const capText = s.cap != null && s.activeVol != null ? ` · cap ${pct(s.cap)} (${pct(targetTe)} ÷ ${pct(s.activeVol)} active vol)` : "";
    lines.push({
      ticker: s.ticker, label: s.label, role: s.role, from: s.from, to, toRounded: value / nav,
      alpha: s.alpha, marginalTe: c.marginalTe[i], cap: s.cap, activeVol: s.activeVol,
      shares, price: s.price, value: shares * s.price,
      why: `${s.why}${s.role === "name" ? ` → α ${pct(s.alpha, 2)} vs marginal TE ${c.marginalTe[i].toFixed(2)}` : ""}${capText}`,
    });
  });
  lines.sort((a, b) => (a.role === "core" ? -1 : b.role === "core" ? 1 : b.to - a.to || a.ticker.localeCompare(b.ticker)));

  return {
    plan: { book: input.book, nav, targetTe, binding: c.binding, te: c.te, alpha: c.alpha, lines, fixed, skipped, after },
  };
}
