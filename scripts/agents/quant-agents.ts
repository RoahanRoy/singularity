/**
 * Quant agents: one agent per method in the desk's quant workflow.
 *
 *   1. Screen with ratios and scores        fundamentals-screener, forensic-accountant, risk-metrics-analyst
 *   2. Value with DCF and multiples         dcf-modeler, ddm-modeler, residual-income-modeler, multiples-analyst
 *   3. Check moat, management, the rest     the qualitative LLM agents + sentiment and earnings-call scorers
 *   4. Model risk (Monte Carlo, GARCH, …)   time-series and stochastic agents
 *   5. Time entry (momentum, technicals)    technical-analyst, momentum-analyst
 *   6. Backtest properly                    backtest-auditor (walk-forward, after costs)
 *   + factor models, machine learning, and an evidence-weighted ensemble.
 *
 * Trust tier: compute. No LLM and no Appwrite in this file. `loadBundle` is
 * its only I/O and goes through market-data.ts (pure HTTP). Every agent is a
 * pure function of the bundle and the results of agents that ran before it,
 * so quant-nodes.ts can narrate, persist and wire them, and the dry run can
 * exercise them, without credentials.
 *
 * Do not import universe.ts or appwrite.ts here: appwrite.ts throws at import
 * without env vars. Callers pass the peer tickers in.
 *
 * Vendor text (business summaries, headlines, officer names, filing excerpts)
 * stays untrusted data: `qualitativeFacts` hands it to the LLM agents in a
 * separate field so their prompts can fence it off from the computed facts.
 */
import * as md from "./market-data";
import { getQuoteDetail } from "./quotes";
import type { Bar, Fundamentals, Market, PriceHistory, Sourced } from "../../src/lib/quant/types";
import { clamp, isNum, logReturns, mean, median, rnd, seedFrom, std } from "../../src/lib/quant/stats";
import { alignOnDates, closeOnOrBefore } from "../../src/lib/quant/series";
import { forensic, growth, ratioHistory, screen, type ScreenResult } from "../../src/lib/quant/fundamentals";
import { riskReport, type RiskReport } from "../../src/lib/quant/risk";
import {
  blendValuation, computeMultiples, costOfCapital, dcfModel, ddmModel, marketAssumptions, historicalMultiples,
  growthHint, relativeModel, residualIncomeModel, revenueCagr, snapshot,
  type BlendResult, type ChosenAssumptions, type CompanySnapshot, type CostOfCapital, type ModelValue, type Multiples, type RelativeRow, type ValuationAssumptions,
} from "../../src/lib/quant/valuation";
import { arimaReport, garchReport, kalmanTrendReport, markovSwitching, pairsScan, smoothingReport, type GarchReport, type OosScore, type RegimeReport } from "../../src/lib/quant/timeseries";
import { fitMerton, impliedVolProxy, impliedVolSummary, monteCarloReport, ouSeriesReport, residualLevel, volRiskPremium, type OuSeriesReport } from "../../src/lib/quant/stochastic";
import {
  capmReport, fitFactorModels, fitMacroFactors, IN_FACTOR_MODELS, preferredModel, styleTilts, US_FACTOR_MODELS,
  type FactorFit, type MacroFit, type MacroInput,
} from "../../src/lib/quant/factors";
import { momentum, momentumScore, technicalSnapshot } from "../../src/lib/quant/technicals";
import {
  callTone, earningsDelivery, insiderScore, newsTone, revisionsScore, sentimentComposite, shortInterestScore, type Headline,
} from "../../src/lib/quant/sentiment";
import { buildFeatures, poolFeatures, type FeatureSet } from "../../src/lib/quant/features";
import { LINEAR_LEARNERS, mlReport, TREE_LEARNERS, type MlReport, type ModelReport } from "../../src/lib/quant/ml";
import { sequenceModelReport } from "../../src/lib/quant/nn";
import { rlReport } from "../../src/lib/quant/rl";
import { backtestReport, type BacktestReport, type Family } from "../../src/lib/quant/backtest";
import { combine, upsideScore, VALUATION_AGENTS, type EnsembleInput, type EnsembleResult, type Evidence } from "../../src/lib/quant/ensemble";

// ── Roster (src/lib/quant/roster.ts, shared with the website) ───────────────

import { QUANT_AGENTS, type AgentSpec } from "../../src/lib/quant/roster";
export { STAGES, QUANT_AGENTS, QUANT_AGENT, LLM_AGENT_SLUGS, type AgentSpec, type Stage } from "../../src/lib/quant/roster";

// ── Bundle: everything the agents read, fetched once per cycle ──────────────

export type PeerData = { ticker: string; symbol: string; history: PriceHistory | null; fundamentals: Fundamentals | null; fx: Sourced | null };

/** A macro reading for the strategist; `value` in percent units. */
export type MacroContextItem = { name: string; value: number | null; asOf: string | null; source: string };

export type QuantBundle = {
  ticker: string;
  market: Market;
  symbol: string;
  sector: string;
  /** Lender or insurer: DCF and EV multiples don't apply, residual income leads. */
  financial: boolean;
  /** Date of the newest daily bar. */
  asOf: string | null;
  fetchedAt: string;
  price: Sourced | null;
  history: PriceHistory | null;
  intraday: Bar[];
  fundamentals: Fundamentals | null;
  /**
   * Reporting → listing currency. Null when they differ and no rate loaded
   * (valuation then skips); 1 flagged `assumption` when a currency is unknown.
   */
  fx: Sourced | null;
  profile: md.CompanyProfile | null;
  news: Headline[];
  options: md.OptionChain | null;
  factors: md.FactorData | null;
  rf: { short: Sourced; long: Sourced };
  index: PriceHistory | null;
  indexSymbol: string;
  indiaVix: PriceHistory | null;
  /** Open-market insider trades: NSE PIT for India, the vendor's 180-day list for the US. */
  insiders: md.Insiders | null;
  /** Every fifth daily bar counted back from the newest (adjusted closes). */
  weekly: { dates: string[]; closes: number[] };
  macro: MacroInput[];
  macroContext: MacroContextItem[];
  peers: PeerData[];
  /** Untrusted filing text from the parser, when the cycle started from a filing. */
  filingExcerpt: string | null;
  coverage: Record<string, string>;
};

export type LoadOpts = { ticker: string; market: Market; sector: string; peers: readonly string[]; filingExcerpt?: string | null };

const INDEX_SYMBOL: Record<Market, string> = { US: "^GSPC", IN: "^NSEI" };
const FINANCIAL_INDUSTRY = /bank|insur|credit services|mortgage|capital markets|financial conglomerate|savings|thrift/i;
const MAX_PEERS = 9;

async function mapLimit<T, R>(xs: readonly T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(xs.length);
  let next = 0;
  const worker = async () => {
    while (next < xs.length) {
      const i = next++;
      out[i] = await fn(xs[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, xs.length) }, worker));
  return out;
}

async function resolveFx(reporting: string | null, listing: string | null): Promise<Sourced | null> {
  if (!reporting || !listing) {
    return { value: 1, source: `${reporting ? "listing" : "reporting"} currency unknown: statements assumed to be in the listing currency`, assumption: true };
  }
  if (reporting.toUpperCase() === listing.toUpperCase()) return { value: 1, source: `statements and listing both in ${listing.toUpperCase()}` };
  return md.fetchFxRate(reporting, listing);
}

async function loadPeers(tickers: readonly string[], target: string, market: Market): Promise<PeerData[]> {
  const list = [...new Set(tickers.map((t) => t.trim().toUpperCase()))].filter((t) => t && t !== target).slice(0, MAX_PEERS);
  return mapLimit(list, 4, async (ticker) => {
    const symbol = md.ySym(ticker, market);
    const [history, fundamentals] = await Promise.all([md.fetchHistory(symbol), md.fetchFundamentals(symbol)]);
    const fx = fundamentals ? await resolveFx(fundamentals.currency, history?.currency ?? null) : null;
    return { ticker, symbol, history, fundamentals, fx };
  });
}

async function loadMacroContext(market: Market, rf: { short: Sourced; long: Sourced }): Promise<MacroContextItem[]> {
  const change = async (id: string, name: string, lag: number): Promise<MacroContextItem> => {
    const pts = await md.fetchFred(id);
    if (!pts || pts.length <= lag) return { name, value: null, asOf: null, source: `FRED ${id} unavailable` };
    const last = pts[pts.length - 1], base = pts[pts.length - 1 - lag].value;
    return { name, value: base > 0 ? (last.value / base - 1) * 100 : null, asOf: last.date, source: `FRED ${id}, change over ${lag} observations` };
  };
  const level = async (id: string, name: string): Promise<MacroContextItem> => {
    const pts = await md.fetchFred(id);
    const last = pts?.[pts.length - 1];
    return last ? { name, value: last.value, asOf: last.date, source: `FRED ${id}` } : { name, value: null, asOf: null, source: `FRED ${id} unavailable` };
  };
  if (market === "US") {
    return Promise.all([
      change("CPIAUCSL", "CPI inflation, % y/y", 12),
      level("A191RL1Q225SBEA", "Real GDP growth, % q/q annualized"),
      level("FEDFUNDS", "Fed funds rate, %"),
    ]);
  }
  const items = await Promise.all([
    change("INDCPIALLMINMEI", "CPI inflation, % y/y", 12),
    level("INDGDPRQPSMEI", "Real GDP growth, % y/y (OECD)"),
  ]);
  items.push({ name: "3-month interbank rate, %", value: rf.short.value * 100, asOf: null, source: rf.short.source });
  return items;
}

/** Fetch everything one ticker's quant agents need. Never throws: gaps show up in `coverage`. */
export async function loadBundle(o: LoadOpts): Promise<QuantBundle> {
  const ticker = o.ticker.trim().toUpperCase();
  const market = o.market;
  const symbol = md.ySym(ticker, market);
  const indexSymbol = INDEX_SYMBOL[market];
  const [history, intraday, fundamentals, profile, quote, rf, index, indiaVix, options, nseInsiders] = await Promise.all([
    md.fetchHistory(symbol),
    md.fetchIntraday(symbol),
    md.fetchFundamentals(symbol),
    md.fetchProfile(symbol),
    getQuoteDetail(ticker, market),
    md.fetchRiskFree(market),
    md.fetchHistory(indexSymbol),
    market === "IN" ? md.fetchHistory("^INDIAVIX") : Promise.resolve(null),
    market === "US" ? md.fetchOptionChain(ticker, market) : Promise.resolve(null),
    market === "IN" ? md.fetchIndiaInsiders(ticker) : Promise.resolve(null),
  ]);

  const bars = history?.bars ?? [];
  const lastBar = bars.length ? bars[bars.length - 1] : null;
  const price: Sourced | null = quote
    ? { value: quote.price, source: `Yahoo quote ${symbol}` }
    : profile && isNum(profile.price) && profile.price > 0
      ? { value: profile.price, source: `Yahoo quoteSummary ${symbol}` }
      : lastBar
        ? { value: lastBar.close, source: `last close ${lastBar.date}` }
        : null;

  const weekly = { dates: [] as string[], closes: [] as number[] };
  for (let i = bars.length - 1; i >= 0; i -= 5) {
    weekly.dates.unshift(bars[i].date);
    weekly.closes.unshift(bars[i].adjClose);
  }

  const reporting = fundamentals?.currency ?? profile?.financialCurrency ?? null;
  const listing = history?.currency ?? profile?.currency ?? null;
  const [news, factors, fx, macro, macroContext, peers] = await Promise.all([
    md.fetchNews(ticker, market, profile?.name ?? null),
    market === "US" ? md.fetchFrenchFactors() : md.fetchIndiaFactors(rf.short.value),
    fundamentals ? resolveFx(reporting, listing) : Promise.resolve(null),
    weekly.dates.length >= 60 ? md.fetchMacroInputs(market, weekly.dates) : Promise.resolve([] as MacroInput[]),
    loadMacroContext(market, rf),
    loadPeers(o.peers, ticker, market),
  ]);

  const industry = profile?.industry ?? null;
  const financial = industry ? FINANCIAL_INDUSTRY.test(industry) : o.sector === "financials";
  const insiders = market === "IN" ? nseInsiders : profile?.insiders ?? null;
  const span = (h: PriceHistory | null) => (h && h.bars.length ? `${h.bars.length} bars ${h.bars[0].date}..${h.bars[h.bars.length - 1].date}` : "missing");
  const coverage: Record<string, string> = {
    price: price ? price.source : "missing",
    history: span(history),
    intraday: intraday?.length ? `${intraday.length} bars` : "missing",
    fundamentals: fundamentals ? `${fundamentals.annual.length} annual, ${fundamentals.quarterly.length} quarterly${fundamentals.ttm ? ", TTM" : ""} (${fundamentals.currency ?? "currency unknown"})` : "missing",
    fx: fx ? `${rnd(fx.value, 4)} (${fx.source})` : fundamentals ? "missing: statements and listing currencies differ and no rate loaded" : "n/a",
    profile: profile ? `${profile.name ?? symbol}${profile.industry ? `, ${profile.industry}` : ""}` : "missing",
    index: `${indexSymbol}: ${span(index)}`,
    riskFree: `short ${rnd(rf.short.value * 100, 2)}% (${rf.short.source}); long ${rnd(rf.long.value * 100, 2)}% (${rf.long.source})`,
    news: news ? `${news.length} headlines` : "missing",
    options: market === "US" ? (options ? `${options.quotes.length} quotes (${options.source})` : "missing") : `n/a (India VIX ${indiaVix ? "loaded" : "missing"})`,
    factors: factors ? `${factors.series.size} days through ${factors.through ?? "?"}${factors.proxy ? " (ETF proxies)" : ""}` : "missing",
    macro: `${macro.length}/${md.MACRO_SERIES[market].length} macro series`,
    insiders: insiders ? `${insiders.buys} buys / ${insiders.sells} sells, ${insiders.period} (${insiders.source})` : "missing",
    peers: `${peers.filter((p) => p.history).length}/${peers.length} histories, ${peers.filter((p) => p.fundamentals).length}/${peers.length} fundamentals`,
    filing: o.filingExcerpt ? `${o.filingExcerpt.length} chars` : "none",
  };

  return {
    ticker, market, symbol, sector: o.sector, financial,
    asOf: lastBar?.date ?? null,
    fetchedAt: new Date().toISOString(),
    price, history, intraday: intraday ?? [], fundamentals, fx, profile,
    news: news ?? [], options, factors, rf, index, indexSymbol, indiaVix, insiders,
    weekly, macro, macroContext, peers,
    filingExcerpt: o.filingExcerpt ?? null,
    coverage,
  };
}

// ── Results and state ───────────────────────────────────────────────────────

export type AgentResult = {
  agent: string;
  /** −100…100 opinion on the stock, or null when the agent measures rather than votes. */
  score: number | null;
  /** The agent's own out-of-sample test, when it ran one. */
  evidence?: Evidence | null;
  /** Headline method, e.g. the model the ML agent picked. */
  method?: string;
  /** One line, ≤ 240 chars: what the agent found. */
  summary: string;
  data: unknown;
  skipped?: string;
};

export type QuantState = {
  bundle: QuantBundle;
  results: Record<string, AgentResult>;
  timings: Record<string, number>;
  models: Partial<Record<ModelValue["method"], ModelValue>>;
  relativeRows: RelativeRow[] | null;
  assumptions: ValuationAssumptions;
  snapshot: CompanySnapshot | null;
  coc: CostOfCapital | null;
  betaSource: string | null;
  risk: RiskReport | null;
  screen: ScreenResult | null;
  blend: BlendResult | null;
  garch: GarchReport | null;
  /** undefined until built; null when there is too little history. */
  features: FeatureSet | null | undefined;
  backtest: BacktestReport | null;
  macroFit: MacroFit | null;
  /** The macro strategist's expected direction per macro factor name. */
  macroTilts: Record<string, -1 | 0 | 1> | null;
  ensemble: EnsembleResult | null;
  /** Set when the screen fails: the cycle stops before analysis. */
  halt?: string;
};

/** `chosen`: the operator's stored valuation assumptions for the desk (assumption-store.ts). */
export function newState(bundle: QuantBundle, chosen: ChosenAssumptions): QuantState {
  return {
    bundle, results: {}, timings: {}, models: {}, relativeRows: null,
    assumptions: marketAssumptions(bundle.market, bundle.rf.long.value, bundle.rf.long.source, chosen),
    snapshot: null, coc: null, betaSource: null, risk: null, screen: null, blend: null, garch: null,
    features: undefined, backtest: null, macroFit: null, macroTilts: null, ensemble: null,
  };
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200);

function result(agent: string, score: number | null, summary: string, data: unknown, extra: Partial<AgentResult> = {}): AgentResult {
  return { agent, score: isNum(score) ? Math.round(clamp(score, -100, 100)) : null, summary: summary.slice(0, 240), data, ...extra };
}

export function skip(agent: string, why: string): AgentResult {
  return { agent, score: null, summary: `skipped: ${why}`.slice(0, 240), data: null, skipped: why };
}

/** Store a result produced elsewhere (the LLM agents in quant-nodes.ts). */
export function recordResult(st: QuantState, r: AgentResult, ms?: number): void {
  st.results[r.agent] = r;
  if (ms != null) st.timings[r.agent] = ms;
}

export function runCompute(st: QuantState, slug: string): AgentResult {
  const fn = COMPUTE_AGENTS[slug];
  const t0 = Date.now();
  let r: AgentResult;
  if (!fn) r = skip(slug, "not a compute agent");
  else {
    try {
      r = fn(st);
    } catch (e) {
      r = skip(slug, `error: ${errText(e)}`);
    }
  }
  recordResult(st, r, Date.now() - t0);
  return r;
}

/** Run every compute agent in roster order (LLM agents are left to the caller). */
export function runAllCompute(st: QuantState, onResult?: (spec: AgentSpec, r: AgentResult, ms: number) => void): QuantState {
  for (const spec of QUANT_AGENTS) {
    if (spec.kind !== "compute") continue;
    const r = runCompute(st, spec.slug);
    onResult?.(spec, r, st.timings[spec.slug] ?? 0);
  }
  return st;
}

// ── Formatting ──────────────────────────────────────────────────────────────

const fx2 = (x: number | null | undefined, dp = 2) => (isNum(x) ? x.toFixed(dp) : "n/a");
/** Decimal → percent text. */
const pc = (x: number | null | undefined, dp = 1) => (isNum(x) ? `${(x * 100).toFixed(dp)}%` : "n/a");
const sgn = (x: number | null | undefined, dp = 1) => (isNum(x) ? `${x >= 0 ? "+" : ""}${x.toFixed(dp)}` : "n/a");

function big(x: number | null | undefined): string {
  if (!isNum(x)) return "n/a";
  const a = Math.abs(x);
  if (a >= 1e12) return `${(x / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `${(x / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(x / 1e6).toFixed(1)}M`;
  return x.toFixed(0);
}

function symbolFor(currency: string): string {
  const c = currency.toUpperCase();
  return c === "USD" ? "$" : c === "INR" ? "₹" : `${c} `;
}

const ccySymbol = (st: QuantState) => symbolFor(st.bundle.history?.currency ?? (st.bundle.market === "IN" ? "INR" : "USD"));

function moneyIn(symbol: string, x: number | null | undefined): string {
  if (!isNum(x)) return "n/a";
  return `${symbol}${Math.abs(x) >= 10_000 ? Math.round(x).toLocaleString("en-US") : x.toFixed(2)}`;
}

const money = (st: QuantState, x: number | null | undefined) => moneyIn(ccySymbol(st), x);

// ── Shared inputs ───────────────────────────────────────────────────────────

const Y1 = 252, Y3 = 756, Y5 = 1260;

const barsOf = (st: QuantState): Bar[] => st.bundle.history?.bars ?? [];
const adjCloses = (bs: readonly Bar[]) => bs.map((b) => b.adjClose);
const priceOf = (st: QuantState): number | null => st.bundle.price?.value ?? null;

function ensureSnapshot(st: QuantState): CompanySnapshot | null {
  if (st.snapshot) return st.snapshot;
  const b = st.bundle;
  const price = priceOf(st);
  if (!b.fundamentals || !b.fx || !isNum(price)) return null;
  st.snapshot = snapshot(b.fundamentals, price, st.assumptions, b.fx.value, b.profile?.sharesOutstanding ?? undefined, { tangible: b.financial });
  return st.snapshot;
}

function ensureCoc(st: QuantState): CostOfCapital | null {
  if (st.coc) return st.coc;
  const s = ensureSnapshot(st);
  if (!s) return null;
  const own = st.risk?.beta, vendor = st.bundle.profile?.beta;
  const beta = isNum(own) ? own : isNum(vendor) ? vendor : null;
  st.betaSource = isNum(own) ? `3y daily regression vs ${st.bundle.indexSymbol}` : isNum(vendor) ? "vendor beta (Yahoo)" : "no beta: 1.0 assumed";
  st.coc = costOfCapital(s, st.assumptions, beta);
  return st.coc;
}

function refreshBlend(st: QuantState): void {
  const price = priceOf(st);
  st.blend = isNum(price) ? blendValuation(Object.values(st.models).filter((m): m is ModelValue => !!m), price, st.bundle.financial) : null;
}

/** Target plus up to `maxPeers` peers with at least three years of bars: the pool the ML, RL and backtest agents share. */
function poolSeries(st: QuantState, maxPeers = 5): { symbol: string; bars: Bar[] }[] {
  const own = barsOf(st);
  if (!own.length) return [];
  const peers = st.bundle.peers.filter((p) => (p.history?.bars.length ?? 0) >= Y3).slice(0, maxPeers);
  return [{ symbol: st.bundle.ticker, bars: own }, ...peers.map((p) => ({ symbol: p.ticker, bars: p.history?.bars ?? [] }))];
}

/** The target's last `days` adjusted closes with every peer that trades on (nearly) all the same dates, inner-joined. */
function alignedWithPeers(st: QuantState, days: number): { dates: string[]; own: number[]; peers: { symbol: string; closes: number[] }[] } | null {
  const own = barsOf(st).slice(-days);
  if (own.length < Math.min(days, 250)) return null;
  const dates = new Set(own.map((b) => b.date));
  const eligible = st.bundle.peers.filter((p) => {
    const hb = p.history?.bars;
    if (!hb) return false;
    let hit = 0;
    for (const b of hb) if (dates.has(b.date)) hit++;
    return hit / dates.size >= 0.97;
  });
  const al = alignOnDates([own, ...eligible.map((p) => p.history?.bars ?? [])]);
  return { dates: al.dates, own: al.cols[0], peers: eligible.map((p, i) => ({ symbol: p.ticker, closes: al.cols[i + 1] })) };
}

function stockReturnMap(bs: readonly Bar[]): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 1; i < bs.length; i++) if (bs[i - 1].adjClose > 0 && bs[i].adjClose > 0) m.set(bs[i].date, bs[i].adjClose / bs[i - 1].adjClose - 1);
  return m;
}

function ensureFeatures(st: QuantState): FeatureSet | null {
  if (st.features !== undefined) return st.features;
  const pool = poolSeries(st);
  const index = st.bundle.index?.bars;
  // ~6 years of rows per symbol plus the 252-bar warm-up the slowest feature needs.
  const sets = pool.filter((s) => s.bars.length >= 600).map((s) => buildFeatures(s.symbol, s.bars.slice(-1764), { horizon: 21, index }));
  st.features = sets.length ? poolFeatures(sets) : null;
  return st.features;
}

const seedOf = (st: QuantState) => seedFrom(`${st.bundle.ticker}|${st.bundle.asOf ?? st.bundle.fetchedAt.slice(0, 10)}`);
const costBpsOf = (st: QuantState) => (st.bundle.market === "IN" ? 20 : 10);

function oosEvidence(o: OosScore, test: string): Evidence {
  const t = isNum(o.dmT) ? o.dmT : 0;
  return { passed: o.skill > 0 && t >= 2, t, test };
}

const icOf = (m: ModelReport) => (isNum(m.oos.ic) ? m.oos.ic : -9);

function pickModel(rep: MlReport): ModelReport | null {
  if (!rep.models.length) return null;
  const best = rep.best ? rep.models.find((m) => m.model === rep.best) : undefined;
  return best ?? [...rep.models].sort((a, b) => icOf(b) - icOf(a))[0];
}

function modelRow(m: ModelReport) {
  return {
    model: m.model, family: m.family, forecast: m.forecast, score: m.score,
    oos: { folds: m.oos.folds, n: m.oos.n, ic: m.oos.ic, icT: m.oos.icT, icClusters: m.oos.icClusters, icByFold: m.oos.icByFold, hitRate: m.oos.hitRate, baseRate: m.oos.baseRate, skill: m.oos.skill, passed: m.oos.passed },
    importance: m.importance.slice(0, 8), ...(m.discarded ? { discarded: m.discarded } : {}), params: m.params, notes: m.notes,
  };
}

function mlResult(slug: string, pick: ModelReport, models: readonly ModelReport[], pool: Record<string, unknown>): AgentResult {
  const o = pick.oos;
  const evidence: Evidence = { passed: o.passed, t: isNum(o.icT) ? o.icT : 0, test: `walk-forward IC (${pick.model})` };
  const summary = `${pick.model}: OOS IC ${fx2(o.ic, 3)} (t ${fx2(o.icT)}, ${o.icClusters} dates) ${o.passed ? "PASSED" : "failed"} · 21d forecast ${isNum(pick.forecast) ? `${sgn(pick.forecast * 100, 2)}%` : "n/a"}`;
  return result(slug, pick.score, summary, { picked: pick.model, pool, models: models.map(modelRow) }, { evidence, method: pick.model });
}

function familyEvidence(bt: BacktestReport | null, family: Family): Evidence | null {
  const f = bt?.families.find((x) => x.family === family);
  if (!f) return null;
  return { passed: f.passed, t: isNum(f.walkForward.alphaT) ? f.walkForward.alphaT : 0, test: `backtest: ${f.name} walk-forward timing alpha after costs` };
}

/** Score for a valuation model: its upside against the current price. */
function valuationResult(st: QuantState, slug: string, label: string, mv: ModelValue, extra: (mv: ModelValue) => string = () => ""): AgentResult {
  st.models[mv.method] = mv;
  refreshBlend(st);
  const price = priceOf(st);
  if (!mv.applicable || !isNum(mv.perShare) || !isNum(price)) {
    return result(slug, null, `${label} not applicable: ${mv.reason ?? "no estimate"}`, mv, { method: mv.method });
  }
  const up = (mv.perShare / price - 1) * 100;
  const band = isNum(mv.low) && isNum(mv.high) ? ` (${money(st, mv.low)}–${money(st, mv.high)})` : "";
  const tail = extra(mv);
  return result(slug, upsideScore(up), `${label} ${money(st, mv.perShare)}/share${band} vs ${money(st, price)}: ${sgn(up)}%${tail ? ` · ${tail}` : ""}`, mv, { method: mv.method });
}

const detailNum = (mv: ModelValue, key: string): number | null => {
  const v = mv.detail?.[key];
  return isNum(v) ? v : null;
};

// ── Compute agents ──────────────────────────────────────────────────────────

const COMPUTE_AGENTS: Record<string, (st: QuantState) => AgentResult> = {
  "market-data-reader": (st) => {
    const b = st.bundle;
    const gaps = Object.entries(b.coverage).filter(([, v]) => v.startsWith("missing")).map(([k]) => k);
    const summary = `price ${money(st, b.price?.value)} · ${b.history?.bars.length ?? 0} daily bars · fundamentals ${b.fundamentals ? "ok" : "missing"} · ${b.news.length} headlines · peers ${b.coverage.peers}${gaps.length ? ` · missing: ${gaps.join(", ")}` : ""}`;
    return result("market-data-reader", null, summary, { coverage: b.coverage, financial: b.financial, industry: b.profile?.industry ?? null, asOf: b.asOf });
  },

  "fundamentals-screener": (st) => {
    const b = st.bundle, f = b.fundamentals;
    if (!f) return skip("fundamentals-screener", "no fundamentals");
    const s = ensureSnapshot(st);
    // Altman needs market value in the reporting currency.
    const mcap = s ? s.marketCap / s.fx : NaN;
    const peers = b.peers.map((p) => p.fundamentals).filter((x): x is Fundamentals => !!x);
    const r = screen(f, mcap, peers, { financial: b.financial, taxFallback: st.assumptions.statutoryTax });
    if (r.altman && !isNum(r.altman.z)) {
      // No market cap: drop the meaningless Z (NaN reads as "safe") and re-derive the verdict.
      r.altman = null;
      r.greenFlags = r.greenFlags.filter((x) => !x.startsWith("Altman"));
      r.redFlags = r.redFlags.filter((x) => !x.startsWith("Altman"));
      if (r.verdict !== "insufficient") r.verdict = r.redFlags.length >= 2 ? "fail" : r.redFlags.length === 1 ? "watch" : "pass";
    }
    st.screen = r;
    if (r.verdict === "fail") st.halt = `screen failed: ${r.redFlags.join("; ")}`;
    const score = r.verdict === "insufficient" ? null : 2 * ((r.qualityScore ?? 50) - 50) - 25 * r.redFlags.length + 10 * r.greenFlags.length;
    const pio = r.piotroski ? `Piotroski ${r.piotroski.score}/${r.piotroski.available}` : "Piotroski n/a";
    const alt = r.altman ? `Altman Z ${fx2(r.altman.z)} (${r.altman.zone})` : b.financial ? "Altman n/a (financial)" : "Altman n/a";
    const flags = r.redFlags.length ? ` · red: ${r.redFlags.join("; ")}` : r.greenFlags.length ? ` · green: ${r.greenFlags.join("; ")}` : "";
    const summary = `${r.verdict.toUpperCase()} · quality ${r.qualityScore ?? "n/a"}/100 vs ${peers.length} peers · ${pio} · ${alt} · ROIC ${pc(r.latest?.roic)}, net margin ${pc(r.latest?.netMargin)}${flags}`;
    return result("fundamentals-screener", score, summary, { ...r, history: ratioHistory(f, st.assumptions.statutoryTax).slice(-5) });
  },

  "forensic-accountant": (st) => {
    const f = st.bundle.fundamentals;
    if (!f) return skip("forensic-accountant", "no fundamentals");
    const r = forensic(f, st.assumptions.statutoryTax);
    const none = !r.beneish && r.accrualsRatio == null && r.fcfToNetIncome == null && r.dsoChangeDays == null;
    if (none) return skip("forensic-accountant", "statements too thin for forensic checks");
    const m = r.beneish ? `Beneish M ${fx2(r.beneish.m)}${r.beneish.flagged ? " (flagged)" : ""}` : "Beneish n/a";
    const summary = `forensic risk ${Math.round(r.riskScore)}/100 · ${m} · accruals ${pc(r.accrualsRatio)} · FCF/NI ${fx2(r.fcfToNetIncome)} · DSO ${sgn(r.dsoChangeDays, 0)}d${r.flags.length ? ` · ${r.flags.join("; ")}` : ""}`;
    return result("forensic-accountant", 25 - 1.25 * r.riskScore, summary, r);
  },

  "risk-metrics-analyst": (st) => {
    const b = st.bundle, own = barsOf(st);
    if (own.length < 61) return skip("risk-metrics-analyst", "under 60 days of prices");
    let r: RiskReport | null;
    if (b.index?.bars.length) {
      const al = alignOnDates([own, b.index.bars]);
      r = riskReport(al.cols[0].slice(-(Y3 + 1)), b.rf.short.value, al.cols[1].slice(-(Y3 + 1)));
    } else r = riskReport(adjCloses(own).slice(-(Y3 + 1)), b.rf.short.value);
    if (!r) return skip("risk-metrics-analyst", "too few aligned observations");
    st.risk = r;
    const summary = `${Math.round(r.observations / 252 * 10) / 10}y: vol ${pc(r.annualVol)}, beta ${fx2(r.beta)} vs ${b.indexSymbol}, Sharpe ${fx2(r.sharpe)}, Sortino ${fx2(r.sortino)}, max DD ${pc(-r.maxDrawdown.maxDrawdown)}, 1d VaR95 ${pc(r.var95.historical, 2)} / CVaR ${pc(r.cvar95, 2)}`;
    return result("risk-metrics-analyst", null, summary, { ...r, rf: b.rf.short });
  },

  "dcf-modeler": (st) => {
    const b = st.bundle, f = b.fundamentals;
    if (!f) return skip("dcf-modeler", "no fundamentals");
    const s = ensureSnapshot(st), coc = ensureCoc(st);
    if (!s || !coc) return skip("dcf-modeler", b.fx ? "no price or share count" : "no FX rate between reporting and listing currency");
    const mv = dcfModel(f, s, coc, st.assumptions, growthHint(f, b.profile?.revenueGrowth), { financial: b.financial });
    return valuationResult(st, "dcf-modeler", "DCF", mv, (m) => {
      const tv = detailNum(m, "tvShareOfEv");
      const g0 = detailNum(m, "growthStart");
      return `WACC ${pc(coc.wacc)} (β ${fx2(coc.beta)}), growth ${pc(g0)} → ${pc(st.assumptions.terminalGrowth)}${isNum(tv) ? `, TV ${pc(tv, 0)} of EV` : ""}`;
    });
  },

  "ddm-modeler": (st) => {
    const f = st.bundle.fundamentals;
    if (!f) return skip("ddm-modeler", "no fundamentals");
    const s = ensureSnapshot(st), coc = ensureCoc(st);
    if (!s || !coc) return skip("ddm-modeler", "no snapshot (price, shares or FX missing)");
    const mv = ddmModel(f, s, coc, st.assumptions);
    return valuationResult(st, "ddm-modeler", "DDM", mv, () => `r ${pc(coc.costOfEquity)}${isNum(s.dps) ? `, DPS ${money(st, s.dps)}` : ""}`);
  },

  "residual-income-modeler": (st) => {
    const s = ensureSnapshot(st), coc = ensureCoc(st);
    if (!s || !coc) return skip("residual-income-modeler", "no snapshot (price, shares or FX missing)");
    const mv = residualIncomeModel(s, coc, st.assumptions);
    const basis = st.bundle.financial ? "ROTE" : "ROE";
    return valuationResult(st, "residual-income-modeler", "Residual income", mv, () => `${basis} ${pc(s.roe)} vs r ${pc(coc.costOfEquity)}, ${st.bundle.financial ? "tangible book" : "book"} ${money(st, s.bookPerShare)}`);
  },

  "multiples-analyst": (st) => {
    const b = st.bundle, f = b.fundamentals;
    if (!f) return skip("multiples-analyst", "no fundamentals");
    const s = ensureSnapshot(st);
    if (!s) return skip("multiples-analyst", "no snapshot (price, shares or FX missing)");
    const epsG = growth(f, 3).epsCagr;
    const own = computeMultiples(s, epsG);
    const peerMultiples: (Multiples & { ticker: string })[] = [];
    for (const p of b.peers) {
      const pb = p.history?.bars;
      if (!p.fundamentals || !p.fx || !pb?.length) continue;
      const ps = snapshot(p.fundamentals, pb[pb.length - 1].close, st.assumptions, p.fx.value, undefined, { tangible: b.financial });
      if (ps) peerMultiples.push({ ticker: p.ticker, ...computeMultiples(ps, growth(p.fundamentals, 3).epsCagr) });
    }
    const own_bars = barsOf(st);
    const hist = historicalMultiples(f, s, (d) => closeOnOrBefore(own_bars, d), { tangible: b.financial });
    const rel = relativeModel(s, own, peerMultiples, hist, epsG, { financial: b.financial });
    st.relativeRows = rel.rows;
    const pe = rel.rows.find((r) => r.multiple === "pe");
    const mv: ModelValue = { method: rel.method, applicable: rel.applicable, reason: rel.reason, perShare: rel.perShare, low: rel.low, high: rel.high, detail: { ...rel.detail, rows: rel.rows, own, peers: peerMultiples } };
    return valuationResult(st, "multiples-analyst", "Multiples", mv, () => (pe?.own != null ? `P/E ${fx2(pe.own, 1)} vs peers ${fx2(pe.peerMedian, 1)} / own history ${fx2(pe.historyMedian, 1)}` : ""));
  },

  "sentiment-analyst": (st) => {
    const b = st.bundle, p = b.profile;
    const asOf = new Date(b.fetchedAt);
    const news = b.news.length ? newsTone(b.news, asOf) : null;
    const rev = p ? revisionsScore({ ratingChanges: p.ratingChanges, epsTrend: p.epsTrend, epsRevisions: p.epsRevisions }, asOf, 90) : null;
    const ins = b.insiders ? insiderScore(b.insiders) : null;
    const si = p?.shortInterest ? shortInterestScore(p.shortInterest) : null;
    const comp = sentimentComposite({ news: news?.score, revisions: rev?.score, insiders: ins?.score, shortInterest: si?.score });
    if (!comp) return skip("sentiment-analyst", "no news, revisions, insider or short-interest data");
    const parts = [
      news ? `news ${sgn(news.score, 0)} (${news.count})` : "news n/a",
      rev ? `revisions ${sgn(rev.score, 0)} (${rev.upgrades}↑ ${rev.downgrades}↓, targets ${rev.targetRaises}↑ ${rev.targetCuts}↓)` : "revisions n/a",
      ins ? `insiders ${sgn(ins.score, 0)} (${ins.buys} buys / ${ins.sells} sells)` : "insiders n/a",
      si ? `short interest ${sgn(si.score, 0)} (${pc(si.pctFloat)} of float)` : "short interest n/a",
    ];
    return result("sentiment-analyst", comp.score, `sentiment ${sgn(comp.score, 0)} · ${parts.join(" · ")}`, { composite: comp, news, revisions: rev, insiders: ins, shortInterest: si });
  },

  "earnings-call-analyst": (st) => {
    const b = st.bundle;
    const ed = b.profile?.earnings.length ? earningsDelivery(b.profile.earnings) : null;
    const ct = b.filingExcerpt ? callTone(b.filingExcerpt) : null;
    if (!ed && !ct) return skip("earnings-call-analyst", "no earnings history or filing text");
    const score = ed && ct ? 0.6 * ed.score + 0.4 * ct.score : (ed?.score ?? ct?.score ?? null);
    const d = ed ? `delivery ${sgn(ed.score, 0)}: beat ${Math.round(ed.beatRate * ed.quarters)}/${ed.quarters}, last surprise ${sgn(ed.lastSurprisePct)}% (${ed.lastDate})` : "no earnings history";
    const t = ct ? `filing tone ${sgn(ct.score, 0)} (net ${fx2(ct.net)}, hedging ${pc(ct.uncertaintyShare)})` : "no filing text (transcripts not wired)";
    return result("earnings-call-analyst", score, `${d} · ${t}`, { delivery: ed, tone: ct ? { ...ct, hits: ct.hits.slice(0, 20) } : null, source: ct ? "filing excerpt (untrusted text, lexicon-scored)" : null });
  },

  "arima-forecaster": (st) => {
    const lr = logReturns(adjCloses(barsOf(st))).slice(-Y5);
    const r = arimaReport(lr);
    if (!r) return skip("arima-forecaster", "under 250 daily returns");
    const sd = std(lr);
    const score = sd > 0 ? 100 * Math.tanh((2 * r.forecast21d) / (sd * Math.sqrt(21))) : 0;
    const evidence = oosEvidence(r.oos, "Diebold-Mariano vs random walk");
    const summary = `ARIMA(${r.order.join(",")}): 21d forecast ${sgn(r.forecast21d * 100, 2)}% · OOS skill ${fx2(r.oos.skill * 100, 2)}%, DM t ${fx2(r.oos.dmT)} → ${evidence.passed ? "PASSED" : "no edge over a random walk"} · Ljung-Box p ${fx2(r.ljungBoxP)}`;
    return result("arima-forecaster", score, summary, r, { evidence, method: `ARIMA(${r.order.join(",")})` });
  },

  "garch-forecaster": (st) => {
    const r = garchReport(logReturns(adjCloses(barsOf(st))));
    if (!r) return skip("garch-forecaster", "under 300 daily returns");
    st.garch = r;
    const summary = `vol now ${pc(r.currentVol)} → 21d ${pc(r.forecastVol21d)}, 63d ${pc(r.forecastVol63d)}, long-run ${pc(r.longRunVol)} · α+β ${fx2(r.fit.persistence, 3)}, half-life ${fx2(r.halfLifeDays, 0)}d · next-day σ ${pc(r.nextDaySigma, 2)} · ${r.oos.beatsNaive ? "beats" : "does not beat"} naive vol out of sample`;
    return result("garch-forecaster", null, summary, r, { method: "GARCH(1,1)" });
  },

  "smoothing-forecaster": (st) => {
    const lp = adjCloses(barsOf(st)).slice(-(Y5 + 1)).map(Math.log);
    const r = smoothingReport(lp);
    if (!r) return skip("smoothing-forecaster", "under 250 daily prices");
    if (r.holt.alpha > 0.99 && r.holt.beta < 1e-4) {
      // Level weight → 1, trend weight → 0: the best smoother is "tomorrow = today".
      const summary = `fitted smoother collapses to a random walk (Holt α ${fx2(r.holt.alpha, 3)}, β ≈ 0; SES α ${fx2(r.ses.alpha, 3)}): no forecastable trend in the price level`;
      return result("smoothing-forecaster", 0, summary, r, { evidence: { passed: false, t: 0, test: "collapsed to a random walk" }, method: "Holt (damped) → random walk" });
    }
    const sd = std(logReturns(adjCloses(barsOf(st)).slice(-(Y5 + 1))));
    const score = sd > 0 ? 100 * Math.tanh((2 * r.forecast21dReturn) / (sd * Math.sqrt(21))) : 0;
    const evidence = oosEvidence(r.oos, "Diebold-Mariano vs random walk (5-day)");
    const summary = `damped Holt: trend ${sgn(r.trendAnnual * 100)}%/yr, 21d forecast ${sgn(r.forecast21dReturn * 100, 2)}% · OOS skill ${fx2(r.oos.skill * 100, 2)}%, DM t ${fx2(r.oos.dmT)} → ${evidence.passed ? "PASSED" : "no edge over a random walk"}`;
    return result("smoothing-forecaster", score, summary, r, { evidence, method: "Holt (damped)" });
  },

  "kalman-trend-analyst": (st) => {
    const r = kalmanTrendReport(adjCloses(barsOf(st)).slice(-Y3).map(Math.log));
    if (!r) return skip("kalman-trend-analyst", "under 120 daily prices");
    const summary = `${r.signal}: filtered drift ${sgn(r.slopeAnnual * 100)}%/yr (t ${fx2(r.slopeT)}) · price ${sgn(r.priceVsLevelPct)}% vs filtered level`;
    return result("kalman-trend-analyst", 100 * Math.tanh(r.slopeT / 4), summary, r);
  },

  "pairs-scout": (st) => {
    const al = alignedWithPeers(st, Y3);
    if (!al || !al.peers.length) return skip("pairs-scout", "no peer with three aligned years of prices");
    const r = pairsScan(al.own.map(Math.log), al.peers.map((p) => ({ symbol: p.symbol, logp: p.closes.map(Math.log) })));
    const best = r.best;
    if (!best) return result("pairs-scout", null, `no cointegrated pair among ${r.tested} peers at ${r.level} (in-sample and out-of-sample ADF both required)`, r);
    const summary = `cointegrated with ${best.peer} (hedge ${fx2(best.hedgeRatio)}, half-life ${fx2(best.halfLifeDays, 0)}d, ADF ${fx2(best.adfStat)} < ${fx2(best.critical)}): spread z ${sgn(best.zNow, 2)} → ${best.zNow > 0 ? "rich" : "cheap"} vs the peer`;
    return result("pairs-scout", -100 * Math.tanh(best.zNow / 2), summary, r, { method: `pair vs ${best.peer}` });
  },

  "regime-detector": (st) => {
    const b = st.bundle;
    const x = logReturns(b.weekly.closes);
    const r = markovSwitching(x);
    if (!r) return skip("regime-detector", "under 60 weekly returns");
    const ib = b.index?.bars;
    const idxCloses = ib ? b.weekly.dates.map((d) => closeOnOrBefore(ib, d)).filter((v): v is number => isNum(v) && v > 0) : [];
    const idx = idxCloses.length > 60 ? markovSwitching(logReturns(idxCloses)) : null;
    const rf = b.rf.short.value;
    const v = regimeView(r, rf), iv = idx ? regimeView(idx, rf) : null;
    const idxText = iv ? ` · ${b.indexSymbol} ${iv.label} (P ${pc(iv.pNow, 0)})` : "";
    const fmt = (x: { mu: number | null; vol: number | null }) => `${pc(x.mu)}/yr at vol ${pc(x.vol)}`;
    const summary = v.hasBear
      ? `${v.label} regime, P(bull) ${pc(r.probBull, 0)} · bull ${fmt(v.a)}, bear ${fmt(v.b)} (below cash ${pc(rf)})${idxText}`
      : `no bear regime: both states drift above cash (${pc(rf)}) · calm ${fmt(v.a)} vs turbulent ${fmt(v.b)} · now ${v.label} (P ${pc(v.pNow, 0)})${idxText}`;
    const score = v.hasBear ? 100 * (2 * r.probBull - 1) : 0;
    return result("regime-detector", score, summary, {
      ...r, probBullPath: r.probBullPath.slice(-52), view: v,
      index: idx && iv ? { current: idx.current, probBull: idx.probBull, states: idx.states, view: iv } : null,
    });
  },

  "monte-carlo-simulator": (st) => {
    const b = st.bundle, price = priceOf(st);
    const lr = logReturns(adjCloses(barsOf(st)));
    if (!isNum(price) || lr.length < 250) return skip("monte-carlo-simulator", "no price or under 250 daily returns");
    const coc = ensureCoc(st);
    const mu = coc ? coc.costOfEquity : b.rf.long.value + st.assumptions.erp;
    const g = st.garch;
    const r = monteCarloReport({
      s0: price,
      logRets: lr,
      muAnnual: mu,
      muSource: coc ? "CAPM cost of equity" : "rf + equity risk premium",
      garch: g ? { omega: g.fit.omega, alpha: g.fit.alpha, beta: g.fit.beta, sigma2Next: g.nextDaySigma * g.nextDaySigma } : null,
      fairValue: st.blend?.fairValueMid ?? null,
      horizons: [21, 63, 252],
      paths: 5000,
      seed: seedOf(st),
    });
    if (!r) return skip("monte-carlo-simulator", "simulation inputs invalid");
    const dist = r.garch ?? r.bootstrap;
    const m1 = dist.find((d) => d.days === 21), y1 = dist.find((d) => d.days === 252);
    const summary = `${r.garch ? "GARCH" : "bootstrap"} sim, ${r.paths} paths, drift ${pc(mu)}: 1m ${money(st, m1?.p5)}–${money(st, m1?.p95)} (P(up) ${pc(m1?.probUp, 0)}, VaR95 ${pc(m1?.var95)}) · 1y median ${money(st, y1?.p50)}${isNum(y1?.probAboveFair) ? `, P(1y price > blended fair ${money(st, st.blend?.fairValueMid)}) ${pc(y1?.probAboveFair, 0)}` : ""}`;
    return result("monte-carlo-simulator", null, summary, r);
  },

  "jump-diffusion-modeler": (st) => {
    const r = fitMerton(logReturns(adjCloses(barsOf(st))).slice(-Y5));
    if (!r) return skip("jump-diffusion-modeler", "too few returns to fit");
    const summary = `${fx2(r.jumpsPerYear, 1)} jumps/yr, mean ${sgn(r.meanJumpPct)}% ± ${fx2(r.jumpVolPct, 1)}%, ${pc(r.jumpShareOfVariance, 0)} of variance · LR p ${fx2(r.lrP, 3)} (${r.jumpsSignificant ? "jumps significant" : "not significant"}) · P(−10% in 21d) ${pc(r.probDrop10pct21d.jump)} vs Gaussian ${pc(r.probDrop10pct21d.gaussian)}`;
    return result("jump-diffusion-modeler", null, summary, r, { method: "Merton" });
  },

  "mean-reversion-modeler": (st) => {
    const b = st.bundle;
    const reports: OuSeriesReport[] = [];
    if (b.index?.bars.length) {
      const al = alignOnDates([barsOf(st), b.index.bars]);
      const s = logReturns(al.cols[0].slice(-(Y1 + 1))), m = logReturns(al.cols[1].slice(-(Y1 + 1)));
      const lvl = residualLevel(s, m);
      if (lvl) reports.push(ouSeriesReport(`market-model residual vs ${b.indexSymbol} (1y)`, lvl.level));
    }
    const ap = alignedWithPeers(st, Y1);
    if (ap && ap.peers.length >= 2) {
      const x = ap.own.map((v, i) => Math.log(v) - mean(ap.peers.map((p) => Math.log(p.closes[i]))));
      reports.push(ouSeriesReport(`log price vs ${ap.peers.length}-peer basket (1y)`, x));
    }
    if (!reports.length) return skip("mean-reversion-modeler", "no index or peer series to test");
    const live = reports.filter((r) => r.meanReverting && isNum(r.zNow));
    const score = live.length ? mean(live.map((r) => -100 * Math.tanh((r.zNow as number) / 2))) : null;
    // Mean-reverting needs ADF significant at 1% and a half-life under ~6 months.
    const why = (r: OuSeriesReport) =>
      r.adf?.pBucket !== "<1%" ? `no reversion at 1% (ADF ${r.adf?.pBucket ?? "n/a"})` : r.fit ? `stationary but too slow (half-life ${fx2(r.fit.halfLifeDays, 0)}d)` : "stationary but no OU fit";
    const desc = reports.map((r) => `${r.series}: ${r.meanReverting ? `mean-reverting, half-life ${fx2(r.fit?.halfLifeDays, 0)}d, z ${sgn(r.zNow, 2)}` : why(r)}`);
    return result("mean-reversion-modeler", score, desc.join(" · "), { series: reports });
  },

  "implied-vol-reader": (st) => {
    const b = st.bundle;
    const fcst = st.garch?.forecastVol21d ?? null;
    if (b.market === "US") {
      const oc = b.options;
      if (!oc?.quotes.length) return skip("implied-vol-reader", "no option chain");
      const q = clamp(b.profile?.dividendYield ?? 0, 0, 0.15);
      const iv = impliedVolSummary(oc.quotes, oc.spot, new Date(md.nyTimeMs(oc.asOf)), b.rf.short.value, q);
      if (!isNum(iv.iv30)) return skip("implied-vol-reader", "no usable at-the-money quotes");
      const vrp = isNum(fcst) ? volRiskPremium(iv.iv30, fcst) : null;
      const summary = `IV30 ${pc(iv.iv30)}${vrp ? ` vs GARCH 21d ${pc(fcst)} (VRP ${sgn(vrp.gap * 100)} pts)` : ""} · term slope ${sgn(isNum(iv.termSlope) ? iv.termSlope * 100 : null)} pts · 25Δ skew ${sgn(isNum(iv.skew25d) ? iv.skew25d * 100 : null)} pts · P/C OI ${fx2(iv.putCallOiRatio)} · ±${fx2(iv.expectedMove21d?.pct)}% 21d move`;
      return result("implied-vol-reader", null, summary, { ...iv, vrp, garchForecast21d: fcst, source: oc.source, asOf: oc.asOf });
    }
    const vix = b.indiaVix?.bars;
    const r = st.risk;
    if (!vix?.length || !r) return skip("implied-vol-reader", "no India VIX or risk metrics");
    const vixLast = vix[vix.length - 1];
    const beta = isNum(r.beta) ? r.beta : 1;
    const ib = b.index?.bars ?? [];
    const sm = ib.length > 60 ? std(logReturns(adjCloses(ib).slice(-(Y3 + 1)))) * Math.sqrt(252) : 0;
    const idio = Math.sqrt(Math.max(0, r.annualVol * r.annualVol - beta * beta * sm * sm));
    const proxy = impliedVolProxy(vixLast.close / 100, beta, idio);
    const vrp = isNum(fcst) ? volRiskPremium(proxy, fcst) : null;
    const summary = `IV proxy ${pc(proxy)} from India VIX ${fx2(vixLast.close)} (${vixLast.date}), β ${fx2(beta)}, idio vol ${pc(idio)}${vrp ? ` · vs GARCH 21d ${pc(fcst)} (gap ${sgn(vrp.gap * 100)} pts)` : ""} · proxy, not a single-stock chain`;
    return result("implied-vol-reader", null, summary, { proxy, indiaVix: vixLast.close, vixDate: vixLast.date, beta, idioVol: idio, indexVol: sm, vrp, garchForecast21d: fcst });
  },

  "capm-analyst": (st) => {
    const b = st.bundle;
    if (!b.factors) return skip("capm-analyst", "no factor data");
    const rets = stockReturnMap(barsOf(st));
    const spec = (b.market === "US" ? US_FACTOR_MODELS : IN_FACTOR_MODELS)[0];
    const fit = fitFactorModels(rets, b.factors.series, [spec], { window: Y3 })[0];
    if (!fit) return skip("capm-analyst", "regression failed (too few overlapping days)");
    const ex: number[] = [];
    for (const [d, r] of rets) {
      if (d < fit.start || d > fit.end) continue;
      const row = b.factors.series.get(d);
      if (row && isNum(row.RF) && isNum(row.MKT)) ex.push(r - row.RF);
    }
    const c = capmReport(fit, mean(ex) * 252, b.rf.long.value, st.assumptions.erp);
    const summary = `β ${fx2(c.beta)} (Blume ${fx2(c.betaBlume)}) · Jensen's α ${sgn(c.jensensAlpha * 100)}%/yr (t ${fx2(c.alphaT)}) · R² ${fx2(c.systematicShare)} · required return ${pc(c.requiredReturn)} · ${fit.start}..${fit.end}${b.factors.proxy ? " (proxy factors)" : ""}`;
    return result("capm-analyst", null, summary, { ...c, factorSource: b.factors.source });
  },

  "style-factor-analyst": (st) => {
    const b = st.bundle;
    if (!b.factors) return skip("style-factor-analyst", "no factor data");
    const fits = fitFactorModels(stockReturnMap(barsOf(st)), b.factors.series, b.market === "US" ? US_FACTOR_MODELS : IN_FACTOR_MODELS, { window: Y3 });
    const pref = preferredModel(fits);
    if (!pref) return skip("style-factor-analyst", "no factor model fitted");
    const tilts = styleTilts(pref);
    const stable = Math.sign(pref.alphaHalves[0]) === Math.sign(pref.alphaHalves[1]);
    const score = stable ? 100 * Math.tanh(pref.alphaT / 4) : 0;
    const summary = `${pref.model} (lowest BIC): α ${sgn(pref.alphaAnnual * 100)}%/yr (t ${fx2(pref.alphaT)}, ${stable ? "same sign in both halves" : "flips sign between halves: not stable"}) · adj R² ${fx2(pref.adjR2)} · ${tilts.length ? tilts.join(", ") : "no significant tilts"}`;
    const slim = (f: FactorFit) => ({ model: f.model, n: f.n, start: f.start, end: f.end, alphaAnnual: f.alphaAnnual, alphaT: f.alphaT, betas: f.betas, adjR2: f.adjR2, bic: f.bic, alphaHalves: f.alphaHalves, informationRatio: f.informationRatio });
    return result("style-factor-analyst", score, summary, { preferred: pref.model, tilts, fits: fits.map(slim), through: b.factors.through, source: b.factors.source, proxy: b.factors.proxy }, { method: pref.model });
  },

  "macro-factor-analyst": (st) => {
    const b = st.bundle;
    if (b.macro.length < 2) return skip("macro-factor-analyst", "fewer than two macro series loaded");
    const fit = fitMacroFactors(b.weekly.closes, b.rf.short.value / 52, b.macro);
    if (!fit) return skip("macro-factor-analyst", "too few overlapping weeks");
    st.macroFit = fit;
    const sig = fit.ranked.filter((e) => e.significant);
    const tilts = st.macroTilts;
    let score: number | null = null;
    if (tilts) {
      const impact = sig.reduce((a, e) => a + e.pctPerSd * (tilts[e.factor] ?? 0), 0);
      score = 100 * Math.tanh(impact / 2);
    }
    const ex = sig.length ? sig.slice(0, 4).map((e) => `${e.factor} ${sgn(e.pctPerSd, 2)}%/sd (t ${fx2(e.t, 1)})`).join(", ") : "no significant exposure";
    const summary = `${fit.n} weeks, R² ${fx2(fit.r2)} · ${ex}${tilts ? ` · priced against the strategist's view` : " · no strategist view: score withheld"}`;
    return result("macro-factor-analyst", score, summary, { ...fit, tilts });
  },

  "technical-analyst": (st) => {
    const t = technicalSnapshot(barsOf(st), st.bundle.intraday);
    if (!t) return skip("technical-analyst", "under 200 daily bars");
    const cross = t.lastCross ? `, last ${t.lastCross.type} cross ${t.lastCross.barsAgo} bars ago` : "";
    const summary = `votes ${sgn(t.score, 0)} · RSI ${fx2(t.rsi14, 0)}, MACD hist ${sgn(t.macd.hist, 2)}, %B ${fx2(t.bollinger.pctB)} · ${t.price > t.sma200 ? "above" : "below"} 200d SMA ${money(st, t.sma200)}${cross} · rel volume ${fx2(t.relVolume)}`;
    return result("technical-analyst", t.score, summary, t);
  },

  "momentum-analyst": (st) => {
    const own = momentum(adjCloses(barsOf(st)));
    if (own.mom12_1 == null) return skip("momentum-analyst", "under a year of prices");
    const peers = st.bundle.peers
      .map((p) => ({ ticker: p.ticker, m: p.history ? momentum(adjCloses(p.history.bars)).mom12_1 : null }))
      .filter((p): p is { ticker: string; m: number } => isNum(p.m));
    const r = momentumScore(own, peers.map((p) => p.m));
    const summary = `12-1 ${pc(own.mom12_1)}${r.percentile != null ? ` (${Math.round(r.percentile * 100)}th pct of ${peers.length} peers)` : ""} · 6-1 ${pc(own.mom6_1)} · 3m ${pc(own.ret3m)} · 1m ${pc(own.ret1m)}`;
    return result("momentum-analyst", r.score, summary, { ...own, ...r, peers });
  },

  "linear-ml-modeler": (st) => {
    const set = ensureFeatures(st);
    if (!set) return skip("linear-ml-modeler", "too little history for features");
    const rep = mlReport(set, st.bundle.ticker, LINEAR_LEARNERS, { folds: 5, testFrac: 0.5, seed: seedOf(st) });
    const pick = rep && pickModel(rep);
    if (!rep || !pick) return skip("linear-ml-modeler", "under 500 labeled rows");
    return mlResult("linear-ml-modeler", pick, rep.models, { rows: rep.rows, labeled: rep.labeled, symbols: rep.symbols, horizon: rep.horizon, asOf: rep.asOf, features: rep.features });
  },

  "tree-ensemble-modeler": (st) => {
    const set = ensureFeatures(st);
    if (!set) return skip("tree-ensemble-modeler", "too little history for features");
    const rep = mlReport(set, st.bundle.ticker, TREE_LEARNERS, { folds: 5, testFrac: 0.5, seed: seedOf(st) + 1 });
    const pick = rep && pickModel(rep);
    if (!rep || !pick) return skip("tree-ensemble-modeler", "under 500 labeled rows");
    return mlResult("tree-ensemble-modeler", pick, rep.models, { rows: rep.rows, labeled: rep.labeled, symbols: rep.symbols, horizon: rep.horizon, asOf: rep.asOf, features: rep.features });
  },

  "sequence-modeler": (st) => {
    const set = ensureFeatures(st);
    if (!set) return skip("sequence-modeler", "too little history for features");
    const reps = (["lstm", "transformer"] as const)
      .map((k) => sequenceModelReport(set, st.bundle.ticker, k, { seed: seedOf(st) + 2 }))
      .filter((r): r is ModelReport => !!r);
    if (!reps.length) return skip("sequence-modeler", "under 500 labeled sequences");
    const pick = [...reps].sort((a, b) => Number(b.oos.passed) - Number(a.oos.passed) || icOf(b) - icOf(a))[0];
    return mlResult("sequence-modeler", pick, reps, { rows: set.rows.length, horizon: set.horizon, features: set.names });
  },

  "rl-trader": (st) => {
    const pool = poolSeries(st);
    if (!pool.length || pool[0].bars.length < Y3) return skip("rl-trader", "under three years of prices");
    const series = pool.map((s) => ({ symbol: s.symbol, dates: s.bars.map((b) => b.date), closes: adjCloses(s.bars) }));
    const r = rlReport(series, st.bundle.ticker, { costBps: costBpsOf(st), seed: seedOf(st) });
    if (!r) return skip("rl-trader", "not enough aligned history to train");
    const p = r.oos.pooled;
    const evidence: Evidence = { passed: r.passed, t: isNum(p.alphaT) ? p.alphaT : 0, test: "pooled timing alpha vs buy-and-hold after costs (Newey-West)" };
    const now = r.current ? `today ${r.current.action} (${r.current.ret} return, ${r.current.vol} vol)` : "no current state";
    const summary = `Q-learning on ${r.symbols} names, test from ${r.cutDate}: Sharpe ${fx2(p.policySharpe)} vs buy-hold ${fx2(p.buyHoldSharpe)}, α ${sgn(p.alphaAnnual * 100)}%/yr (t ${fx2(p.alphaT)}) → ${r.passed ? "PASSED" : "failed"} · ${now}`;
    return result("rl-trader", r.score, summary, r, { evidence, method: "tabular Q-learning" });
  },

  "backtest-auditor": (st) => {
    const pool = poolSeries(st);
    if (!pool.length || pool[0].bars.length < Y3) return skip("backtest-auditor", "under three years of prices");
    const r = backtestReport(pool, st.bundle.ticker, { costBps: costBpsOf(st), rfAnnual: st.bundle.rf.short.value, folds: 5, testFrac: 0.5 });
    if (!r) return skip("backtest-auditor", "backtest could not run");
    st.backtest = r;
    const passed = r.families.filter((f) => f.passed).map((f) => f.name);
    const wf = r.overall.walkForward;
    const pit = [
      r.pitfalls.lookAhead.violations.length ? `${r.pitfalls.lookAhead.violations.length} look-ahead rules dropped` : "no look-ahead",
      r.pitfalls.overfitting.flagged ? `overfit (deflated Sharpe ${fx2(r.pitfalls.overfitting.deflatedSharpe)})` : "not overfit",
      r.pitfalls.costs.flagged ? `costs bite (break-even ${fx2(r.pitfalls.costs.breakEvenBps, 0)}bp)` : `survives ${r.params.costBps}bp costs`,
    ];
    const summary = `${r.families.length} rule families, walk-forward ${r.oosStart}..${r.end}: best-of Sharpe ${fx2(wf.sharpe)} vs hold ${fx2(r.buyHold.sharpe)}, α t ${fx2(wf.alphaT)} · validated: ${passed.length ? passed.join(", ") : "none"} · ${pit.join(", ")} · signal ${sgn(r.score, 0)}`;
    return result("backtest-auditor", null, summary, r, { evidence: { passed: r.passed, t: isNum(wf.alphaT) ? wf.alphaT : 0, test: "walk-forward timing alpha after costs" } });
  },

  "ensemble-combiner": (st) => {
    const inputs: EnsembleInput[] = [];
    const methodOf: Record<string, ModelValue["method"]> = {
      "dcf-modeler": "dcf", "ddm-modeler": "ddm", "residual-income-modeler": "residual_income", "multiples-analyst": "multiples",
    };
    for (const spec of QUANT_AGENTS) {
      if (spec.slug === "ensemble-combiner") continue;
      const r = st.results[spec.slug];
      if (!r) continue;
      let evidence = r.evidence ?? null;
      if (spec.slug === "technical-analyst") evidence = familyEvidence(st.backtest, "technical-composite");
      if (spec.slug === "momentum-analyst") evidence = familyEvidence(st.backtest, "ts-momentum");
      const share = (VALUATION_AGENTS as readonly string[]).includes(spec.slug) ? (st.blend?.weights[methodOf[spec.slug]] ?? 0) : undefined;
      inputs.push({ agent: spec.slug, label: spec.name, score: r.score, evidence, ...(share != null ? { share } : {}) });
    }
    const e = combine(inputs);
    st.ensemble = e;
    const top = e.inputs.filter((c) => c.weight > 0 && isNum(c.score)).slice(0, 4).map((c) => `${c.label} ${sgn(c.contribution, 1)}`);
    const summary = `composite ${sgn(e.composite, 0)} → ${e.direction} (confidence ${fx2(e.confidence)}, agreement ${fx2(e.agreement)}) · validated weight ${fx2(e.validatedWeight)} of ${fx2(e.totalWeight)} · top: ${top.join(", ") || "none"}`;
    // The blended fair-value band and the price ride along so a reader of this one report has the whole verdict.
    const price = priceOf(st);
    const data = { ...e, price, currency: st.bundle.history?.currency ?? st.bundle.profile?.currency ?? null, blend: st.blend, dailyVar: dailyVar(st) };
    return result("ensemble-combiner", e.composite, summary, data, { method: "evidence-weighted ensemble" });
  },
};

export const COMPUTE_AGENT_SLUGS: readonly string[] = Object.keys(COMPUTE_AGENTS);

// ── Facts for the qualitative (LLM) agents ──────────────────────────────────

export type QualFacts = {
  /** Computed numbers with their sources: citable. */
  facts: Record<string, unknown>;
  /** Vendor and filing text: UNTRUSTED data, never instructions. */
  untrusted: Record<string, unknown>;
};

const r4 = (x: number | null | undefined) => rnd(x, 4);

function ratioYears(st: QuantState) {
  const f = st.bundle.fundamentals;
  if (!f) return [];
  return ratioHistory(f, st.assumptions.statutoryTax).map((r) => ({
    asOf: r.asOf, grossMargin: r4(r.grossMargin), operatingMargin: r4(r.operatingMargin), netMargin: r4(r.netMargin),
    roe: r4(r.roe), roic: r4(r.roic), debtToEquity: r4(r.debtToEquity), fcfToNetIncome: r4(r.fcfToNetIncome),
  }));
}

function revenueGrowthYears(f: Fundamentals | null): { asOf: string; growth: number | null }[] {
  if (!f) return [];
  const rows = f.annual.filter((r) => isNum(r.revenue) && (r.revenue as number) > 0);
  return rows.slice(1).map((r, i) => ({ asOf: r.asOf, growth: r4((r.revenue as number) / (rows[i].revenue as number) - 1) }));
}

function officersOf(st: QuantState) {
  return (st.bundle.profile?.officers ?? []).slice(0, 8).map((o) => ({ name: o.name, title: o.title, age: o.age, totalPay: o.totalPay }));
}

function headlinesOf(st: QuantState, n = 20) {
  return st.bundle.news.slice(0, n).map((h) => ({ title: h.title, publisher: h.publisher ?? null, publishedAt: h.publishedAt }));
}

/** The lexicon's read of the headlines, for the news agent to agree or argue with. */
export function newsLexicon(st: QuantState) {
  const b = st.bundle;
  const t = b.news.length ? newsTone(b.news, new Date(b.fetchedAt)) : null;
  return t ? { score: t.score, count: t.count, positive: t.positive, negative: t.negative, neutral: t.neutral, halfLifeDays: t.halfLifeDays } : null;
}

function indexRegime(st: QuantState) {
  const b = st.bundle, ib = b.index?.bars;
  if (!ib) return null;
  const closes = b.weekly.dates.map((d) => closeOnOrBefore(ib, d)).filter((v): v is number => isNum(v) && v > 0);
  const r = closes.length > 60 ? markovSwitching(logReturns(closes)) : null;
  if (!r) return null;
  const v = regimeView(r, b.rf.short.value);
  return { index: b.indexSymbol, current: v.label, probability: r4(v.pNow), bearBelowCash: v.hasBear };
}

/**
 * The Markov fit always splits returns into a higher- and a lower-mean state.
 * Call them bull and bear only when the lower one earns less than cash;
 * otherwise both are up-markets that differ in volatility (calm / turbulent).
 * `a` is bull or calm, `b` bear or turbulent; pNow is P(current label).
 */
function regimeView(r: RegimeReport, rf: number) {
  const [s0, s1] = r.states;
  const bull = s0.label === "bull" ? s0 : s1, bear = s0.label === "bull" ? s1 : s0;
  const ann = (x: { mu: number; sigma: number }) => ({ mu: r4(x.mu * 52), vol: r4(x.sigma * Math.sqrt(52)) });
  if (bear.mu * 52 < rf) {
    return { hasBear: true, label: r.current as string, pNow: r.current === "bull" ? r.probBull : 1 - r.probBull, a: ann(bull), b: ann(bear) };
  }
  const calmIsBull = bull.sigma <= bear.sigma;
  const pCalm = calmIsBull ? r.probBull : 1 - r.probBull;
  return { hasBear: false, label: pCalm >= 0.5 ? "calm" : "turbulent", pNow: Math.max(pCalm, 1 - pCalm), a: ann(calmIsBull ? bull : bear), b: ann(calmIsBull ? bear : bull) };
}

/** Level now and its change over 4 and 13 weeks, per macro factor (percent change for price-like series). */
function macroReadings(st: QuantState) {
  return st.bundle.macro.map((m) => {
    const lv = m.levels;
    let i = lv.length - 1;
    while (i >= 0 && lv[i] == null) i--;
    const now = i >= 0 ? (lv[i] as number) : null;
    const chg = (k: number) => {
      const then = i - k >= 0 ? lv[i - k] : null;
      if (now == null || then == null) return null;
      return m.transform === "logret" ? r4((now / then - 1) * 100) : r4(now - then);
    };
    return { name: m.name, latest: r4(now), asOf: i >= 0 ? st.bundle.weekly.dates[i] ?? null : null, change4w: chg(4), change13w: chg(13), changeUnits: m.transform === "logret" ? "%" : "level points" };
  });
}

/** Everything one qualitative agent may look at: numbers in `facts`, vendor text in `untrusted`. */
export function qualitativeFacts(st: QuantState, slug: string): QualFacts {
  const b = st.bundle, p = b.profile, f = b.fundamentals;
  const base = { ticker: b.ticker, market: b.market, name: p?.name ?? null, sector: b.sector, industry: p?.industry ?? null, financial: b.financial, asOf: b.asOf };
  const scr = st.screen;
  const sum = (s: string) => st.results[s]?.summary ?? null;
  switch (slug) {
    case "moat-analyst":
      return {
        facts: {
          ...base,
          marketCap: st.snapshot?.marketCap ?? p?.marketCap ?? null,
          ratiosByYear: ratioYears(st),
          revenueGrowthByYear: revenueGrowthYears(f),
          peerPercentiles: scr?.peerPercentiles ?? null,
          multiplesVsPeers: (st.relativeRows ?? []).map((r) => ({ multiple: r.multiple, own: r4(r.own), peerMedian: r4(r.peerMedian), premiumToPeersPct: r4(r.premiumToPeersPct) })),
          screen: sum("fundamentals-screener"),
        },
        untrusted: { businessDescription: p?.description ?? null },
      };
    case "management-analyst": {
      const ed = p?.earnings.length ? earningsDelivery(p.earnings) : null;
      return {
        facts: {
          ...base,
          reportingCurrency: f?.currency ?? null,
          capitalAllocationByYear: (f?.annual ?? []).slice(-5).map((r) => ({ asOf: r.asOf, cfo: r.cfo ?? null, capex: r.capex ?? null, fcf: r.fcf ?? null, buybacks: r.buybacks ?? null, dividendsPaid: r.dividendsPaid ?? null, dilutedShares: r.dilutedShares ?? null, netIncome: r.netIncome ?? null })),
          ratiosByYear: ratioYears(st),
          insiderOwnershipPct: r4(p?.heldPctInsiders),
          insiderTrades: b.insiders ? { buys: b.insiders.buys, sells: b.insiders.sells, period: b.insiders.period, source: b.insiders.source } : null,
          earningsDelivery: ed ? { quarters: ed.quarters, beatRate: r4(ed.beatRate), medianSurprisePct: r4(ed.medianSurprisePct), lastSurprisePct: r4(ed.lastSurprisePct) } : null,
          piotroski: scr?.piotroski ? { score: scr.piotroski.score, available: scr.piotroski.available } : null,
        },
        untrusted: { officers: officersOf(st), recentInsiderTrades: (b.insiders?.trades ?? []).slice(0, 10) },
      };
    }
    case "governance-analyst": {
      const fr = st.results["forensic-accountant"]?.data as { beneish?: { m: number; flagged: boolean } | null; accrualsRatio?: number | null; flags?: string[] } | null | undefined;
      return {
        facts: {
          ...base,
          issGovernance: p?.governance ?? null,
          issScale: "ISS QualityScore deciles: 1 = lowest governance risk, 10 = highest",
          insiderOwnershipPct: r4(p?.heldPctInsiders),
          institutionalOwnershipPct: r4(p?.heldPctInstitutions),
          forensic: fr ? { beneishM: r4(fr.beneish?.m), beneishFlagged: fr.beneish?.flagged ?? null, accrualsRatio: r4(fr.accrualsRatio), flags: fr.flags ?? [] } : null,
          dataGaps: ["no board-independence, related-party or auditor data feed: judge only from what is here"],
        },
        untrusted: { officers: officersOf(st) },
      };
    }
    case "industry-analyst": {
      const peers = b.peers.filter((x) => x.fundamentals).map((x) => {
        const pf = x.fundamentals as Fundamentals;
        const h = ratioHistory(pf, st.assumptions.statutoryTax);
        return { ticker: x.ticker, revenueCagr3y: r4(revenueCagr(pf, 3)), operatingMargin: r4(h.length ? h[h.length - 1].operatingMargin : null) };
      });
      const gs = revenueGrowthYears(f).map((g) => g.growth).filter(isNum);
      return {
        facts: {
          ...base,
          revenueCagr3y: r4(f ? revenueCagr(f, 3) : null),
          revenueGrowthByYear: revenueGrowthYears(f),
          revenueGrowthVolatility: gs.length >= 3 ? r4(std(gs)) : null,
          downYears: gs.filter((g) => g < 0).length,
          peers,
          peerMedianRevenueCagr3y: r4(median(peers.map((x) => x.revenueCagr3y).filter(isNum))),
          beta: r4(st.risk?.beta ?? p?.beta),
          marketRegime: indexRegime(st),
        },
        untrusted: { businessDescription: p?.description ?? null },
      };
    }
    case "regulatory-esg-analyst":
      return {
        facts: { ...base, country: p?.country ?? null, employees: p?.employees ?? null, issOverall: p?.governance?.overall ?? null, dataGaps: ["no vendor ESG scores: judge exposure from the business mix and disclosures"] },
        untrusted: { businessDescription: p?.description ?? null, headlines: headlinesOf(st, 15), filingExcerpt: b.filingExcerpt ? b.filingExcerpt.slice(0, 4000) : null },
      };
    case "macro-strategist":
      return {
        facts: {
          market: b.market,
          riskFree: { short: b.rf.short, long: b.rf.long },
          factors: macroReadings(st),
          tiltNames: b.macro.map((m) => m.name),
          context: b.macroContext,
        },
        untrusted: {},
      };
    case "news-sentiment-analyst": {
      const sd = st.results["sentiment-analyst"]?.data as { revisions?: unknown; shortInterest?: unknown } | null | undefined;
      return {
        facts: {
          ...base,
          lexicon: newsLexicon(st),
          revisions: sd?.revisions ?? null,
          shortInterest: sd?.shortInterest ?? null,
          analyst: p ? { targetMean: p.analyst.targetMean, count: p.analyst.count, recommendation: p.analyst.recommendationKey } : null,
          nextEarningsDate: p?.nextEarningsDate ?? null,
        },
        untrusted: { headlines: headlinesOf(st, 20) },
      };
    }
    default:
      return { facts: base, untrusted: {} };
  }
}

/** Accept the strategist's per-factor view as numbers or words; anything else is neutral. */
export function normalizeTilts(raw: unknown, names: readonly string[]): Record<string, -1 | 0 | 1> {
  const out: Record<string, -1 | 0 | 1> = {};
  const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const lower = new Map(Object.entries(obj).map(([k, v]) => [k.trim().toLowerCase(), v] as const));
  for (const n of names) {
    const v = lower.get(n.toLowerCase());
    let t: -1 | 0 | 1 = 0;
    if (isNum(v)) t = v > 0 ? 1 : v < 0 ? -1 : 0;
    else if (typeof v === "string") {
      const s = v.trim().toLowerCase();
      if (/^(\+|up|rise|rising|higher|widen|widening|steepen|steepening|strengthen|stronger)/.test(s)) t = 1;
      else if (/^(-|−|down|fall|falling|lower|tighten|tightening|narrow|flatten|flattening|weaken|weaker)/.test(s)) t = -1;
    }
    out[n] = t;
  }
  return out;
}

/** An LLM's score, clamped to −100…100; null when it gave none. */
export function llmScore(x: unknown): number | null {
  const v = typeof x === "string" ? Number(x.trim()) : x;
  return isNum(v) ? Math.round(clamp(v, -100, 100)) : null;
}

// ── Hand-off to the existing desk nodes ─────────────────────────────────────

/** Worst-case 1-day 95% VaR of a long position: max(GARCH-implied, 3y historical). */
export function dailyVar(st: QuantState): Sourced | null {
  const g = st.garch?.nextDaySigma, h = st.risk?.var95.historical;
  const gv = isNum(g) ? 1.645 * g : null, hv = isNum(h) ? h : null;
  if (gv != null && (hv == null || gv >= hv)) return { value: gv, source: `GARCH(1,1) next-day σ ${pc(g, 2)} × 1.645` };
  if (hv != null) return { value: hv, source: "3y historical 1-day VaR95" };
  return null;
}

/**
 * The quant agents' findings as plain lines for the desk's LLM nodes
 * (analyst, critic, valuation, CIO, PM, risk). Every line is computed, so
 * nodes can cite it as [quant:<agent>].
 */
export function factsSheet(st: QuantState, only?: readonly string[]): string {
  const b = st.bundle;
  const L: string[] = [`Quant facts for ${b.ticker} (${b.market}${b.financial ? ", financial" : ""}), computed in code from market data through ${b.asOf ?? "n/a"}. Cite as [quant:<agent>].`];
  if (b.price) L.push(`[quant:market-data-reader] price ${money(st, b.price.value)} (${b.price.source})`);
  const s = st.snapshot;
  if (s) L.push(`[quant:market-data-reader] market cap ${big(s.marketCap)}, EV ${big(s.ev)}, net debt ${big(s.netDebt)}, ${big(s.shares)} shares (listing currency)`);
  if (st.blend) {
    const bl = st.blend;
    L.push(`[quant:valuation-blend] fair value ${money(st, bl.fairValueLow)}–${money(st, bl.fairValueHigh)} (mid ${money(st, bl.fairValueMid)}), upside ${sgn(bl.impliedUpsidePct)}% → ${bl.verdict}; ${bl.method}`);
  }
  const dv = dailyVar(st);
  if (dv) L.push(`[quant:risk] 1-day VaR95 of the position's price ${pc(dv.value, 2)} (${dv.source})`);
  for (const spec of QUANT_AGENTS) {
    if (only && !only.includes(spec.slug)) continue;
    const r = st.results[spec.slug];
    if (!r || r.skipped || spec.slug === "market-data-reader") continue;
    L.push(`[quant:${spec.slug}] ${r.summary}${r.score != null ? ` (score ${sgn(r.score, 0)})` : ""}`);
  }
  const gaps = Object.entries(b.coverage).filter(([, v]) => v.startsWith("missing")).map(([k]) => k);
  if (gaps.length) L.push(`Data gaps: ${gaps.join(", ")}.`);
  return L.join("\n");
}

/** One quant_reports row as a desk cycle reads it back. */
export type StoredReport = { agent: string; score: number | null; summary: string };

/**
 * factsSheet for a sweep read back from quant_reports, when a desk cycle runs
 * without the live stage: the same lines in roster order, built from the stored
 * summaries and the ensemble's payload.
 */
export function storedFactsSheet(i: {
  ticker: string; market: "US" | "IN"; runAt: string; price: number | null; currency: string | null;
  blend: BlendResult | null; dailyVar: Sourced | null; reports: readonly StoredReport[];
}): string {
  const sym = symbolFor(i.currency ?? (i.market === "IN" ? "INR" : "USD"));
  const L: string[] = [`Quant facts for ${i.ticker} (${i.market}), computed in code by the quant sweep at ${i.runAt.slice(0, 16).replace("T", " ")} UTC. Cite as [quant:<agent>].`];
  if (isNum(i.price)) L.push(`[quant:market-data-reader] price ${moneyIn(sym, i.price)} (at the sweep)`);
  const bl = i.blend;
  if (bl) {
    L.push(`[quant:valuation-blend] fair value ${moneyIn(sym, bl.fairValueLow)}–${moneyIn(sym, bl.fairValueHigh)} (mid ${moneyIn(sym, bl.fairValueMid)}), upside ${sgn(bl.impliedUpsidePct)}% → ${bl.verdict}; ${bl.method}`);
  }
  if (i.dailyVar && isNum(i.dailyVar.value)) L.push(`[quant:risk] 1-day VaR95 of the position's price ${pc(i.dailyVar.value, 2)} (${i.dailyVar.source})`);
  const bySlug = new Map(i.reports.map((r) => [r.agent, r]));
  for (const spec of QUANT_AGENTS) {
    const r = bySlug.get(spec.slug);
    if (!r || spec.slug === "market-data-reader" || r.summary.startsWith("skipped:")) continue;
    L.push(`[quant:${spec.slug}] ${r.summary}${r.score != null ? ` (score ${sgn(r.score, 0)})` : ""}`);
  }
  return L.join("\n");
}

// ── Payload compaction ──────────────────────────────────────────────────────

function sig(x: number): number {
  return Number.isInteger(x) && Math.abs(x) < 1e15 ? x : Number(x.toPrecision(4));
}

function shrink(v: unknown, cap: number, depth: number, maxDepth = 8): unknown {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? sig(v) : null;
  if (typeof v === "string") return v.length > 500 ? `${v.slice(0, 500)}…` : v;
  if (typeof v === "boolean") return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v !== "object") return undefined;
  if (depth > maxDepth) return "…";
  if (v instanceof Map) return shrink(Object.fromEntries(v), cap, depth, maxDepth);
  if (ArrayBuffer.isView(v) && !(v instanceof DataView)) return shrink(Array.from(v as unknown as ArrayLike<number>), cap, depth, maxDepth);
  if (Array.isArray(v)) {
    const numeric = v.every((x) => typeof x === "number");
    // Numeric series keep their newest values; lists of objects keep their head (they are ranked).
    const kept = v.length <= cap ? v : numeric ? v.slice(-cap) : v.slice(0, cap);
    const out = kept.map((x) => shrink(x, cap, depth + 1, maxDepth));
    if (v.length > cap) {
      if (numeric) out.unshift(`… ${v.length - cap} earlier`);
      else out.push(`… ${v.length - cap} more`);
    }
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    const s = shrink(x, cap, depth + 1, maxDepth);
    if (s !== undefined) out[k] = s;
  }
  return out;
}

/** JSON-safe copy of an agent payload within `maxChars`: 4 significant digits, shorter arrays, then a preview. */
export function compact(value: unknown, maxChars = 4000): unknown {
  let last = "";
  for (const [cap, depth] of [[60, 8], [20, 8], [5, 8], [5, 4], [3, 3], [3, 2]]) {
    const v = shrink(value, cap, 0, depth);
    last = JSON.stringify(v) ?? "null";
    if (last.length <= maxChars) return v;
  }
  // The preview is re-escaped inside JSON, so trim until the wrapper fits.
  let n = Math.max(0, maxChars - 40);
  for (;;) {
    const out = { truncated: true, preview: last.slice(0, n) };
    if (n === 0 || JSON.stringify(out).length <= maxChars) return out;
    n = Math.floor(n * 0.9);
  }
}
