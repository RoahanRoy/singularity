/**
 * Sentiment: lexicon NLP on news and earnings-call text, plus the measurable
 * crowd signals — analyst revisions, insider buying, short interest — and the
 * earnings delivery record (actual vs consensus).
 *
 * The word lists are finance-specific, in the spirit of Loughran & McDonald
 * (2011): general-purpose dictionaries misread filings and headlines, where
 * "liability", "tax", "cost" or "capital" carry no tone. A negator within the
 * three words before a tone word flips it ("not strong", "no losses").
 * Lexicons are crude — sarcasm, context and numbers are invisible to them —
 * so this is a small-weight input, cross-checked by the LLM news reader.
 */

import { clamp, isNum, mean, median } from "./stats";

const words = (s: string) => new Set(s.trim().split(/\s+/));

export const POSITIVE = words(`
  accelerate accelerated accelerating accomplish accomplished achieve achieved achievement achievements advance advanced
  advances advantage advantages attractive beat beating beats benefit benefited benefits best better bolster bolstered boom
  boost boosted boosts breakthrough bullish confident confidence delight delighted efficiencies efficiency efficient encouraged
  encouraging enhance enhanced enthusiasm excellent exceed exceeded exceeding exceeds exceptional expand expanded expansion
  favorable favourable gain gained gains good great greater grew grow growing grows growth highest improve improved improvement
  improvements improves improving innovation innovative momentum optimistic optimism outpace outpaced outperform outperformed
  outperforming outperforms positive profitability profitable progress rally rallied rallies rebound rebounded record recover
  recovered recovery resilient resilience reward rewarding robust rose soar soared soaring soars solid strength strengthen
  strengthened strengths strong stronger strongest succeed succeeded success successes successful successfully superior surge surged
  surges surging surpass surpassed tailwind tailwinds topped tops unmatched upbeat upgrade upgraded upgrades upside upturn win
  winning wins won
`);

export const NEGATIVE = words(`
  adverse adversely allegation allegations alleged antitrust bankrupt bankruptcy bearish breach breached breaches challenging
  closure closures collapse collapsed concern concerned concerns contraction crash crashes crisis cut cuts cutting damage damaged
  decline declined declines declining decreased default defaulted defaults deficit delay delayed delays delinquencies delinquent
  deteriorate deteriorated deteriorating deterioration difficult difficulties difficulty disappoint disappointed disappointing
  disappointment dispute disputes downgrade downgraded downgrades downside downturn drop dropped drops fail failed failing fails
  failure fall fallen falling falls fell fined fines fraud fraudulent halt halted headwind headwinds impair impaired impairment
  impairments investigation investigations lawsuit lawsuits layoff layoffs litigation lose losing loss losses lost lowered miss
  missed misses negative negatively nonperforming penalties penalty plunge plunged plunges plunging probe probes problem problems
  recall recalled recalls recession resign resigned resignation restate restated restatement sank scandal selloff shortfall
  shortfalls shrank shrink shrinking sink sinks slash slashed slashes slow slowdown slowed slower slowing slump slumped slumps
  subpoena sue sued suspend suspended suspension tumble tumbled tumbles turmoil underperform underperformed underperforming
  underperforms unfavorable unfavourable violation violations warn warned warning warnings warns weak weaken weakened weaker
  weakness worse worsen worsened worsening worst writedown writedowns writeoff writeoffs
`);

export const UNCERTAINTY = words(`
  ambiguity ambiguous appear appears approximate approximately assume assumed assumes assumption assumptions cautious contingency
  contingent could depend depends dependent doubt doubtful doubts exposure fluctuate fluctuating fluctuation fluctuations imprecise
  indefinite likelihood maybe might perhaps possible possibly preliminary probable probably risk risks risky roughly speculative
  tentative uncertain uncertainties uncertainty unclear unknown unknowns unpredictable unproven unsure variability variable volatile
  volatility whether
`);

const NEGATORS = words("not no never without neither nor cannot none");
const isNegator = (w: string) => NEGATORS.has(w) || w.endsWith("n't");

/** Lowercase words; hyphenated compounds are joined ("write-off" → "writeoff"), apostrophes inside words kept. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/([a-z])-(?=[a-z])/g, "$1")
    .split(/[^a-z']+/)
    .map((w) => w.replace(/^'+|'+$/g, ""))
    .filter(Boolean);
}

/** Plurals whose singular is a tone word but which carry no tone themselves ("consumer goods", "company records"). */
const PLURAL_EXCEPTIONS = words("goods records");

/** Exact match, else the singular of a plural. */
const lookup = (set: Set<string>, w: string) =>
  set.has(w) || (w.length > 3 && w.endsWith("s") && !PLURAL_EXCEPTIONS.has(w) && set.has(w.slice(0, -1)));

export type ToneHit = { word: string; polarity: "positive" | "negative"; negated: boolean };

export type Tone = {
  tokens: number;
  positive: number;
  negative: number;
  uncertainty: number;
  /** (pos − neg) / (pos + neg + 1): −1…1, shrunk toward 0 when few tone words appear. */
  net: number;
  uncertaintyShare: number;
  hits: ToneHit[];
};

export function tone(text: string): Tone {
  const toks = tokenize(text);
  let pos = 0, neg = 0, unc = 0;
  const hits: ToneHit[] = [];
  toks.forEach((w, i) => {
    if (lookup(UNCERTAINTY, w)) unc++;
    const p = lookup(POSITIVE, w), n = !p && lookup(NEGATIVE, w);
    if (!p && !n) return;
    const negated = toks.slice(Math.max(0, i - 3), i).some(isNegator);
    const positive = p !== negated;
    if (positive) pos++; else neg++;
    hits.push({ word: w, polarity: positive ? "positive" : "negative", negated });
  });
  return {
    tokens: toks.length,
    positive: pos,
    negative: neg,
    uncertainty: unc,
    net: (pos - neg) / (pos + neg + 1),
    uncertaintyShare: toks.length ? unc / toks.length : 0,
    hits,
  };
}

// ── News flow ───────────────────────────────────────────────────────────────

export type Headline = { title: string; publishedAt: string; publisher?: string; summary?: string };

export type NewsTone = {
  count: number;
  /** Recency-weighted mean net tone, shrunk by two neutral pseudo-headlines. */
  score: number;
  positive: number;
  negative: number;
  neutral: number;
  halfLifeDays: number;
  items: { title: string; publishedAt: string; publisher?: string; net: number; hits: string[] }[];
};

const DAY_MS = 86_400_000;

/**
 * Recency-weighted tone of recent headlines (half-life 7 days, nothing older
 * than 30). Duplicate titles count once. Null with no usable headline.
 */
export function newsTone(items: readonly Headline[], asOf: Date, opts: { halfLifeDays?: number; maxAgeDays?: number; pseudo?: number } = {}): NewsTone | null {
  const hl = opts.halfLifeDays ?? 7, maxAge = opts.maxAgeDays ?? 30, pseudo = opts.pseudo ?? 2;
  const seen = new Set<string>();
  const scored: { item: NewsTone["items"][number]; t: number; w: number }[] = [];
  for (const h of items) {
    const key = tokenize(h.title).join(" ");
    const t = Date.parse(h.publishedAt);
    if (!key || seen.has(key) || !Number.isFinite(t)) continue;
    const age = (asOf.getTime() - t) / DAY_MS;
    if (age > maxAge || age < -1) continue;
    seen.add(key);
    const tn = tone(`${h.title}. ${h.summary ?? ""}`);
    const item = {
      title: h.title, publishedAt: h.publishedAt, ...(h.publisher ? { publisher: h.publisher } : {}),
      net: tn.net, hits: tn.hits.map((x) => `${x.negated ? "¬" : ""}${x.word}${x.polarity === "positive" ? "+" : "−"}`),
    };
    scored.push({ item, t, w: 0.5 ** (Math.max(0, age) / hl) });
  }
  if (!scored.length) return null;
  const W = scored.reduce((a, s) => a + s.w, 0);
  const S = scored.reduce((a, s) => a + s.w * s.item.net, 0);
  scored.sort((a, b) => b.t - a.t);
  return {
    count: scored.length,
    score: Math.round((100 * S) / (W + pseudo)),
    positive: scored.filter((s) => s.item.net > 0).length,
    negative: scored.filter((s) => s.item.net < 0).length,
    neutral: scored.filter((s) => s.item.net === 0).length,
    halfLifeDays: hl,
    items: scored.slice(0, 12).map((s) => s.item),
  };
}

// ── Analyst revisions ───────────────────────────────────────────────────────

/**
 * Yahoo grades: action "up" | "down" | "init" | "main" (maintained) | "reit"
 * (reiterated). Most notes keep the rating but move the price target, so the
 * target's direction is its own signal.
 */
export type RatingChange = { date: string; firm: string; action: string; from?: string; to?: string; priceTarget?: "raise" | "lower" | null };
export type EpsTrend = { current: number; d30?: number; d90?: number };
export type RevisionsInput = { ratingChanges: readonly RatingChange[]; epsTrend?: EpsTrend | null; epsRevisions?: { up30: number; down30: number } | null };

export type RevisionsResult = {
  score: number;
  upgrades: number;
  downgrades: number;
  targetRaises: number;
  targetCuts: number;
  /** % change in the current-year consensus EPS over 90 (else 30) days. */
  epsDriftPct: number | null;
  epsUp30: number | null;
  epsDown30: number | null;
  parts: { name: string; score: number }[];
};

/**
 * Rating changes and price-target moves in the last 90 days (each up − down,
 * shrunk by two) and the drift in consensus EPS: estimates that keep rising
 * predict returns better than the rating itself. Null with none of them.
 */
export function revisionsScore(r: RevisionsInput, asOf: Date, windowDays = 90): RevisionsResult | null {
  const recent = r.ratingChanges.filter((c) => {
    const t = Date.parse(c.date);
    return Number.isFinite(t) && (asOf.getTime() - t) / DAY_MS <= windowDays && t <= asOf.getTime() + DAY_MS;
  });
  const ups = recent.filter((c) => c.action === "up").length, downs = recent.filter((c) => c.action === "down").length;
  const raises = recent.filter((c) => c.priceTarget === "raise").length, cuts = recent.filter((c) => c.priceTarget === "lower").length;
  const parts: { name: string; score: number }[] = [];
  if (recent.length) parts.push({ name: "rating changes", score: Math.round((100 * (ups - downs)) / (ups + downs + 2)) });
  if (raises + cuts > 0) parts.push({ name: "price targets", score: Math.round((100 * (raises - cuts)) / (raises + cuts + 2)) });
  const e = r.epsTrend;
  const base = e ? (isNum(e.d90) ? e.d90 : isNum(e.d30) ? e.d30 : undefined) : undefined;
  const drift = e && isNum(e.current) && isNum(base) && Math.abs(base) > 1e-9 ? ((e.current - base) / Math.abs(base)) * 100 : null;
  if (drift != null) parts.push({ name: "EPS estimate drift", score: Math.round(100 * Math.tanh(drift / 5)) });
  const rv = r.epsRevisions;
  if (rv && rv.up30 + rv.down30 > 0) parts.push({ name: "EPS revisions (30 days)", score: Math.round((100 * (rv.up30 - rv.down30)) / (rv.up30 + rv.down30 + 2)) });
  if (!parts.length) return null;
  return {
    score: Math.round(mean(parts.map((p) => p.score))),
    upgrades: ups, downgrades: downs,
    targetRaises: raises, targetCuts: cuts,
    epsDriftPct: drift,
    epsUp30: rv?.up30 ?? null, epsDown30: rv?.down30 ?? null,
    parts,
  };
}

// ── Insiders and short interest ─────────────────────────────────────────────

export type InsiderInput = { buys: number; sells: number; netShares?: number | null; netPctHeld?: number | null; period: string; source: string };

/**
 * Insider buying is informative; selling mostly isn't (diversification,
 * planned 10b5-1 sales, tax), so a sale counts a quarter of a purchase.
 */
export function insiderScore(i: InsiderInput): { score: number; buys: number; sells: number; period: string; source: string } | null {
  if (!(i.buys + i.sells > 0)) return null;
  const s = (i.buys - 0.25 * i.sells) / (i.buys + 0.25 * i.sells + 2);
  return { score: Math.round(100 * clamp(s, -1, 1)), buys: i.buys, sells: i.sells, period: i.period, source: i.source };
}

export type ShortInterestInput = { pctFloat: number | null; daysToCover?: number | null; priorShares?: number | null; shares?: number | null; asOf?: string | null };

/**
 * Heavy short interest predicts lower returns: nothing below 5% of float,
 * −100 at 20% or more. Short interest that rose over the month adds a little.
 */
export function shortInterestScore(s: ShortInterestInput): { score: number; pctFloat: number; daysToCover: number | null; changePct: number | null; asOf: string | null } | null {
  if (!isNum(s.pctFloat)) return null;
  const change = isNum(s.shares) && isNum(s.priorShares) && s.priorShares > 0 ? (s.shares / s.priorShares - 1) * 100 : null;
  const level = -clamp((s.pctFloat - 0.05) / 0.15, 0, 1);
  const trend = change != null && s.pctFloat > 0.03 ? -0.2 * Math.tanh(change / 25) : 0;
  return {
    score: Math.round(100 * clamp(level + trend, -1, 1)),
    pctFloat: s.pctFloat, daysToCover: s.daysToCover ?? null, changePct: change, asOf: s.asOf ?? null,
  };
}

/** News 35%, revisions 30%, insiders 20%, short interest 15%, renormalized over what's available. */
export function sentimentComposite(parts: { news?: number | null; revisions?: number | null; insiders?: number | null; shortInterest?: number | null }) {
  const w = { news: 0.35, revisions: 0.3, insiders: 0.2, shortInterest: 0.15 } as const;
  const comps = (Object.keys(w) as (keyof typeof w)[])
    .filter((k) => isNum(parts[k]))
    .map((k) => ({ name: k, score: parts[k] as number, weight: w[k] }));
  if (!comps.length) return null;
  const W = comps.reduce((a, c) => a + c.weight, 0);
  return { score: Math.round(comps.reduce((a, c) => a + c.weight * c.score, 0) / W), components: comps.map((c) => ({ ...c, weight: c.weight / W })) };
}

// ── Earnings delivery and call tone ─────────────────────────────────────────

export type EarningsQuarter = { date: string; actual: number; estimate: number };

export type EarningsDelivery = {
  quarters: number;
  beatRate: number;
  /** Median of (actual − estimate) / |estimate|, %. */
  medianSurprisePct: number;
  lastSurprisePct: number;
  lastDate: string;
  baseRate: number;
  score: number;
  history: (EarningsQuarter & { surprisePct: number })[];
};

/**
 * Earnings delivery record (actual vs consensus) over the last four quarters.
 * Consensus is set to be beaten — about three in four S&P 500 companies beat
 * in a typical quarter — so the beat record is scored against a 70% base rate
 * (a slightly lenient bar), not a coin flip. The latest surprise carries more
 * weight: post-earnings drift follows the newest news.
 */
export function earningsDelivery(history: readonly EarningsQuarter[], opts: { baseRate?: number; quarters?: number } = {}): EarningsDelivery | null {
  const base = opts.baseRate ?? 0.7, nq = opts.quarters ?? 4;
  const rows = history
    .filter((q) => isNum(q.actual) && isNum(q.estimate) && Math.abs(q.estimate) > 1e-9 && q.date)
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .slice(-nq)
    .map((q) => ({ ...q, surprisePct: ((q.actual - q.estimate) / Math.abs(q.estimate)) * 100 }));
  if (!rows.length) return null;
  const beatRate = rows.filter((q) => q.actual > q.estimate).length / rows.length;
  const last = rows[rows.length - 1];
  const record = clamp((beatRate - base) / (1 - base), -1, 1);
  const lastS = clamp(last.surprisePct / 10, -1, 1);
  return {
    quarters: rows.length,
    beatRate,
    medianSurprisePct: median(rows.map((q) => q.surprisePct)),
    lastSurprisePct: last.surprisePct,
    lastDate: last.date,
    baseRate: base,
    score: Math.round(100 * (0.6 * lastS + 0.4 * record)),
    history: rows,
  };
}

export type CallTone = Tone & { score: number };

/**
 * Tone of an earnings-call transcript or release. Management speech leans
 * positive, so only net tone beyond +0.2 counts as good news, and hedging
 * counts against it: uncertainty words beyond 2% of the text cost up to half
 * the scale, reached at 4%.
 */
export function callTone(text: string): CallTone | null {
  const t = tone(text);
  if (t.tokens < 50) return null;
  const s = clamp((t.net - 0.2) / 0.4, -1, 1) - clamp((t.uncertaintyShare - 0.02) / 0.04, 0, 0.5);
  return { ...t, hits: t.hits.slice(0, 40), score: Math.round(100 * clamp(s, -1, 1)) };
}
