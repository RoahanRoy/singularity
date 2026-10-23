/**
 * Intrinsic and relative valuation: DCF (FCFF / WACC / CAPM / Gordon terminal
 * value), Gordon dividend discount, residual income, and peer/history
 * multiples. Every model returns a per-share value plus a low/high band from
 * its own sensitivity, and says why when it does not apply.
 *
 * Valuation estimates value, not the next price move — the band is the point.
 */

import { clamp, median, quantile, isNum } from "./stats";
import { type Fundamentals, type FinRow, type Market, ttmOrAnnual, latestBalance } from "./types";

// ── Building blocks (the formulas, one-to-one) ──────────────────────────────

/** FCFF = EBIT(1 − t) + D&A − CapEx − ΔNWC. `capex` is a positive spend. */
export function fcff(i: { ebit: number; taxRate: number; da: number; capex: number; deltaNwc: number }): number {
  return i.ebit * (1 - i.taxRate) + i.da - i.capex - i.deltaNwc;
}

/** CAPM: Re = Rf + β(Rm − Rf), with the equity risk premium (Rm − Rf) passed directly. */
export function capm(rf: number, beta: number, erp: number): number {
  return rf + beta * erp;
}

/** WACC = (E/V)·Re + (D/V)·Rd·(1 − t). */
export function wacc(i: { equity: number; debt: number; costOfEquity: number; costOfDebt: number; taxRate: number }) {
  const v = i.equity + i.debt;
  const we = v > 0 ? i.equity / v : 1;
  const wd = 1 - we;
  const afterTaxRd = i.costOfDebt * (1 - i.taxRate);
  return { wacc: we * i.costOfEquity + wd * afterTaxRd, weightEquity: we, weightDebt: wd, afterTaxCostOfDebt: afterTaxRd };
}

/** Gordon terminal value TV = FCF₍ₙ₊₁₎ / (r − g); NaN when r ≤ g (the model breaks). */
export function terminalValue(fcfNext: number, rate: number, g: number): number {
  return rate > g ? fcfNext / (rate - g) : NaN;
}

/** Blume-adjusted beta (0.67·β + 0.33): raw betas regress toward 1 over time. */
export function blumeBeta(raw: number): number {
  return 0.67 * raw + 0.33;
}

export type DcfResult = {
  ev: number;
  pvExplicit: number;
  terminalValue: number;
  pvTerminal: number;
  equityValue: number;
  perShare: number;
  /** Share of EV that comes from the terminal value — high means the answer is mostly the g assumption. */
  tvShareOfEv: number;
  pvFcf: number[];
};

/**
 * Value = Σ FCFₜ/(1+WACC)ᵗ + TV/(1+WACC)ⁿ; equity = EV − net debt; ÷ shares.
 * `fcf` holds years 1..n; TV uses FCFₙ·(1+g).
 */
export function dcf(i: { fcf: readonly number[]; wacc: number; g: number; netDebt: number; shares: number }): DcfResult | null {
  const n = i.fcf.length;
  if (!n || !(i.shares > 0) || !(i.wacc > i.g)) return null;
  const pvFcf = i.fcf.map((f, t) => f / Math.pow(1 + i.wacc, t + 1));
  const pvExplicit = pvFcf.reduce((a, b) => a + b, 0);
  const tv = terminalValue(i.fcf[n - 1] * (1 + i.g), i.wacc, i.g);
  const pvTerminal = tv / Math.pow(1 + i.wacc, n);
  const ev = pvExplicit + pvTerminal;
  const equityValue = ev - i.netDebt;
  return {
    ev, pvExplicit, terminalValue: tv, pvTerminal, equityValue,
    perShare: equityValue / i.shares,
    tvShareOfEv: ev !== 0 ? pvTerminal / ev : NaN,
    pvFcf,
  };
}

/** Gordon growth DDM: P = D₁ / (r − g), D₁ = D₀(1 + g). */
export function gordonDdm(i: { d0: number; g: number; r: number }): { value: number; d1: number } | null {
  if (!(i.r > i.g) || !(i.d0 > 0)) return null;
  const d1 = i.d0 * (1 + i.g);
  return { value: d1 / (i.r - i.g), d1 };
}

/**
 * Residual income: Value = B₀ + Σ (ROEₜ − r)·Bₜ₋₁ / (1 + r)ᵗ + TV.
 * ROE fades linearly from `roe` to `longRunRoe` (default r) over `years`; book
 * grows by clean surplus Bₜ = Bₜ₋₁(1 + ROEₜ(1 − payout)). With a terminal growth
 * the year-n+1 residual income continues as a Gordon perpetuity
 * TV = RIₙ₊₁ / (r − g); without one (or with ROE fading to r) it stops at year n.
 */
export function residualIncome(i: { book0: number; roe: number; r: number; payout: number; years?: number; longRunRoe?: number; terminalGrowth?: number }) {
  const years = i.years ?? 10;
  if (!(i.book0 > 0)) return null;
  const end = i.longRunRoe ?? i.r;
  let b = i.book0;
  let pv = 0;
  const rows: { t: number; roe: number; book: number; ri: number; pv: number }[] = [];
  for (let t = 1; t <= years; t++) {
    const roeT = i.roe + ((end - i.roe) * (t - 1)) / Math.max(1, years - 1);
    const ri = (roeT - i.r) * b;
    const pvT = ri / Math.pow(1 + i.r, t);
    pv += pvT;
    rows.push({ t, roe: roeT, book: b, ri, pv: pvT });
    b = b * (1 + roeT * (1 - clamp(i.payout, 0, 1)));
  }
  const g = i.terminalGrowth;
  const pvTerminal = isNum(g) && i.r > g ? ((end - i.r) * b) / (i.r - g) / Math.pow(1 + i.r, years) : 0;
  return { value: i.book0 + pv + pvTerminal, pvResidualIncome: pv, pvTerminal, rows };
}

/** Linear fade from `start` to `end` across `years` (year 1 = start, year n = end). */
export function fadePath(start: number, end: number, years: number, hold = 0): number[] {
  const out: number[] = [];
  for (let t = 0; t < years; t++) {
    if (t < hold) { out.push(start); continue; }
    const span = Math.max(1, years - hold);
    out.push(start + ((end - start) * (t - hold + 1)) / span);
  }
  return out;
}

const DAY_MS = 86_400_000;

/** The value of `field` in the row whose period end is nearest `target` (within `tolDays`). */
export function valueNear(rows: readonly FinRow[], field: keyof FinRow, target: number, tolDays = 120): number | undefined {
  let best: number | undefined;
  let bestGap = Infinity;
  for (const r of rows) {
    const v = r[field];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    const gap = Math.abs(Date.parse(r.asOf) - target);
    if (gap < bestGap) { bestGap = gap; best = v; }
  }
  return bestGap <= tolDays * DAY_MS ? best : undefined;
}

/** Newest row (quarterly first, then annual) carrying `field`. */
function newestRowWith(f: Fundamentals, field: keyof FinRow): FinRow | undefined {
  const rows = [...f.annual, ...f.quarterly].filter((r) => typeof r[field] === "number").sort((a, b) => a.asOf.localeCompare(b.asOf));
  return rows[rows.length - 1];
}

// ── Market assumptions ──────────────────────────────────────────────────────

export type ValuationAssumptions = {
  market: Market;
  /** Long-run risk-free rate (decimal), e.g. 10y government yield. */
  rf: number;
  rfSource: string;
  /** Equity risk premium (decimal). */
  erp: number;
  /** Terminal (perpetual) growth (decimal). */
  terminalGrowth: number;
  /** Statutory tax fallback when effective rates are unusable. */
  statutoryTax: number;
  /** Long-run cap on the sustainable dividend growth used by Gordon DDM. */
  maxStableGrowth: number;
};

/**
 * ERPs follow Damodaran's implied (not historical) premiums. US: the implied
 * S&P 500 premium has sat around 4–4.6% since 2022. India: a mature 4.3–4.5%
 * plus a country premium of ~3%, less the ~2% sovereign default spread that the
 * rupee 10-year (the rf here) already carries, so country risk is counted once.
 */
export function defaultAssumptions(market: Market, rf: number, rfSource: string): ValuationAssumptions {
  return market === "IN"
    ? { market, rf, rfSource, erp: 0.055, terminalGrowth: 0.05, statutoryTax: 0.2517, maxStableGrowth: 0.07 }
    : { market, rf, rfSource, erp: 0.045, terminalGrowth: 0.025, statutoryTax: 0.21, maxStableGrowth: 0.04 };
}

// ── Inputs from normalized fundamentals ─────────────────────────────────────

export type CompanySnapshot = {
  price: number;
  /** Market cap in the price currency. */
  marketCap: number;
  shares: number;
  /** Multiply reported financials by this to convert to the price currency. */
  fx: number;
  revenue?: number;
  ebit?: number;
  ebitda?: number;
  netIncome?: number;
  eps?: number;
  equity?: number;
  bookPerShare?: number;
  totalDebt: number;
  cash: number;
  netDebt: number;
  ev: number;
  dividendsPaid?: number;
  dps?: number;
  payout?: number;
  roe?: number;
  taxRate: number;
  taxSource: string;
  interestExpense?: number;
};

function effectiveTax(rows: readonly FinRow[], fallback: number): { rate: number; source: string } {
  const rates: number[] = [];
  for (const r of rows.slice(-3)) {
    if (isNum(r.taxProvision) && isNum(r.pretaxIncome) && r.pretaxIncome > 0) rates.push(r.taxProvision / r.pretaxIncome);
    else if (isNum(r.taxRate)) rates.push(r.taxRate);
  }
  if (!rates.length) return { rate: fallback, source: "statutory (assumption)" };
  return { rate: clamp(median(rates), 0, 0.35), source: `median effective rate, last ${rates.length}y` };
}

/**
 * Per-share and balance-sheet facts in the listing currency. `tangible` puts
 * book (and so ROE and P/B) on tangible equity: the basis for banks and
 * insurers, whose acquisition goodwill earns nothing a lender can lend against
 * (HDFC Bank carries ~₹3 lakh crore of it from the HDFC Ltd merger).
 */
export function snapshot(f: Fundamentals, price: number, a: ValuationAssumptions, fx = 1, sharesHint?: number, opts: { tangible?: boolean } = {}): CompanySnapshot | null {
  const shares = latestBalance(f, "sharesOutstanding") ?? ttmOrAnnual(f, "dilutedShares") ?? sharesHint;
  if (!isNum(shares) || shares <= 0 || !(price > 0)) return null;
  const x = (v: number | undefined) => (isNum(v) ? v * fx : undefined);
  const revenue = x(ttmOrAnnual(f, "revenue"));
  const ebit = x(ttmOrAnnual(f, "ebit") ?? ttmOrAnnual(f, "operatingIncome"));
  const ebitda = x(ttmOrAnnual(f, "ebitda"));
  const netIncome = x(ttmOrAnnual(f, "netIncome"));
  const tbv = opts.tangible ? latestBalance(f, "tangibleBook") : undefined;
  const bookField = isNum(tbv) && tbv > 0 ? "tangibleBook" : "equity";
  const equity = x(latestBalance(f, bookField));
  const totalDebt = x(latestBalance(f, "totalDebt")) ?? 0;
  const cash = x(latestBalance(f, "cashAndSti") ?? latestBalance(f, "cash")) ?? 0;
  const dividendsPaid = x(ttmOrAnnual(f, "dividendsPaid"));
  const marketCap = price * shares;
  const netDebt = totalDebt - cash;
  // ROE on average equity: the latest balance and the one ~a year earlier.
  const eqRow = newestRowWith(f, bookField);
  const eqPrev = eqRow ? x(valueNear([...f.annual, ...f.quarterly], bookField, Date.parse(eqRow.asOf) - 365 * DAY_MS)) : undefined;
  const avgEquity = isNum(equity) ? (isNum(eqPrev) && eqPrev > 0 ? (equity + eqPrev) / 2 : equity) : undefined;
  const tax = effectiveTax(f.annual, a.statutoryTax);
  return {
    price, marketCap, shares, fx, revenue, ebit, ebitda, netIncome,
    eps: isNum(netIncome) ? netIncome / shares : undefined,
    equity,
    bookPerShare: isNum(equity) ? equity / shares : undefined,
    totalDebt, cash, netDebt, ev: marketCap + netDebt,
    dividendsPaid,
    dps: isNum(dividendsPaid) ? dividendsPaid / shares : undefined,
    payout: isNum(dividendsPaid) && isNum(netIncome) && netIncome > 0 ? dividendsPaid / netIncome : undefined,
    roe: isNum(netIncome) && isNum(avgEquity) && avgEquity > 0 ? netIncome / avgEquity : undefined,
    taxRate: tax.rate,
    taxSource: tax.source,
    interestExpense: x(ttmOrAnnual(f, "interestExpense")),
  };
}

export type CostOfCapital = {
  beta: number;
  betaRaw: number | null;
  costOfEquity: number;
  costOfDebt: number;
  costOfDebtSource: string;
  wacc: number;
  weightEquity: number;
  weightDebt: number;
};

export function costOfCapital(s: CompanySnapshot, a: ValuationAssumptions, betaRaw: number | null): CostOfCapital {
  const beta = isNum(betaRaw) ? clamp(blumeBeta(betaRaw), 0.3, 2.5) : 1;
  const re = capm(a.rf, beta, a.erp);
  let rd = a.rf + 0.015;
  let rdSource = "rf + 150bp (assumption: no interest expense reported)";
  if (isNum(s.interestExpense) && s.interestExpense > 0 && s.totalDebt > 0) {
    rd = clamp(s.interestExpense / s.totalDebt, a.rf, a.rf + 0.08);
    rdSource = "interest expense / total debt, clamped to [rf, rf+8%]";
  }
  const w = wacc({ equity: s.marketCap, debt: Math.max(0, s.totalDebt), costOfEquity: re, costOfDebt: rd, taxRate: s.taxRate });
  return { beta, betaRaw, costOfEquity: re, costOfDebt: rd, costOfDebtSource: rdSource, wacc: clamp(w.wacc, a.rf + 0.01, 0.2), weightEquity: w.weightEquity, weightDebt: w.weightDebt };
}

/** Annual revenue CAGR over up to the last `years` fiscal years. */
export function revenueCagr(f: Fundamentals, years = 3): number | null {
  const rows = f.annual.filter((r) => isNum(r.revenue) && (r.revenue as number) > 0);
  if (rows.length < 2) return null;
  const span = Math.min(years, rows.length - 1);
  const start = rows[rows.length - 1 - span].revenue as number;
  const end = rows[rows.length - 1].revenue as number;
  return Math.pow(end / start, 1 / span) - 1;
}

export type GrowthHint = { value: number; source: string };

/**
 * Stage-one revenue growth for the DCF: the consensus for this and next fiscal
 * year when analysts publish one (the market prices forward growth, not the
 * trailing three years), else the 3y revenue CAGR. A consensus more than 10
 * points from the CAGR is held to that band: thin Indian coverage and fiscal-year
 * mismatches produce estimates like +30% for a company growing at 8%.
 */
export function growthHint(f: Fundamentals, consensus: { current: number | null; next: number | null } | null | undefined): GrowthHint | null {
  const cagr = revenueCagr(f, 3);
  const est = [consensus?.current, consensus?.next].filter(isNum);
  if (est.length) {
    const mean = est.reduce((a, b) => a + b, 0) / est.length;
    const source = `consensus revenue growth (${est.length === 2 ? "this and next FY" : "one FY"})`;
    if (!isNum(cagr) || Math.abs(mean - cagr) <= 0.1) return { value: mean, source };
    return { value: clamp(mean, cagr - 0.1, cagr + 0.1), source: `${source}, held within 10pp of the 3y CAGR` };
  }
  return isNum(cagr) ? { value: cagr, source: "3y revenue CAGR" } : null;
}

// ── Model results ───────────────────────────────────────────────────────────

export type ModelValue = {
  method: "dcf" | "ddm" | "residual_income" | "multiples";
  applicable: boolean;
  /** Why the model was skipped, when it was. */
  reason?: string;
  perShare?: number;
  low?: number;
  high?: number;
  detail?: Record<string, unknown>;
};

/**
 * Two-stage FCFF DCF: revenue grows at the hint for two years, fades linearly
 * to terminal growth by year 10 at the recent median EBIT margin.
 *
 * FCFF = NOPAT·(1 − reinvestment rate). The rate starts at the historical
 * (capex − D&A + ΔNWC) / NOPAT and fades to the steady state g / RONIC (the
 * value-driver formula), so the terminal year reinvests exactly what its growth
 * needs. Holding a build-out year's capex forever would understate value; zero
 * net capex with growth forever would overstate it. RONIC is the current ROIC
 * held between WACC and 2×WACC. Low/high come from WACC ±1% × g ±0.5%.
 */
export function dcfModel(
  f: Fundamentals,
  s: CompanySnapshot,
  coc: CostOfCapital,
  a: ValuationAssumptions,
  growth: GrowthHint | null,
  opts: { financial?: boolean; years?: number } = {},
): ModelValue {
  if (opts.financial) return { method: "dcf", applicable: false, reason: "financial company — FCFF is not meaningful for lenders; see residual income" };
  const rows = [...f.annual.slice(-3), ...(f.ttm ? [f.ttm] : [])].filter((r) => isNum(r.revenue) && (r.revenue as number) > 0);
  if (!isNum(s.revenue) || s.revenue <= 0 || !rows.length) return { method: "dcf", applicable: false, reason: "no revenue history" };
  const ratio = (num: (r: FinRow) => number | undefined) => {
    const xs = rows.map((r) => { const v = num(r); return isNum(v) ? v / (r.revenue as number) : NaN; }).filter(isNum);
    return xs.length ? median(xs) : null;
  };
  const margin = ratio((r) => r.ebit ?? r.operatingIncome);
  const daPct = ratio((r) => r.da) ?? 0;
  const capexPct = ratio((r) => r.capex) ?? daPct;
  if (margin == null) return { method: "dcf", applicable: false, reason: "no EBIT history" };
  if (margin <= 0) return { method: "dcf", applicable: false, reason: `negative operating margin (${(margin * 100).toFixed(1)}%) — FCFF DCF would value the firm below zero` };

  // Non-cash working capital as a share of revenue → ΔNWC = ratio × ΔRevenue.
  const bal = newestRowWith(f, "currentAssets");
  let nwcRatio = 0;
  let nwcSource = "assumed 0 (no current-asset data)";
  if (bal && isNum(bal.currentAssets) && isNum(bal.currentLiabilities)) {
    const stDebt = isNum(bal.totalDebt) && isNum(bal.longTermDebt) ? Math.max(0, bal.totalDebt - bal.longTermDebt) : 0;
    const cashLike = bal.cashAndSti ?? bal.cash ?? 0;
    const nwc = (bal.currentAssets - cashLike) - (bal.currentLiabilities - stDebt);
    nwcRatio = clamp((nwc * s.fx) / s.revenue, -0.3, 0.5);
    nwcSource = "non-cash working capital / revenue, latest balance sheet";
  }

  const years = opts.years ?? 10;
  const g0 = growth ? clamp(growth.value, -0.1, 0.3) : 0.03;
  const gT = a.terminalGrowth;
  const path = fadePath(g0, gT, years, 2);
  let g = gT;
  let gNote: string | undefined;
  if (coc.wacc - g < 0.01) { g = coc.wacc - 0.01; gNote = "terminal growth lowered to keep WACC − g ≥ 1%"; }

  // Return on new invested capital for the steady state.
  const nopat0 = s.revenue * margin * (1 - s.taxRate);
  const ic = isNum(s.equity) ? s.equity + s.totalDebt - s.cash : undefined;
  const roic = isNum(ic) && ic > 0 ? nopat0 / ic : null;
  let ronic = coc.wacc;
  let ronicSource = "WACC (no invested-capital data: growth assumed to earn its cost of capital)";
  if (roic != null) {
    ronic = clamp(roic, coc.wacc, 2 * coc.wacc);
    ronicSource = `ROIC ${(roic * 100).toFixed(1)}% held between WACC and 2×WACC`;
  } else if (isNum(ic)) {
    ronic = 2 * coc.wacc;
    ronicSource = "2×WACC (invested capital ≤ 0 after buybacks)";
  }
  const g1 = path[0];
  const rr0 = clamp(((capexPct - daPct) + nwcRatio * (g1 / (1 + g1))) / (margin * (1 - s.taxRate)), -0.5, 1.2);

  const project = (gTerm: number) => {
    const rrT = gTerm / ronic;
    let rev = s.revenue as number;
    const fcf: number[] = [];
    const rows: { year: number; growth: number; revenue: number; nopat: number; reinvestmentRate: number; fcff: number }[] = [];
    for (let t = 0; t < years; t++) {
      const next = rev * (1 + path[t]);
      const nopat = next * margin * (1 - s.taxRate);
      const rr = years > 1 ? rr0 + (rrT - rr0) * (t / (years - 1)) : rrT;
      fcf.push(nopat * (1 - rr));
      rows.push({ year: t + 1, growth: path[t], revenue: next, nopat, reinvestmentRate: rr, fcff: nopat * (1 - rr) });
      rev = next;
    }
    return { fcf, rows, rrT };
  };

  const baseProj = project(g);
  const base = dcf({ fcf: baseProj.fcf, wacc: coc.wacc, g, netDebt: s.netDebt, shares: s.shares });
  if (!base || !isNum(base.perShare)) return { method: "dcf", applicable: false, reason: "DCF did not converge (WACC ≤ g)" };

  const grid: { wacc: number; g: number; perShare: number }[] = [];
  for (const dw of [-0.01, 0, 0.01]) {
    for (const dg of [-0.005, 0, 0.005]) {
      const w = coc.wacc + dw;
      const gg = Math.min(g + dg, w - 0.005);
      const r = dcf({ fcf: project(gg).fcf, wacc: w, g: gg, netDebt: s.netDebt, shares: s.shares });
      if (r && isNum(r.perShare)) grid.push({ wacc: w, g: gg, perShare: r.perShare });
    }
  }
  const vals = grid.map((x) => x.perShare);
  return {
    method: "dcf",
    applicable: base.perShare > 0,
    reason: base.perShare > 0 ? undefined : "net debt exceeds enterprise value",
    perShare: base.perShare,
    low: Math.min(...vals),
    high: Math.max(...vals),
    detail: {
      wacc: coc.wacc, costOfEquity: coc.costOfEquity, beta: coc.beta, costOfDebt: coc.costOfDebt, costOfDebtSource: coc.costOfDebtSource,
      weightEquity: coc.weightEquity, terminalGrowth: g, terminalGrowthNote: gNote,
      growthStart: g0, growthSource: growth?.source ?? "default 3% (assumption)",
      ebitMargin: margin, daPct, capexPct, nwcRatio, nwcSource, taxRate: s.taxRate, taxSource: s.taxSource,
      roic, ronic, ronicSource, reinvestmentStart: rr0, reinvestmentTerminal: baseProj.rrT,
      ev: base.ev, netDebt: s.netDebt, pvExplicit: base.pvExplicit, pvTerminal: base.pvTerminal, tvShareOfEv: base.tvShareOfEv,
      projection: baseProj.rows, sensitivity: grid,
    },
  };
}

/**
 * Gordon DDM for stable payers only: dividends paid in each of the last three
 * fiscal years without a cut, and a payout ratio between 30% and 100%. Growth is
 * the sustainable rate ROE·(1 − payout), capped at the market's long-run rate.
 */
export function ddmModel(f: Fundamentals, s: CompanySnapshot, coc: CostOfCapital, a: ValuationAssumptions): ModelValue {
  const divs = f.annual.slice(-3).map((r) => r.dividendsPaid ?? 0);
  if (divs.length < 3 || divs.some((d) => !(d > 0))) return { method: "ddm", applicable: false, reason: "not a stable payer (dividends missing in one of the last 3 years)" };
  if (divs[2] < divs[1] * 0.95 || divs[1] < divs[0] * 0.95) return { method: "ddm", applicable: false, reason: "dividend was cut in the last 3 years" };
  if (!isNum(s.payout) || s.payout < 0.3 || s.payout > 1) {
    return { method: "ddm", applicable: false, reason: `payout ratio ${isNum(s.payout) ? (s.payout * 100).toFixed(0) + "%" : "unknown"} — outside 30–100%, Gordon does not describe this payer` };
  }
  if (!isNum(s.dps) || s.dps <= 0) return { method: "ddm", applicable: false, reason: "no dividend per share" };
  const sustainable = isNum(s.roe) ? s.roe * (1 - s.payout) : a.terminalGrowth;
  const g = clamp(sustainable, 0, Math.min(a.maxStableGrowth, coc.costOfEquity - 0.01));
  const base = gordonDdm({ d0: s.dps, g, r: coc.costOfEquity });
  if (!base) return { method: "ddm", applicable: false, reason: "cost of equity ≤ growth" };
  const lo = gordonDdm({ d0: s.dps, g, r: coc.costOfEquity + 0.01 });
  const hi = gordonDdm({ d0: s.dps, g, r: Math.max(coc.costOfEquity - 0.01, g + 0.005) });
  return {
    method: "ddm", applicable: true, perShare: base.value, low: lo?.value ?? base.value, high: hi?.value ?? base.value,
    detail: { d0: s.dps, d1: base.d1, growth: g, growthSource: isNum(s.roe) ? "sustainable ROE×(1−payout), capped" : "terminal growth (assumption)", costOfEquity: coc.costOfEquity, payout: s.payout },
  };
}

/** Above this P/B, book is under 5% of price and residual income values the buyback history, not the business. */
export const RI_MAX_PB = 20;
/** The most ROE may exceed r in perpetuity: a 40% ROE does not stay 15 points above r forever. */
export const RI_MAX_SPREAD = 0.05;

/**
 * Residual income — the primary model for banks and insurers. Low/high from r ± 1%.
 * ROE fades over ten years to r + ½(ROE − r), capped at r + RI_MAX_SPREAD, and
 * that spread then persists at terminal growth: the same "advantage half-decays and stays" stance as the
 * DCF's RONIC between WACC and 2×WACC. Fading all the way to r would value a
 * franchise lender at little more than book.
 */
export function residualIncomeModel(s: CompanySnapshot, coc: CostOfCapital, a?: ValuationAssumptions): ModelValue {
  if (!isNum(s.bookPerShare) || s.bookPerShare <= 0) return { method: "residual_income", applicable: false, reason: "book value is zero or negative (buybacks/losses) — residual income needs positive book" };
  if (!isNum(s.roe)) return { method: "residual_income", applicable: false, reason: "no ROE" };
  const pb = s.price / s.bookPerShare;
  if (pb > RI_MAX_PB) {
    return { method: "residual_income", applicable: false, reason: `P/B ${pb.toFixed(0)}× — book is hollowed out by buybacks, so a book-anchored model says nothing about value` };
  }
  const roe = clamp(s.roe, -0.5, 0.6);
  const payout = isNum(s.payout) ? clamp(s.payout, 0, 1) : 0.3;
  const run = (r: number) => residualIncome({
    book0: s.bookPerShare as number, roe, r, payout,
    longRunRoe: a ? r + Math.min(0.5 * (roe - r), RI_MAX_SPREAD) : undefined,
    terminalGrowth: a ? Math.min(a.terminalGrowth, r - 0.01) : undefined,
  });
  const base = run(coc.costOfEquity);
  const lo = run(coc.costOfEquity + 0.01);
  const hi = run(Math.max(0.01, coc.costOfEquity - 0.01));
  if (!base) return { method: "residual_income", applicable: false, reason: "no book value" };
  return {
    method: "residual_income", applicable: base.value > 0, perShare: base.value,
    low: Math.min(lo?.value ?? base.value, hi?.value ?? base.value),
    high: Math.max(lo?.value ?? base.value, hi?.value ?? base.value),
    detail: { book0: s.bookPerShare, roe, costOfEquity: coc.costOfEquity, payout, fadeYears: 10, pvResidualIncome: base.pvResidualIncome, pvTerminal: base.pvTerminal, roeClamped: roe !== s.roe },
  };
}

// ── Relative valuation ──────────────────────────────────────────────────────

export type Multiples = { pe?: number; evEbitda?: number; pb?: number; ps?: number; peg?: number };
export const MULTIPLE_KEYS = ["pe", "evEbitda", "pb", "ps", "peg"] as const;
export type MultipleKey = (typeof MULTIPLE_KEYS)[number];

/** P/E, EV/EBITDA, P/B, P/S, PEG = (P/E)/growth(%) — only where the denominator is positive. */
export function computeMultiples(s: CompanySnapshot, epsGrowth: number | null): Multiples {
  const m: Multiples = {};
  if (isNum(s.netIncome) && s.netIncome > 0) m.pe = s.marketCap / s.netIncome;
  if (isNum(s.ebitda) && s.ebitda > 0 && s.ev > 0) m.evEbitda = s.ev / s.ebitda;
  if (isNum(s.equity) && s.equity > 0) m.pb = s.marketCap / s.equity;
  if (isNum(s.revenue) && s.revenue > 0) m.ps = s.marketCap / s.revenue;
  if (isNum(m.pe) && isNum(epsGrowth) && epsGrowth > 0.01) m.peg = m.pe / (epsGrowth * 100);
  return m;
}

/** Own multiples at past fiscal year-ends: MarketCapₜ ≈ MarketCap_now · closeₜ / close_now (split-safe; ignores buybacks). */
export function historicalMultiples(f: Fundamentals, s: CompanySnapshot, closeAt: (date: string) => number | null, opts: { tangible?: boolean } = {}): Partial<Record<MultipleKey, number[]>> {
  const out: Partial<Record<MultipleKey, number[]>> = { pe: [], evEbitda: [], pb: [], ps: [] };
  for (const r of f.annual) {
    const c = closeAt(r.asOf);
    if (!isNum(c) || c <= 0) continue;
    const mcap = (s.marketCap * c) / s.price;
    const debt = (r.totalDebt ?? 0) * s.fx;
    const cash = (r.cashAndSti ?? r.cash ?? 0) * s.fx;
    if (isNum(r.netIncome) && r.netIncome > 0) out.pe!.push(mcap / (r.netIncome * s.fx));
    if (isNum(r.ebitda) && r.ebitda > 0) out.evEbitda!.push((mcap + debt - cash) / (r.ebitda * s.fx));
    const book = opts.tangible && isNum(r.tangibleBook) ? r.tangibleBook : r.equity;
    if (isNum(book) && book > 0) out.pb!.push(mcap / (book * s.fx));
    if (isNum(r.revenue) && r.revenue > 0) out.ps!.push(mcap / (r.revenue * s.fx));
  }
  return out;
}

/** Price implied by applying a benchmark multiple to this company's own fundamentals. */
export function impliedPrice(key: MultipleKey, benchmark: number, s: CompanySnapshot, epsGrowth: number | null): number | null {
  if (!isNum(benchmark) || benchmark <= 0) return null;
  switch (key) {
    case "pe": return isNum(s.eps) && s.eps > 0 ? benchmark * s.eps : null;
    case "evEbitda": return isNum(s.ebitda) && s.ebitda > 0 ? (benchmark * s.ebitda - s.netDebt) / s.shares : null;
    case "pb": return isNum(s.bookPerShare) && s.bookPerShare > 0 ? benchmark * s.bookPerShare : null;
    case "ps": return isNum(s.revenue) && s.revenue > 0 ? (benchmark * s.revenue) / s.shares : null;
    case "peg": return isNum(s.eps) && s.eps > 0 && isNum(epsGrowth) && epsGrowth > 0.01 ? benchmark * epsGrowth * 100 * s.eps : null;
  }
}

export type RelativeRow = {
  multiple: MultipleKey;
  own: number | null;
  peerMedian: number | null;
  peerCount: number;
  historyMedian: number | null;
  historyCount: number;
  /** Own multiple vs peer median, %. Positive = premium. */
  premiumToPeersPct: number | null;
  premiumToHistoryPct: number | null;
  impliedFromPeers: number | null;
  impliedFromHistory: number | null;
};

/**
 * Compare multiples against same-sector peers and the company's own history.
 * Banks skip EV/EBITDA and P/S (meaningless for lenders). The fair band is the
 * IQR of every implied price, the midpoint their median.
 */
export function relativeModel(
  s: CompanySnapshot,
  own: Multiples,
  peers: readonly Multiples[],
  history: Partial<Record<MultipleKey, number[]>>,
  epsGrowth: number | null,
  opts: { financial?: boolean } = {},
): ModelValue & { rows: RelativeRow[] } {
  const keys: MultipleKey[] = opts.financial ? ["pe", "pb", "peg"] : [...MULTIPLE_KEYS];
  const rows: RelativeRow[] = [];
  const implied: number[] = [];
  for (const k of keys) {
    // Drop absurd peer multiples (loss-makers rebounding, tiny denominators) before taking the median.
    const peerVals = peers.map((p) => p[k]).filter((v): v is number => isNum(v) && v > 0 && v < (k === "peg" ? 10 : 200));
    const histVals = (history[k] ?? []).filter((v) => isNum(v) && v > 0 && v < 200);
    const peerMedian = peerVals.length >= 3 ? median(peerVals) : null;
    const historyMedian = histVals.length >= 2 ? median(histVals) : null;
    const o = own[k] ?? null;
    const ip = peerMedian != null ? impliedPrice(k, peerMedian, s, epsGrowth) : null;
    const ih = historyMedian != null ? impliedPrice(k, historyMedian, s, epsGrowth) : null;
    if (isNum(ip) && ip > 0) implied.push(ip);
    if (isNum(ih) && ih > 0) implied.push(ih);
    rows.push({
      multiple: k, own: o, peerMedian, peerCount: peerVals.length, historyMedian, historyCount: histVals.length,
      premiumToPeersPct: o != null && peerMedian ? (o / peerMedian - 1) * 100 : null,
      premiumToHistoryPct: o != null && historyMedian ? (o / historyMedian - 1) * 100 : null,
      impliedFromPeers: ip, impliedFromHistory: ih,
    });
  }
  if (implied.length < 2) return { method: "multiples", applicable: false, reason: "fewer than two usable peer/history multiples", rows };
  return {
    method: "multiples", applicable: true,
    perShare: median(implied), low: quantile(implied, 0.25), high: quantile(implied, 0.75),
    detail: { estimates: implied.length }, rows,
  };
}

// ── Blend ───────────────────────────────────────────────────────────────────

export const VERDICT_BANDS = { richBelowPct: 0, cheapAbovePct: 10 } as const;

export type Verdict = "rich" | "fair" | "cheap";

/** The desk's contract: rich < 0% upside, fair 0–10%, cheap > 10%. */
export function verdictFor(upsidePct: number): Verdict {
  if (upsidePct < VERDICT_BANDS.richBelowPct) return "rich";
  if (upsidePct > VERDICT_BANDS.cheapAbovePct) return "cheap";
  return "fair";
}

export type BlendResult = {
  fairValueLow: number;
  fairValueHigh: number;
  fairValueMid: number;
  impliedUpsidePct: number;
  verdict: Verdict;
  method: string;
  weights: Record<string, number>;
};

/**
 * Weighted blend of the applicable models. Non-financials lean on DCF and
 * multiples, financials on residual income; DDM joins only for stable payers.
 * The band is widened to at least ±5% of the midpoint so it never implies
 * more precision than the inputs carry.
 */
export function blendValuation(models: readonly ModelValue[], price: number, financial: boolean): BlendResult | null {
  const base: Record<ModelValue["method"], number> = financial
    ? { residual_income: 0.5, multiples: 0.3, ddm: 0.2, dcf: 0 }
    : { dcf: 0.5, multiples: 0.35, ddm: 0.15, residual_income: 0.1 };
  const usable = models.filter((m) => m.applicable && isNum(m.perShare) && m.perShare > 0 && base[m.method] > 0);
  if (!usable.length || !(price > 0)) return null;
  const total = usable.reduce((a, m) => a + base[m.method], 0);
  const weights: Record<string, number> = {};
  let mid = 0, lo = 0, hi = 0;
  for (const m of usable) {
    const w = base[m.method] / total;
    weights[m.method] = w;
    mid += w * (m.perShare as number);
    lo += w * (m.low ?? (m.perShare as number));
    hi += w * (m.high ?? (m.perShare as number));
  }
  lo = Math.min(lo, mid * 0.95);
  hi = Math.max(hi, mid * 1.05);
  const upside = (mid / price - 1) * 100;
  return {
    fairValueLow: lo, fairValueHigh: hi, fairValueMid: mid,
    impliedUpsidePct: upside, verdict: verdictFor(upside),
    method: usable.map((m) => `${m.method} ${(weights[m.method] * 100).toFixed(0)}%`).join(" + "),
    weights,
  };
}
