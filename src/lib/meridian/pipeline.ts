// The bounded decision chain every desk cycle runs, shared by the public
// pages. Keep it truthful: if runCycle() changes, change this.

import { QUANT_AGENTS } from "@/lib/quant/roster";

export type Role = "research" | "decision" | "gate" | "execution" | "post";
export type Tier = "opus" | "sonnet" | "haiku" | "code";

export const ROLES: Role[] = ["research", "decision", "gate", "execution", "post"];
export const roleLabel = (r: Role) => (r === "post" ? "Post-trade" : r[0].toUpperCase() + r.slice(1));
// Paper-token dot colour per role.
export const ROLE_DOT: Record<Role, string> = {
  research: "var(--accent)",
  decision: "var(--ink)",
  gate: "var(--warn)",
  execution: "var(--up)",
  post: "var(--ink-3)",
};

// In execution order. The tier is the prompt's default model.
export const PIPE: [string, string, Tier, Role, string][] = [
  ["00", "Budget Controller", "haiku", "gate", "Runs before every cycle. Checks the 24h token ledger and returns allow, throttle or kill. Over budget, everything stops."],
  ["01", "Filing Parser", "haiku", "research", "US: an HTTP-only EDGAR reader pulls the latest 10-K/Q/8-K, then a tool-less summariser turns it into structured JSON. India: a company brief from knowledge."],
  ["02", "Quant Desk", "code", "research", `${QUANT_AGENTS.length} agents, one method each, measure the name before anyone writes: ratios and forensic scores, DCF, DDM, residual income and multiples, GARCH and ARIMA, Monte Carlo and jumps, factor regressions, technicals, walk-forward ML, and seven LLM analysts for moat, management, governance and the rest. An ensemble blends what passed its out-of-sample test. A failed screen ends the cycle here.`],
  ["03", "Earnings Reviewer", "sonnet", "research", "Reads the earnings-call transcript and scores tone and deflection. A supplemental signal — it doesn't write the thesis."],
  ["04", "Sector Analyst", "opus", "research", "One of six sector specialists drafts the memo, with the quant desk's numbers in hand as cited facts: explicit catalyst, quantified risk, conviction score. No sizing."],
  ["05", "Quant Researcher", "code", "research", "Turns the quant desk's ensemble into the factor signal in code: the composite, the inputs that moved it, and how much of the weight passed validation. No ensemble, no signal."],
  ["06", "Red-Team Critic", "opus", "gate", "Stress-tests the memo against the quant facts and returns a robustness score. A 'revise' triggers exactly one re-run, then it goes to review."],
  ["07", "Valuation Reviewer", "opus", "research", "Reviews the fair-value band the valuation agents computed and judges how well those models fit this business. A poor fit downgrades 'cheap' to 'fair'. With no computed band the memo is staged for review."],
  ["08", "CIO / Committee", "opus", "gate", "Combines memo, critique, valuation and quant signal into one go / no-go. The PM must respect it."],
  ["09", "Portfolio Manager", "code", "decision", "Sizes to the session's construction plan: the weight that buys the most expected excess return (confidence × valuation upside) per unit of tracking risk, capped at the largest add the risk budget clears on the fund book now. No plan, no size. It's a proposal — risk and compliance still gate it."],
  ["10", "Treasury", "code", "decision", "Funds the trade from the mandate's cash, then by selling the index-ETF core, in code: blocks it with no mandate or too little of both, and prices the cash at the measured short rate."],
  ["11", "Risk Officer", "code", "gate", "Re-measures the fund book with the trade added against the operator's one risk choice, a target tracking error vs the index: approves when the book's tracking error stays within it (or doesn't rise) and no one name carries more active risk than the whole target. A name without a year of history, or a book without live quotes, is staged for review."],
  ["12", "Risk Overlay", "code", "gate", "Deterministic book-level check: the buy fits in the fund's cash plus its index core (no margin, gross at most 100%) and every held name has a live quote. Vetoes any breach."],
  ["13", "Compliance", "code", "gate", "Checks the operator's stored restricted list (blocks, and fails closed if unreadable), the fund book's prior position and 30-day wash-sale history. It can block, but never approves sizing."],
  ["14", "Smart Router", "haiku", "execution", "Picks venue and algorithm (TWAP / VWAP / IS). No say over size — only how it reaches the market."],
  ["15", "Paper Broker", "code", "execution", "Paper fills at the live quote, no LLM. No quote, no fill. A buy past cash sells the index core first. Writes the trades so the book and P&L move."],
  ["16", "TCA", "code", "post", "Measures the fill against the arrival quote the PM sized on. Paper fills carry no fees or modelled impact yet."],
  ["17", "Attribution & Recon", "haiku", "post", "Reconciles intended vs executed and attributes expected return to its factor sources. Closes the loop."],
];

export const TIERS: [Tier, string][] = [
  ["opus", "Most capable — the research and decision core."],
  ["sonnet", "Mid-tier — judgement without the full cost."],
  ["haiku", "Cheap and fast — gates and mechanical steps."],
  ["code", "Deterministic code, no LLM."],
];
