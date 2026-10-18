/**
 * Quantitative fundamentals: profitability, DuPont, liquidity, leverage,
 * efficiency, growth and cash quality ratios, plus the Piotroski F, Altman Z
 * and Beneish M scores. Ratios use average balances where the textbook does.
 */

import { isNum, median, percentileOf } from "./stats";
import type { FinRow, Fundamentals } from "./types";

const div = (a: number | undefined, b: number | undefined): number | null =>
  isNum(a) && isNum(b) && b !== 0 ? a / b : null;
const avg = (a: number | undefined, b: number | undefined): number | undefined =>
  isNum(a) ? (isNum(b) ? (a + b) / 2 : a) : undefined;

/** CAGR = (End/Start)^(1/n) − 1; null unless both ends are positive. */
export function cagr(start: number | undefined, end: number | undefined, years: number): number | null {
  if (!isNum(start) || !isNum(end) || start <= 0 || end <= 0 || years <= 0) return null;
  return Math.pow(end / start, 1 / years) - 1;
}

export type DuPont = { netMargin: number; assetTurnover: number; equityMultiplier: number; roe: number };

export type RatioSet = {
  asOf: string;
  grossMargin: number | null;
  operatingMargin: number | null;
  netMargin: number | null;
  roe: number | null;
  roa: number | null;
  roic: number | null;
  dupont: DuPont | null;
  currentRatio: number | null;
  quickRatio: number | null;
  debtToEquity: number | null;
  netDebtToEbitda: number | null;
  interestCoverage: number | null;
  dio: number | null;
  dso: number | null;
  dpo: number | null;
  ccc: number | null;
  fcfToNetIncome: number | null;
  /** Sloan accruals = (NI − CFO) / average total assets. High positive = earnings not backed by cash. */
  accrualsRatio: number | null;
};

/** Ratios for fiscal year `cur`, averaging balances with `prev` when given. */
export function ratiosFor(cur: FinRow, prev?: FinRow, taxFallback = 0.21): RatioSet {
  const rev = cur.revenue;
  const cogs = cur.costOfRevenue ?? (isNum(rev) && isNum(cur.grossProfit) ? rev - cur.grossProfit : undefined);
  const gp = cur.grossProfit ?? (isNum(rev) && isNum(cogs) ? rev - cogs : undefined);
  const ebit = cur.ebit ?? cur.operatingIncome;
  const avgTa = avg(cur.totalAssets, prev?.totalAssets);
  const avgEq = avg(cur.equity, prev?.equity);
  const nm = div(cur.netIncome, rev);
  const at = div(rev, avgTa);
  const em = div(avgTa, avgEq);
  const roe = isNum(avgEq) && avgEq > 0 ? div(cur.netIncome, avgEq) : null;

  const tax = isNum(cur.taxProvision) && isNum(cur.pretaxIncome) && cur.pretaxIncome > 0
    ? Math.min(Math.max(cur.taxProvision / cur.pretaxIncome, 0), 0.35)
    : taxFallback;
  const cash = cur.cashAndSti ?? cur.cash;
  const investedCapital = isNum(cur.totalDebt) && isNum(cur.equity) ? cur.totalDebt + cur.equity - (cash ?? 0) : cur.investedCapital;
  const prevIc = prev && isNum(prev.totalDebt) && isNum(prev.equity) ? prev.totalDebt + prev.equity - (prev.cashAndSti ?? prev.cash ?? 0) : undefined;
  const avgIc = avg(investedCapital, prevIc);

  const dio = isNum(cogs) && cogs > 0 && isNum(cur.inventory) ? ((avg(cur.inventory, prev?.inventory) as number) / cogs) * 365 : null;
  const dso = isNum(rev) && rev > 0 && isNum(cur.receivables) ? ((avg(cur.receivables, prev?.receivables) as number) / rev) * 365 : null;
  const dpo = isNum(cogs) && cogs > 0 && isNum(cur.payables) ? ((avg(cur.payables, prev?.payables) as number) / cogs) * 365 : null;
  const fcf = cur.fcf ?? (isNum(cur.cfo) && isNum(cur.capex) ? cur.cfo - cur.capex : undefined);
  const netDebt = isNum(cur.totalDebt) ? cur.totalDebt - (cash ?? 0) : undefined;

  return {
    asOf: cur.asOf,
    grossMargin: div(gp, rev),
    operatingMargin: div(ebit, rev),
    netMargin: nm,
    roe,
    roa: div(cur.netIncome, avgTa),
    roic: isNum(ebit) && isNum(avgIc) && avgIc > 0 ? (ebit * (1 - tax)) / avgIc : null,
    dupont: nm != null && at != null && em != null && roe != null ? { netMargin: nm, assetTurnover: at, equityMultiplier: em, roe: nm * at * em } : null,
    currentRatio: div(cur.currentAssets, cur.currentLiabilities),
    quickRatio: isNum(cur.currentAssets) ? div(cur.currentAssets - (cur.inventory ?? 0), cur.currentLiabilities) : null,
    debtToEquity: isNum(cur.equity) && cur.equity > 0 ? div(cur.totalDebt, cur.equity) : null,
    netDebtToEbitda: isNum(cur.ebitda) && cur.ebitda > 0 ? div(netDebt, cur.ebitda) : null,
    interestCoverage: isNum(cur.interestExpense) && cur.interestExpense > 0 ? div(ebit, cur.interestExpense) : null,
    dio, dso, dpo,
    ccc: dio != null && dso != null && dpo != null ? dio + dso - dpo : null,
    fcfToNetIncome: isNum(cur.netIncome) && cur.netIncome > 0 ? div(fcf, cur.netIncome) : null,
    accrualsRatio: isNum(cur.netIncome) && isNum(cur.cfo) && isNum(avgTa) && avgTa > 0 ? (cur.netIncome - cur.cfo) / avgTa : null,
  };
}

/** One RatioSet per fiscal year, oldest → newest. */
export function ratioHistory(f: Fundamentals, taxFallback = 0.21): RatioSet[] {
  return f.annual.map((r, i) => ratiosFor(r, i > 0 ? f.annual[i - 1] : undefined, taxFallback));
}

export type GrowthSet = { years: number; revenueCagr: number | null; netIncomeCagr: number | null; epsCagr: number | null; fcfCagr: number | null };

export function growth(f: Fundamentals, maxYears = 3): GrowthSet {
  const a = f.annual;
  const n = Math.min(maxYears, a.length - 1);
  if (n < 1) return { years: 0, revenueCagr: null, netIncomeCagr: null, epsCagr: null, fcfCagr: null };
  const s = a[a.length - 1 - n], e = a[a.length - 1];
  const fcf = (r: FinRow) => r.fcf ?? (isNum(r.cfo) && isNum(r.capex) ? r.cfo - r.capex : undefined);
  return {
    years: n,
    revenueCagr: cagr(s.revenue, e.revenue, n),
    netIncomeCagr: cagr(s.netIncome, e.netIncome, n),
    epsCagr: cagr(s.dilutedEps, e.dilutedEps, n),
    fcfCagr: cagr(fcf(s), fcf(e), n),
  };
}

// ── Piotroski F-score ───────────────────────────────────────────────────────

export type ScoreSignal = { name: string; value: 0 | 1 | null; detail?: string };
export type Piotroski = { score: number; available: number; signals: ScoreSignal[] };

/**
 * Piotroski (2000) nine binary signals on the latest fiscal year vs the prior
 * one. Signals whose inputs are missing are reported as null, not as 0, and
 * `available` says how many of the nine could be computed.
 */
export function piotroski(f: Fundamentals): Piotroski | null {
  const a = f.annual;
  if (a.length < 2) return null;
  const t = a[a.length - 1], p = a[a.length - 2], pp = a.length >= 3 ? a[a.length - 3] : undefined;
  const bit = (cond: boolean | null): 0 | 1 | null => (cond == null ? null : cond ? 1 : 0);
  const roaT = div(t.netIncome, p.totalAssets);
  const roaP = pp ? div(p.netIncome, pp.totalAssets) : div(p.netIncome, p.totalAssets);
  const cfoT = div(t.cfo, p.totalAssets);
  const levT = div(t.longTermDebt ?? 0, t.totalAssets);
  const levP = div(p.longTermDebt ?? 0, p.totalAssets);
  const crT = div(t.currentAssets, t.currentLiabilities);
  const crP = div(p.currentAssets, p.currentLiabilities);
  const shT = t.sharesOutstanding ?? t.dilutedShares;
  const shP = p.sharesOutstanding ?? p.dilutedShares;
  const gm = (r: FinRow) => div(r.grossProfit ?? (isNum(r.revenue) && isNum(r.costOfRevenue) ? r.revenue - r.costOfRevenue : undefined), r.revenue);
  const atT = div(t.revenue, p.totalAssets);
  const atP = pp ? div(p.revenue, pp.totalAssets) : div(p.revenue, p.totalAssets);
  const gmT = gm(t), gmP = gm(p);
  const signals: ScoreSignal[] = [
    { name: "ROA > 0", value: bit(roaT == null ? null : roaT > 0) },
    { name: "Operating cash flow > 0", value: bit(isNum(t.cfo) ? t.cfo > 0 : null) },
    { name: "ROA improving", value: bit(roaT == null || roaP == null ? null : roaT > roaP) },
    { name: "Cash flow exceeds earnings (low accruals)", value: bit(cfoT == null || roaT == null ? null : cfoT > roaT) },
    { name: "Long-term leverage falling", value: bit(levT == null || levP == null ? null : levT <= levP) },
    { name: "Current ratio improving", value: bit(crT == null || crP == null ? null : crT > crP) },
    { name: "No share dilution", value: bit(isNum(shT) && isNum(shP) ? shT <= shP * 1.005 : null) },
    { name: "Gross margin improving", value: bit(gmT == null || gmP == null ? null : gmT > gmP) },
    { name: "Asset turnover improving", value: bit(atT == null || atP == null ? null : atT > atP) },
  ];
  const avail = signals.filter((s) => s.value != null);
  return { score: avail.reduce((s, x) => s + (x.value as number), 0), available: avail.length, signals };
}

// ── Altman Z-score ──────────────────────────────────────────────────────────

export type AltmanZone = "distress" | "grey" | "safe";
export type Altman = { z: number; zone: AltmanZone; components: Record<string, number> };

/**
 * Original Altman (1968) Z for public manufacturers:
 * Z = 1.2·(WC/TA) + 1.4·(RE/TA) + 3.3·(EBIT/TA) + 0.6·(MVE/TL) + 1.0·(Sales/TA).
 * Below 1.8 = distress, 1.8–3.0 grey, above 3.0 safe. Not meaningful for financials.
 */
export function altmanZ(r: FinRow, marketCap: number): Altman | null {
  const ta = r.totalAssets;
  if (!isNum(ta) || ta <= 0 || !isNum(r.totalLiabilities) || r.totalLiabilities <= 0) return null;
  const wc = r.workingCapital ?? (isNum(r.currentAssets) && isNum(r.currentLiabilities) ? r.currentAssets - r.currentLiabilities : undefined);
  const ebit = r.ebit ?? r.operatingIncome;
  if (!isNum(wc) || !isNum(r.retainedEarnings) || !isNum(ebit) || !isNum(r.revenue)) return null;
  const c = {
    x1_wc_ta: wc / ta,
    x2_re_ta: r.retainedEarnings / ta,
    x3_ebit_ta: ebit / ta,
    x4_mve_tl: marketCap / r.totalLiabilities,
    x5_sales_ta: r.revenue / ta,
  };
  const z = 1.2 * c.x1_wc_ta + 1.4 * c.x2_re_ta + 3.3 * c.x3_ebit_ta + 0.6 * c.x4_mve_tl + 1.0 * c.x5_sales_ta;
  return { z, zone: z < 1.8 ? "distress" : z < 3 ? "grey" : "safe", components: c };
}

// ── Beneish M-score ─────────────────────────────────────────────────────────

export type Beneish = {
  m: number;
  /** M > −1.78 ⇒ the profile resembles known earnings manipulators. */
  flagged: boolean;
  indices: Record<string, number>;
  /** Indices that could not be computed and were set to their neutral value. */
  imputed: string[];
};

/**
 * Beneish (1999) eight-variable model:
 * M = −4.84 + 0.920·DSRI + 0.528·GMI + 0.404·AQI + 0.892·SGI + 0.115·DEPI − 0.172·SGAI + 4.679·TATA − 0.327·LVGI.
 * Missing indices take their neutral value (1, or 0 for TATA) and are listed in `imputed`.
 */
export function beneishM(t: FinRow, p: FinRow): Beneish | null {
  if (!isNum(t.revenue) || !isNum(p.revenue) || t.revenue <= 0 || p.revenue <= 0) return null;
  const imputed: string[] = [];
  const pick = (name: string, v: number | null, neutral: number) => {
    if (v == null || !Number.isFinite(v)) { imputed.push(name); return neutral; }
    return v;
  };
  const gmOf = (r: FinRow) => div(r.grossProfit ?? (isNum(r.costOfRevenue) ? (r.revenue as number) - r.costOfRevenue : undefined), r.revenue);
  const aq = (r: FinRow) => (isNum(r.currentAssets) && isNum(r.netPpe) && isNum(r.totalAssets) && r.totalAssets > 0 ? 1 - (r.currentAssets + r.netPpe) / r.totalAssets : null);
  const dep = (r: FinRow) => (isNum(r.da) && isNum(r.netPpe) && r.da + r.netPpe > 0 ? r.da / (r.da + r.netPpe) : null);
  const lev = (r: FinRow) => (isNum(r.totalAssets) && r.totalAssets > 0 && isNum(r.currentLiabilities) ? (r.currentLiabilities + (r.longTermDebt ?? 0)) / r.totalAssets : null);
  const ratio = (a: number | null, b: number | null) => (a != null && b != null && b !== 0 ? a / b : null);

  const gmT = gmOf(t), gmP = gmOf(p);
  const aqT = aq(t), aqP = aq(p);
  const idx = {
    DSRI: pick("DSRI", ratio(div(t.receivables, t.revenue), div(p.receivables, p.revenue)), 1),
    GMI: pick("GMI", ratio(gmP, gmT), 1),
    AQI: pick("AQI", aqP != null && aqP > 0.01 ? ratio(aqT, aqP) : null, 1),
    SGI: t.revenue / p.revenue,
    DEPI: pick("DEPI", ratio(dep(p), dep(t)), 1),
    SGAI: pick("SGAI", ratio(div(t.sga, t.revenue), div(p.sga, p.revenue)), 1),
    TATA: pick("TATA", isNum(t.netIncome) && isNum(t.cfo) && isNum(t.totalAssets) && t.totalAssets > 0 ? (t.netIncome - t.cfo) / t.totalAssets : null, 0),
    LVGI: pick("LVGI", ratio(lev(t), lev(p)), 1),
  };
  const m = -4.84 + 0.92 * idx.DSRI + 0.528 * idx.GMI + 0.404 * idx.AQI + 0.892 * idx.SGI + 0.115 * idx.DEPI - 0.172 * idx.SGAI + 4.679 * idx.TATA - 0.327 * idx.LVGI;
  return { m, flagged: m > -1.78, indices: idx, imputed };
}

// ── Screen ──────────────────────────────────────────────────────────────────

export type ScreenVerdict = "pass" | "watch" | "fail" | "insufficient";

export type ScreenResult = {
  verdict: ScreenVerdict;
  /** 0–100 quality composite: mean percentile of the quality ratios vs same-sector peers. */
  qualityScore: number | null;
  redFlags: string[];
  greenFlags: string[];
  latest: RatioSet | null;
  growth: GrowthSet;
  piotroski: Piotroski | null;
  altman: Altman | null;
  peerPercentiles: Record<string, number>;
  coverage: number;
};

/** Ratios where higher is better (sign +1) or worse (−1), used for the peer-percentile quality score. */
const QUALITY_KEYS: { key: keyof RatioSet; sign: 1 | -1; financial: boolean }[] = [
  { key: "roic", sign: 1, financial: false },
  { key: "roe", sign: 1, financial: true },
  { key: "operatingMargin", sign: 1, financial: false },
  { key: "netMargin", sign: 1, financial: true },
  { key: "fcfToNetIncome", sign: 1, financial: false },
  { key: "debtToEquity", sign: -1, financial: false },
  { key: "accrualsRatio", sign: -1, financial: false },
];

/**
 * Step 1 of the workflow: screen with ratios and scores. Red flags are
 * distress (Altman), weak Piotroski, thin interest cover and heavy net debt;
 * two or more red flags fail the screen, one puts it on watch. Missing data is
 * "insufficient", never a fail.
 */
export function screen(f: Fundamentals, marketCap: number, peers: readonly Fundamentals[], opts: { financial: boolean; taxFallback?: number }): ScreenResult {
  const hist = ratioHistory(f, opts.taxFallback);
  const latestR = hist.length ? hist[hist.length - 1] : null;
  const g = growth(f);
  const pio = piotroski(f);
  const alt = !opts.financial && f.annual.length ? altmanZ(f.annual[f.annual.length - 1], marketCap) : null;
  const red: string[] = [];
  const green: string[] = [];
  let checks = 0, possible = 0;

  possible++;
  if (pio && pio.available >= 6) {
    checks++;
    if (pio.score <= 3) red.push(`Piotroski F ${pio.score}/${pio.available} (weak)`);
    else if (pio.score >= 7) green.push(`Piotroski F ${pio.score}/${pio.available} (strong)`);
  }
  if (!opts.financial) {
    possible++;
    if (alt) {
      checks++;
      if (alt.zone === "distress") red.push(`Altman Z ${alt.z.toFixed(2)} (< 1.8, distress zone)`);
      else if (alt.zone === "safe") green.push(`Altman Z ${alt.z.toFixed(2)} (safe zone)`);
    }
    possible++;
    if (latestR?.interestCoverage != null) {
      checks++;
      if (latestR.interestCoverage < 1.5) red.push(`interest coverage ${latestR.interestCoverage.toFixed(1)}× (< 1.5×)`);
    } else if (latestR?.debtToEquity != null && latestR.debtToEquity < 0.1) checks++; // effectively debt-free
    possible++;
    if (latestR?.netDebtToEbitda != null) {
      checks++;
      if (latestR.netDebtToEbitda > 5) red.push(`net debt / EBITDA ${latestR.netDebtToEbitda.toFixed(1)}× (> 5×)`);
      else if (latestR.netDebtToEbitda < 0) green.push("net cash balance sheet");
    }
  }
  possible++;
  if (latestR?.netMargin != null) {
    checks++;
    if (latestR.netMargin < 0) red.push(`net margin ${(latestR.netMargin * 100).toFixed(1)}% (loss-making)`);
  }

  const peerLatest = peers.map((p) => { const h = ratioHistory(p, opts.taxFallback); return h.length ? h[h.length - 1] : null; }).filter((x): x is RatioSet => !!x);
  const pct: Record<string, number> = {};
  const used: number[] = [];
  for (const q of QUALITY_KEYS) {
    if (opts.financial && !q.financial) continue;
    const own = latestR?.[q.key];
    if (typeof own !== "number") continue;
    const vals = peerLatest.map((r) => r[q.key]).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    if (vals.length < 3) continue;
    const p = percentileOf(vals.map((v) => q.sign * v), q.sign * own);
    pct[q.key] = p;
    used.push(p);
  }
  const qualityScore = used.length ? Math.round(100 * median(used)) : null;

  const coverage = possible ? checks / possible : 0;
  const verdict: ScreenVerdict = coverage < 0.5 ? "insufficient" : red.length >= 2 ? "fail" : red.length === 1 ? "watch" : "pass";
  return { verdict, qualityScore, redFlags: red, greenFlags: green, latest: latestR, growth: g, piotroski: pio, altman: alt, peerPercentiles: pct, coverage };
}

// ── Forensic / cash quality ─────────────────────────────────────────────────

export type ForensicResult = {
  beneish: Beneish | null;
  accrualsRatio: number | null;
  fcfToNetIncome: number | null;
  /** DSO change vs the prior year (days) — receivables outgrowing sales is a classic tell. */
  dsoChangeDays: number | null;
  flags: string[];
  /** 0 (clean) … 100 (many forensic red flags). */
  riskScore: number;
};

export function forensic(f: Fundamentals, taxFallback = 0.21): ForensicResult {
  const a = f.annual;
  const hist = ratioHistory(f, taxFallback);
  const cur = hist[hist.length - 1];
  const prev = hist.length > 1 ? hist[hist.length - 2] : undefined;
  const ben = a.length >= 2 ? beneishM(a[a.length - 1], a[a.length - 2]) : null;
  const flags: string[] = [];
  let risk = 0;
  if (ben?.flagged) { flags.push(`Beneish M ${ben.m.toFixed(2)} > −1.78${ben.imputed.length ? ` (${ben.imputed.length} indices imputed)` : ""}`); risk += 40; }
  const acc = cur?.accrualsRatio ?? null;
  if (acc != null && acc > 0.1) { flags.push(`accruals ${(acc * 100).toFixed(1)}% of assets (earnings ahead of cash)`); risk += 25; }
  const fcfNi = cur?.fcfToNetIncome ?? null;
  if (fcfNi != null && fcfNi < 0.5) { flags.push(`FCF only ${(fcfNi * 100).toFixed(0)}% of net income`); risk += 20; }
  const dsoCh = cur?.dso != null && prev?.dso != null ? cur.dso - prev.dso : null;
  if (dsoCh != null && dsoCh > 15) { flags.push(`DSO up ${dsoCh.toFixed(0)} days y/y`); risk += 15; }
  return { beneish: ben, accrualsRatio: acc, fcfToNetIncome: fcfNi, dsoChangeDays: dsoCh, flags, riskScore: Math.min(100, risk) };
}
