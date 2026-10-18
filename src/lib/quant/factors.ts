/**
 * Factor models. Regress a stock's excess returns on factor returns; the
 * intercept (alpha) is the return the factors do not explain.
 *
 *   CAPM          r − rf = α + β·MKT
 *   Fama-French 3 + SMB (size) + HML (value)
 *   Carhart 4     + MOM (momentum)
 *   Fama-French 5 + RMW (profitability) + CMA (investment)
 *   APT           weekly returns on macro surprises (rates, credit, oil, FX, vol)
 *
 * Standard errors are Newey-West (HAC) because daily returns are
 * heteroskedastic and mildly autocorrelated. India has no published
 * Fama-French factors, so long-short index/ETF spreads stand in (labelled
 * proxies in every output).
 */

import { ols, mean, std, isNum } from "./stats";

export type FactorModelSpec = { name: string; factors: string[] };

export const US_FACTOR_MODELS: FactorModelSpec[] = [
  { name: "CAPM", factors: ["MKT"] },
  { name: "Fama-French 3", factors: ["MKT", "SMB", "HML"] },
  { name: "Carhart 4", factors: ["MKT", "SMB", "HML", "MOM"] },
  { name: "Fama-French 5", factors: ["MKT", "SMB", "HML", "RMW", "CMA"] },
  { name: "FF5 + Momentum", factors: ["MKT", "SMB", "HML", "RMW", "CMA", "MOM"] },
];

export const IN_FACTOR_MODELS: FactorModelSpec[] = [
  { name: "CAPM (Nifty 50)", factors: ["MKT"] },
  { name: "3-factor proxy", factors: ["MKT", "SMB", "HML"] },
  { name: "4-factor proxy", factors: ["MKT", "SMB", "HML", "MOM"] },
  { name: "5-factor proxy (+ low vol)", factors: ["MKT", "SMB", "HML", "MOM", "LOWVOL"] },
];

/** Per-date factor returns as decimals, including RF (the daily risk-free return). */
export type FactorRow = Record<string, number>;
export type FactorSeries = ReadonlyMap<string, FactorRow>;

export type Exposure = { factor: string; beta: number; t: number; p: number };

export type FactorFit = {
  model: string;
  n: number;
  start: string;
  end: string;
  alphaAnnual: number;
  alphaT: number;
  alphaP: number;
  betas: Exposure[];
  r2: number;
  adjR2: number;
  residualVolAnnual: number;
  /** Alpha / residual vol, annualized. */
  informationRatio: number;
  bic: number;
  /** Annualized alpha estimated separately on each half of the window: a sign flip means it is not a stable edge. */
  alphaHalves: [number, number];
  covType: string;
};

/** Newey-West bandwidth rule of thumb: ⌊4·(n/100)^(2/9)⌋. */
export function neweyWestLags(n: number): number {
  return Math.max(1, Math.floor(4 * Math.pow(n / 100, 2 / 9)));
}

function regress(model: string, y: number[], X: number[][], names: string[], dates: string[], ppy: number): FactorFit | null {
  const n = y.length;
  if (n < Math.max(60, names.length * 15)) return null;
  const r = ols(y, X, { neweyWestLags: neweyWestLags(n), names });
  if (!r) return null;
  const half = Math.floor(n / 2);
  const a1 = ols(y.slice(0, half), X.slice(0, half));
  const a2 = ols(y.slice(half), X.slice(half));
  const sse = r.sigma2 * (r.n - r.k);
  const residVol = Math.sqrt(r.sigma2 * ppy);
  const alphaAnnual = r.coef[0] * ppy;
  return {
    model,
    n,
    start: dates[0],
    end: dates[n - 1],
    alphaAnnual,
    alphaT: r.t[0],
    alphaP: r.p[0],
    betas: names.map((f, i) => ({ factor: f, beta: r.coef[i + 1], t: r.t[i + 1], p: r.p[i + 1] })),
    r2: r.r2,
    adjR2: r.adjR2,
    residualVolAnnual: residVol,
    informationRatio: residVol > 0 ? alphaAnnual / residVol : 0,
    bic: n * Math.log(sse / n) + r.k * Math.log(n),
    alphaHalves: [a1 ? a1.coef[0] * ppy : NaN, a2 ? a2.coef[0] * ppy : NaN],
    covType: r.covType,
  };
}

/**
 * Fit each model on the most recent `window` dates where the stock return,
 * RF and every factor in that model exist. Stock returns are simple daily
 * returns keyed by date.
 */
export function fitFactorModels(
  stock: ReadonlyMap<string, number>,
  factors: FactorSeries,
  specs: readonly FactorModelSpec[],
  opts: { window?: number; ppy?: number } = {},
): FactorFit[] {
  const window = opts.window ?? 756;
  const ppy = opts.ppy ?? 252;
  const dates = [...stock.keys()].filter((d) => factors.has(d)).sort();
  const out: FactorFit[] = [];
  for (const spec of specs) {
    const usable = dates.filter((d) => {
      const row = factors.get(d)!;
      return isNum(row.RF) && spec.factors.every((f) => isNum(row[f])) && isNum(stock.get(d));
    }).slice(-window);
    const y = usable.map((d) => (stock.get(d) as number) - factors.get(d)!.RF);
    const X = usable.map((d) => spec.factors.map((f) => factors.get(d)![f]));
    const fit = regress(spec.name, y, X, spec.factors, usable, ppy);
    if (fit) out.push(fit);
  }
  return out;
}

export type CapmReport = {
  fit: FactorFit;
  beta: number;
  betaBlume: number;
  /** Jensen's alpha (annual) and its t-stat. */
  jensensAlpha: number;
  alphaT: number;
  /** Share of variance that is market risk (R²) vs idiosyncratic. */
  systematicShare: number;
  /** (mean excess return × ppy) / β. */
  treynor: number | null;
  /** rf + β·ERP: the return the stock must earn to justify its market risk. */
  requiredReturn: number;
  erp: number;
  rf: number;
};

export function capmReport(fit: FactorFit, excessMeanAnnual: number, rf: number, erp: number): CapmReport {
  const b = fit.betas.find((x) => x.factor === "MKT")?.beta ?? NaN;
  return {
    fit,
    beta: b,
    betaBlume: (2 / 3) * b + 1 / 3,
    jensensAlpha: fit.alphaAnnual,
    alphaT: fit.alphaT,
    systematicShare: fit.r2,
    treynor: b !== 0 && isNum(b) ? excessMeanAnnual / b : null,
    requiredReturn: rf + b * erp,
    erp,
    rf,
  };
}

/** Pick the model to headline: the lowest BIC among fits with at least `minObs` observations. */
export function preferredModel(fits: readonly FactorFit[], minObs = 250): FactorFit | null {
  const ok = fits.filter((f) => f.n >= minObs);
  return (ok.length ? ok : fits).reduce<FactorFit | null>((best, f) => (!best || f.bic < best.bic ? f : best), null);
}

/** Plain-language style tilts from factor betas with |t| ≥ 2. */
export function styleTilts(fit: FactorFit): string[] {
  const words: Record<string, [string, string]> = {
    SMB: ["small-cap tilt", "large-cap tilt"],
    HML: ["value tilt", "growth tilt"],
    MOM: ["momentum winner", "momentum laggard"],
    RMW: ["high profitability", "weak profitability"],
    CMA: ["conservative investment", "aggressive investment"],
    LOWVOL: ["defensive / low-vol", "high-beta / volatile"],
  };
  const out: string[] = [];
  for (const e of fit.betas) {
    if (e.factor === "MKT") {
      if (Math.abs(e.t) >= 2) out.push(e.beta > 1.15 ? "high market beta" : e.beta < 0.85 ? "low market beta" : "market-like beta");
      continue;
    }
    const w = words[e.factor];
    if (w && Math.abs(e.t) >= 2) out.push(e.beta > 0 ? w[0] : w[1]);
  }
  return out;
}

// ── APT macro factors (weekly) ──────────────────────────────────────────────

export type MacroInput = {
  name: string;
  /** Level on each weekly sample date (aligned with the stock's weekly prices); null where missing. */
  levels: readonly (number | null)[];
  /** "diff" for rates/spreads/VIX (Δ level), "logret" for prices (oil, FX, indices). */
  transform: "diff" | "logret";
};

export type MacroExposure = Exposure & {
  /** Stock return (%) per one-standard-deviation weekly move in the factor. */
  pctPerSd: number;
  /** One weekly sd of the factor in its natural units (bp, %, points). */
  sdNatural: number;
  significant: boolean;
};

export type MacroFit = {
  n: number;
  r2: number;
  adjR2: number;
  exposures: MacroExposure[];
  /** Exposures sorted by |t|, significant ones first. */
  ranked: MacroExposure[];
};

function transformed(levels: readonly (number | null)[], t: "diff" | "logret"): (number | null)[] {
  const out: (number | null)[] = [null];
  for (let i = 1; i < levels.length; i++) {
    const a = levels[i - 1], b = levels[i];
    if (a == null || b == null || !isNum(a) || !isNum(b)) { out.push(null); continue; }
    out.push(t === "diff" ? b - a : a > 0 && b > 0 ? Math.log(b / a) : null);
  }
  return out;
}

/**
 * Weekly stock excess returns on standardized macro factor changes. Betas
 * are per one-sd factor move, so exposures are comparable across factors.
 */
export function fitMacroFactors(stockWeekly: readonly number[], rfWeekly: number, inputs: readonly MacroInput[]): MacroFit | null {
  const y0: (number | null)[] = [null];
  for (let i = 1; i < stockWeekly.length; i++) {
    const a = stockWeekly[i - 1], b = stockWeekly[i];
    y0.push(a > 0 && b > 0 ? b / a - 1 - rfWeekly : null);
  }
  const cols = inputs.map((x) => transformed(x.levels, x.transform));
  const rows: number[] = [];
  for (let t = 1; t < stockWeekly.length; t++) {
    if (y0[t] == null || cols.some((c) => c[t] == null)) continue;
    rows.push(t);
  }
  const k = inputs.length;
  if (rows.length < Math.max(52, k * 10)) return null;
  const raw = cols.map((c) => rows.map((t) => c[t] as number));
  const mu = raw.map(mean), sd = raw.map((c) => std(c));
  if (sd.some((s) => !(s > 0))) return null;
  const X = rows.map((_, i) => raw.map((c, j) => (c[i] - mu[j]) / sd[j]));
  const y = rows.map((t) => y0[t] as number);
  const r = ols(y, X, { neweyWestLags: neweyWestLags(y.length), names: inputs.map((x) => x.name) });
  if (!r) return null;
  const exposures: MacroExposure[] = inputs.map((x, j) => ({
    factor: x.name,
    beta: r.coef[j + 1],
    t: r.t[j + 1],
    p: r.p[j + 1],
    pctPerSd: r.coef[j + 1] * 100,
    sdNatural: sd[j],
    significant: Math.abs(r.t[j + 1]) >= 2,
  }));
  const ranked = [...exposures].sort((a, b) => Math.abs(b.t) - Math.abs(a.t));
  return { n: y.length, r2: r.r2, adjR2: r.adjR2, exposures, ranked };
}
