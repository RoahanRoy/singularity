/**
 * Ensemble: one composite score from every agent that votes.
 *
 * "Edge comes from combining methods" — but not equally. An input whose own
 * out-of-sample test passed (walk-forward IC, timing alpha, Diebold-Mariano)
 * weighs min(1, t/4) of its cap, so a t of 2 earns half; one that failed
 * weighs nothing. Inputs no per-name test can validate (valuation, quality,
 * qualitative judgement, sentiment) carry fixed prior weights that together
 * sum to 1 — about what one well-validated model earns.
 *
 * Technicals and momentum are "gated": the backtest auditor's matching rule
 * family is their test. Technicals have weak academic support alone, so a
 * failed backtest drops them. Momentum keeps its prior when the backtest
 * fails, because the backtest only times the stock against cash — the
 * time-series half of the momentum score — and says nothing about the
 * cross-sectional half (rank among peers), the documented anomaly.
 *
 * Agents that only describe risk (GARCH, Monte Carlo, jumps, implied vol,
 * VaR, CAPM) don't vote: they size the position and set the risk limits.
 */

import { clamp, isNum } from "./stats";

export type Evidence = { passed: boolean; t: number; test: string };

export type EnsembleInput = {
  agent: string;
  label: string;
  /** −100…100, or null when the agent had no opinion (missing data, model not applicable). */
  score: number | null;
  /** A model's own out-of-sample test, or for a gated input the backtest family's; null/absent when none ran. */
  evidence?: Evidence | null;
  /** Fraction of the agent's rule weight it carries (the valuation models split theirs by blend weight). Default 1. */
  share?: number;
};

export type EnsembleRule =
  | { kind: "model"; cap: number }
  | { kind: "gated"; prior: number; cap: number; onFail: "drop" | "prior" }
  | { kind: "prior"; weight: number };

/** The t-stat at which validated evidence earns its full cap. */
export const T_FULL = 4;

/** What a unit of unvalidated (prior) weight counts toward confidence, relative to validated weight. */
export const PRIOR_CONFIDENCE = 0.5;

/** Long at a composite ≥ +20, short ≤ −20 — the quant researcher's contract. */
export const DIRECTION_BAND = 20;

export const ENSEMBLE_RULES: Readonly<Record<string, EnsembleRule>> = {
  // Models with their own out-of-sample test.
  "linear-ml-modeler": { kind: "model", cap: 0.5 },
  "tree-ensemble-modeler": { kind: "model", cap: 0.5 },
  "sequence-modeler": { kind: "model", cap: 0.4 },
  "rl-trader": { kind: "model", cap: 0.4 },
  "arima-forecaster": { kind: "model", cap: 0.3 },
  "smoothing-forecaster": { kind: "model", cap: 0.3 },
  // Validated by the backtest auditor.
  "momentum-analyst": { kind: "gated", prior: 0.15, cap: 0.5, onFail: "prior" },
  "technical-analyst": { kind: "gated", prior: 0.05, cap: 0.4, onFail: "drop" },
  // Priors (sum to 1 with the two gated priors).
  "dcf-modeler": { kind: "prior", weight: 0.25 },
  "ddm-modeler": { kind: "prior", weight: 0.25 },
  "residual-income-modeler": { kind: "prior", weight: 0.25 },
  "multiples-analyst": { kind: "prior", weight: 0.25 },
  "fundamentals-screener": { kind: "prior", weight: 0.08 },
  "sentiment-analyst": { kind: "prior", weight: 0.06 },
  "moat-analyst": { kind: "prior", weight: 0.04 },
  "industry-analyst": { kind: "prior", weight: 0.04 },
  "forensic-accountant": { kind: "prior", weight: 0.04 },
  "earnings-call-analyst": { kind: "prior", weight: 0.04 },
  "macro-factor-analyst": { kind: "prior", weight: 0.04 },
  "management-analyst": { kind: "prior", weight: 0.03 },
  "governance-analyst": { kind: "prior", weight: 0.03 },
  "news-sentiment-analyst": { kind: "prior", weight: 0.03 },
  "regulatory-esg-analyst": { kind: "prior", weight: 0.02 },
  "style-factor-analyst": { kind: "prior", weight: 0.02 },
  "regime-detector": { kind: "prior", weight: 0.02 },
  "kalman-trend-analyst": { kind: "prior", weight: 0.02 },
  "pairs-scout": { kind: "prior", weight: 0.02 },
  "mean-reversion-modeler": { kind: "prior", weight: 0.02 },
};

/** The four valuation models share one 0.25 prior, split by the blend's weights. */
export const VALUATION_AGENTS = ["dcf-modeler", "ddm-modeler", "residual-income-modeler", "multiples-analyst"] as const;

export type Contribution = {
  agent: string;
  label: string;
  score: number | null;
  weight: number;
  /** Points of the composite this input supplies: weight·score / Σweight. */
  contribution: number;
  /** Why the input carries the weight it does. */
  basis: string;
  validated: boolean;
};

export type EnsembleResult = {
  composite: number;
  direction: "long" | "short" | "neutral";
  /**
   * min(1, validated + ½·unvalidated weight) × agreement: how much evidence
   * voted, and how much of it pointed the same way. Priors count half, so a
   * call resting on priors alone tops out at 0.5.
   */
  confidence: number;
  totalWeight: number;
  /** Weight from inputs that passed an out-of-sample test. */
  validatedWeight: number;
  /** |Σ w·s| / Σ w·|s|: 1 when every weighted vote has the same sign. */
  agreement: number;
  /** Every input, largest |contribution| first; zero-weight ones say why. */
  inputs: Contribution[];
  notes: string[];
};

export const directionOf = (score: number): EnsembleResult["direction"] =>
  score >= DIRECTION_BAND ? "long" : score <= -DIRECTION_BAND ? "short" : "neutral";

const fmtT = (t: number) => (isNum(t) ? t.toFixed(2) : "n/a");

function weigh(rule: EnsembleRule, ev: Evidence | null | undefined): { weight: number; basis: string; validated: boolean } {
  if (rule.kind === "prior") return { weight: rule.weight, basis: `prior ${rule.weight}`, validated: false };
  const earned = (cap: number, t: number) => cap * clamp(t / T_FULL, 0, 1);
  if (rule.kind === "model") {
    if (!ev) return { weight: 0, basis: "no out-of-sample test ran", validated: false };
    return ev.passed
      ? { weight: earned(rule.cap, ev.t), basis: `validated: ${ev.test} t ${fmtT(ev.t)}`, validated: true }
      : { weight: 0, basis: `failed ${ev.test} (t ${fmtT(ev.t)})`, validated: false };
  }
  if (!ev) return { weight: rule.prior, basis: `prior ${rule.prior} (no backtest ran)`, validated: false };
  if (ev.passed) {
    const w = Math.max(rule.prior, earned(rule.cap, ev.t));
    return { weight: w, basis: `validated: ${ev.test} t ${fmtT(ev.t)}`, validated: true };
  }
  return rule.onFail === "prior"
    ? { weight: rule.prior, basis: `prior ${rule.prior}: ${ev.test} failed (t ${fmtT(ev.t)}), which tests only the time-series half`, validated: false }
    : { weight: 0, basis: `failed ${ev.test} (t ${fmtT(ev.t)})`, validated: false };
}

export function combine(inputs: readonly EnsembleInput[], rules: Readonly<Record<string, EnsembleRule>> = ENSEMBLE_RULES): EnsembleResult {
  const rows = inputs.map((inp) => {
    const rule = rules[inp.agent];
    const base = { agent: inp.agent, label: inp.label, score: inp.score };
    if (!rule) return { ...base, weight: 0, basis: "not a voting agent", validated: false };
    if (inp.score == null || !isNum(inp.score)) return { ...base, score: null, weight: 0, basis: "no opinion", validated: false };
    const w = weigh(rule, inp.evidence);
    const share = isNum(inp.share) ? clamp(inp.share, 0, 1) : 1;
    return { ...base, score: clamp(inp.score, -100, 100), weight: w.weight * share, basis: share < 1 ? `${w.basis} × share ${share.toFixed(2)}` : w.basis, validated: w.validated };
  });
  const voting = rows.filter((r) => r.weight > 0 && r.score != null);
  const W = voting.reduce((a, r) => a + r.weight, 0);
  const ws = voting.reduce((a, r) => a + r.weight * (r.score as number), 0);
  const wAbs = voting.reduce((a, r) => a + r.weight * Math.abs(r.score as number), 0);
  const composite = W > 0 ? ws / W : 0;
  const agreement = wAbs > 0 ? Math.abs(ws) / wAbs : 0;
  const validatedWeight = voting.filter((r) => r.validated).reduce((a, r) => a + r.weight, 0);
  const out: Contribution[] = rows
    .map((r) => ({ ...r, contribution: W > 0 && r.score != null ? (r.weight * r.score) / W : 0 }))
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution) || b.weight - a.weight);

  const notes: string[] = [];
  if (!(W > 0)) notes.push("no input carried weight: composite defaults to 0 (neutral)");
  else {
    if (validatedWeight === 0) notes.push("no model passed an out-of-sample test: the composite rests on priors (valuation, quality, momentum, judgement)");
    const pos = voting.filter((r) => (r.score as number) > 0).length, neg = voting.filter((r) => (r.score as number) < 0).length;
    if (agreement < 0.3 && pos && neg) notes.push(`inputs disagree (${pos} positive, ${neg} negative): agreement ${agreement.toFixed(2)}`);
  }
  const rounded = Math.round(composite);
  return {
    composite: rounded,
    direction: directionOf(rounded),
    confidence: Math.round(100 * Math.min(1, validatedWeight + PRIOR_CONFIDENCE * (W - validatedWeight)) * agreement) / 100,
    totalWeight: W,
    validatedWeight,
    agreement,
    inputs: out,
    notes,
  };
}

/** Keep an LLM's score within ±band of the composite it was shown. */
export function anchorToComposite(score: number, composite: number, band = DIRECTION_BAND): number {
  if (!isNum(score)) return composite;
  return Math.round(clamp(clamp(score, composite - band, composite + band), -100, 100));
}

/** Valuation score: upside centred on the middle of the fair band (5%), saturating 25 points either side. */
export function upsideScore(upsidePct: number): number {
  return isNum(upsidePct) ? Math.round(100 * clamp((upsidePct - 5) / 25, -1, 1)) : 0;
}
