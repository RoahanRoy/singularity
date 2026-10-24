/**
 * The desk's construction plan for a book (src/lib/fund/plan.ts): the weights
 * that buy the most expected excess return its tracking-error budget allows,
 * the trades that get there, and the book's risk before and after — written to
 * `construction_plans`, one row per desk, book and exchange session (later
 * runs that session update it).
 *
 * Inputs:
 *   budget    the operator's target TE (risk-budget.ts); none, no plan.
 *   fund      fund-book.ts at live marks; NAV = mandate cash + positions.
 *             Buys names, and sells only the core.
 *   advisory  advisory_positions at their last sync marks; NAV = their value
 *             (the operator's cash isn't on file). Advice: names may be trimmed.
 *   views     fresh ensemble verdicts (ideas.ts's freshness window) with the
 *             valuation blend's upside.
 *   ideas     the desk's ranked ideas (src/lib/fund/ideas.ts) not on this book.
 *   core      the desk index's ETF (DESK_INDEX[market].etf) at a live quote.
 * Daily history comes from market-data.ts over the risk report's one-year
 * window, and before/after are the risk report's own measure.
 */
import { db, DB, ID, Query, type Market } from "./appwrite";
import { markFundBook } from "./fund-book";
import { getQuoteDetail } from "./quotes";
import { exchangeDate } from "./market-hours";
import { loadBudget } from "./risk-budget";
import { freshReports } from "./ideas";
import { measure, withHistory } from "./portfolio-risk";
import { STORED_MAX_AGE_H } from "./quant-nodes";
import { FULL_UNIVERSE, INDIA_UNIVERSE } from "./universe";
import { DESK_INDEX } from "../../src/lib/market/indices";
import { TRADING_DAYS } from "../../src/lib/quant/risk";
import { rankIdeas, upsideOf } from "../../src/lib/fund/ideas";
import { freshVerdicts, verdictOf } from "../../src/lib/fund/rebalance";
import { planBook, type Plan, type PlanBook, type PlanName, type View } from "../../src/lib/fund/plan";
import type { PortfolioRisk } from "../../src/lib/quant/portfolio-risk";

const QUOTE_CONCURRENCY = 8;
const PLAN_JSON_MAX = 65_535;

async function mapPool<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

type Held = Omit<PlanName, "bars">;

async function heldOf(market: Market, book: PlanBook, now: Date): Promise<{ nav: number; held: Held[]; marks: string } | { skip: string }> {
  if (book === "fund") {
    const b = await markFundBook(market, now);
    if (!b.mandate) return { skip: `no ${market} fund mandate` };
    return {
      nav: b.equity,
      held: b.names.filter((n) => n.qty > 0).map((n) => ({ ticker: n.ticker.toUpperCase(), qty: n.qty, value: n.mv, price: n.price })),
      marks: b.unpriced_pct > 0 ? `live quotes (${b.unpriced_pct}% at a stored mark)` : "live quotes",
    };
  }
  const res = await db.listDocuments(DB, "advisory_positions", [Query.equal("market", market), Query.limit(500)]);
  const rows = (res.documents as unknown as { ticker: string; qty: number; market_value: number }[]).filter((p) => p.qty > 0 && p.market_value > 0);
  if (!rows.length) return { skip: `no ${market} advisory holdings` };
  return {
    nav: rows.reduce((s, p) => s + p.market_value, 0),
    held: rows.map((p) => ({ ticker: p.ticker.toUpperCase(), qty: p.qty, value: p.market_value, price: p.market_value / p.qty })),
    marks: "last holdings sync",
  };
}

export type BuiltPlan = {
  market: Market;
  book: PlanBook;
  session: string;
  marks: string;
  index: string;
  core: string;
  plan: Plan;
  before: PortfolioRisk;
  after: PortfolioRisk;
};

export type PlanRun = { status: "planned"; built: BuiltPlan } | { status: "skipped"; market: Market; book: PlanBook; reason: string };

/** The book's plan and its risk before and after, unstored. */
export async function buildPlan(market: Market, book: PlanBook, now: Date = new Date()): Promise<PlanRun> {
  const skip = (reason: string): PlanRun => ({ status: "skipped", market, book, reason });
  const budget = await loadBudget(market);
  if (!budget) return skip(`no ${market} risk budget set (scripts/set-risk-budget.ts)`);
  if (!(STORED_MAX_AGE_H > 0)) return skip("stored sweep verdicts are off (MERIDIAN_QUANT_STORED_MAX_AGE_H)");
  const inputs = await heldOf(market, book, now);
  if ("skip" in inputs) return skip(inputs.skip);

  const views = new Map<string, View>();
  const verdicts = (await freshReports(market, now)).flatMap((r) => {
    const v = verdictOf(r);
    if (!v) return [];
    let data: unknown = null;
    try { data = r.payload_json ? (JSON.parse(r.payload_json) as { data?: unknown }).data : null; } catch { /* no upside */ }
    return [{ ...v, ticker: v.ticker.toUpperCase(), upsidePct: upsideOf(data) }];
  });
  const maxAgeMs = STORED_MAX_AGE_H * 3_600_000;
  for (const [t, v] of freshVerdicts(verdicts, now.getTime(), maxAgeMs)) {
    const upsidePct = (v as (typeof verdicts)[number]).upsidePct;
    views.set(t, { direction: v.direction, composite: v.composite, confidence: v.confidence, upsidePct });
  }

  const coreTicker = DESK_INDEX[market].etf;
  const universe = market === "IN" ? INDIA_UNIVERSE : FULL_UNIVERSE;
  // This book's holdings only: the fund and the advisory book are sized apart.
  const { ideas } = rankIdeas({
    verdicts, universe, held: [...inputs.held.map((h) => h.ticker), coreTicker],
    now: now.getTime(), maxAgeMs,
  });
  const ideaQuotes = await mapPool(ideas, QUOTE_CONCURRENCY, (i) => getQuoteDetail(i.ticker, market));
  const coreQuote = await getQuoteDetail(coreTicker, market);
  const heldCore = inputs.held.find((h) => h.ticker === coreTicker);

  const names = [
    ...inputs.held,
    ...ideas.map((i, k) => ({ ticker: i.ticker, qty: 0, value: 0, price: ideaQuotes[k]?.price ?? null })),
    ...(heldCore ? [] : [{ ticker: coreTicker, qty: 0, value: 0, price: coreQuote?.price ?? null }]),
  ];
  const hist = await withHistory(market, names.map((n) => ({ ticker: n.ticker, qty: n.qty, price: n.price ?? 0 })));
  if (!hist) return skip(`no ${DESK_INDEX[market].symbol} history`);
  const bars = new Map(hist.holdings.map((h) => [h.ticker, h.bars]));
  const withBars = (n: Held): PlanName => ({ ...n, bars: bars.get(n.ticker) ?? [] });

  const built = planBook({
    book, nav: inputs.nav,
    holdings: inputs.held.map(withBars),
    ideas: names.slice(inputs.held.length, inputs.held.length + ideas.length).map(withBars),
    views,
    core: { ticker: coreTicker, price: coreQuote?.price ?? null, bars: bars.get(coreTicker) ?? [] },
    index: hist.index, window: TRADING_DAYS, targetTe: budget.target_te,
    wholeShares: book === "fund" || market === "IN",
    sellsNames: book === "advisory",
  });
  if ("skip" in built) return skip(built.skip);
  const { plan } = built;

  const atMarks = (hs: readonly { ticker: string; qty: number; value: number }[]) =>
    hs.filter((h) => h.qty > 0).map((h) => ({ ticker: h.ticker, qty: h.qty, price: h.value / h.qty, bars: bars.get(h.ticker) ?? [] }));
  const before = measure(inputs.nav, atMarks(inputs.held), hist.index);
  const after = measure(inputs.nav, atMarks(plan.after), hist.index);
  if (!before || !after) return skip(`under ${TRADING_DAYS + 1} ${DESK_INDEX[market].symbol} sessions`);
  return {
    status: "planned",
    built: { market, book, session: exchangeDate(market, now), marks: inputs.marks, index: DESK_INDEX[market].name, core: coreTicker, plan, before, after },
  };
}

const r6 = (x: number) => (Number.isFinite(x) ? Number(x.toFixed(6)) : null);
const compact = (x: unknown): unknown => JSON.parse(JSON.stringify(x, (_k, v) => (typeof v === "number" ? r6(v) : v)));

/** The stored plan_json: the plan, the before/after headline risk, where the marks came from. */
export function planJson(b: BuiltPlan): string {
  const risk = (r: PortfolioRisk) => ({
    tracking_error: r.tracking_error, beta: r.beta, var95: r.var95.parametric, vol_annual: r.vol_annual,
    unmeasured_weight: r.unmeasured_weight,
  });
  const body = { marks: b.marks, index: b.index, core: b.core, before: risk(b.before), after: risk(b.after) };
  let json = JSON.stringify(compact({ ...b.plan, ...body }));
  if (json.length > PLAN_JSON_MAX) {
    // The skipped ideas' reasons are the first thing to give; the trades stay.
    json = JSON.stringify(compact({ ...b.plan, skipped: [], skipped_count: b.plan.skipped.length, ...body }));
    if (json.length > PLAN_JSON_MAX) throw new Error(`construction plan is ${json.length} chars, over ${PLAN_JSON_MAX}`);
  }
  return json;
}

export async function reportPlan(market: Market, book: PlanBook, now: Date = new Date()): Promise<PlanRun> {
  const run = await buildPlan(market, book, now);
  if (run.status !== "planned") return run;
  const b = run.built;
  const row = {
    market,
    book,
    session: b.session,
    captured_at: now.toISOString(),
    nav: Number(b.plan.nav.toFixed(2)),
    target_te: r6(b.plan.targetTe),
    binding: b.plan.binding,
    te_before: r6(b.before.tracking_error),
    te_after: r6(b.after.tracking_error),
    beta_before: r6(b.before.beta),
    beta_after: r6(b.after.beta),
    var95_before: r6(b.before.var95.parametric),
    var95_after: r6(b.after.var95.parametric),
    alpha: r6(b.plan.alpha),
    plan_json: planJson(b),
  };
  const prior = await db.listDocuments(DB, "construction_plans", [
    Query.equal("market", market),
    Query.equal("book", book),
    Query.orderDesc("captured_at"),
    Query.limit(1),
  ]);
  const latest = prior.documents[0] as unknown as { $id: string; session: string } | undefined;
  if (latest?.session === b.session) await db.updateDocument(DB, "construction_plans", latest.$id, row);
  else await db.createDocument(DB, "construction_plans", ID.unique(), row);
  return run;
}
