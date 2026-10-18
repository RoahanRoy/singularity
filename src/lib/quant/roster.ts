/**
 * The quant desk's roster: one agent per method, in the order a cycle runs
 * them. Pure data, shared by the desk loops (scripts/agents/quant-agents.ts
 * computes each agent, quant-nodes.ts registers and narrates them) and the
 * website's Quant screen.
 */

export type Stage =
  | "Market Data" | "Screen" | "Valuation" | "Qualitative" | "Time Series"
  | "Stochastic" | "Factors" | "Timing" | "Machine Learning" | "Workflow";

export const STAGES: readonly Stage[] = [
  "Market Data", "Screen", "Valuation", "Qualitative", "Time Series", "Stochastic", "Factors", "Timing", "Machine Learning", "Workflow",
];

export type AgentSpec = {
  slug: string;
  name: string;
  stage: Stage;
  role: "research" | "risk" | "ops";
  /** compute = deterministic code in scripts/agents/quant-agents.ts; llm = a prompt run by quant-nodes.ts. */
  kind: "compute" | "llm";
  does: string;
};

/** Every quant agent, in the order a cycle runs them (later agents read earlier results). */
export const QUANT_AGENTS: readonly AgentSpec[] = [
  { slug: "market-data-reader", name: "Market Data Reader", stage: "Market Data", role: "ops", kind: "compute", does: "Pulls prices, statements, profile, news, options, factors, rates and peer data; reports what is missing." },

  { slug: "fundamentals-screener", name: "Fundamentals Screener", stage: "Screen", role: "research", kind: "compute", does: "Margins, ROE/ROA/ROIC, DuPont, liquidity, leverage, efficiency, CAGR, Piotroski F and Altman Z against sector peers. A fail stops the cycle." },
  { slug: "forensic-accountant", name: "Forensic Accountant", stage: "Screen", role: "risk", kind: "compute", does: "Cash quality and manipulation checks: Beneish M, Sloan accruals, FCF / net income, receivable-days drift." },
  { slug: "risk-metrics-analyst", name: "Risk Metrics Analyst", stage: "Screen", role: "risk", kind: "compute", does: "Volatility, beta, Sharpe, Sortino, max drawdown, Calmar and historical, parametric and Cornish-Fisher VaR over three years." },

  { slug: "dcf-modeler", name: "DCF Modeler", stage: "Valuation", role: "research", kind: "compute", does: "FCFF = EBIT(1−t) + D&A − CapEx − ΔNWC, discounted at a CAPM-based WACC with a Gordon terminal value; WACC × g sensitivity." },
  { slug: "ddm-modeler", name: "DDM Modeler", stage: "Valuation", role: "research", kind: "compute", does: "Gordon dividend discount, P = D₁ / (r − g), for stable payers." },
  { slug: "residual-income-modeler", name: "Residual Income Modeler", stage: "Valuation", role: "research", kind: "compute", does: "Book value plus discounted (ROE − r) × book: the model that works for banks." },
  { slug: "multiples-analyst", name: "Multiples Analyst", stage: "Valuation", role: "research", kind: "compute", does: "P/E, EV/EBITDA, P/B, P/S and PEG against same-sector peers and the company's own history." },

  { slug: "moat-analyst", name: "Moat Analyst", stage: "Qualitative", role: "research", kind: "llm", does: "Moat (brand, network effects, switching costs, cost advantage) and Porter's five forces, tested against margin and ROIC history." },
  { slug: "management-analyst", name: "Management Analyst", stage: "Qualitative", role: "research", kind: "llm", does: "Track record, capital allocation (buybacks, dividends, capex, dilution), insider ownership and pay." },
  { slug: "governance-analyst", name: "Governance Analyst", stage: "Qualitative", role: "risk", kind: "llm", does: "Board, audit and shareholder-rights risk from ISS scores, ownership, pay and forensic red flags." },
  { slug: "industry-analyst", name: "Industry Analyst", stage: "Qualitative", role: "research", kind: "llm", does: "Growth stage, disruption risk and cyclicality from peer growth, margins and revenue swings." },
  { slug: "regulatory-esg-analyst", name: "Regulatory & ESG Analyst", stage: "Qualitative", role: "risk", kind: "llm", does: "Regulatory, political and ESG exposure from the business description, headlines and latest filing." },
  { slug: "macro-strategist", name: "Macro Strategist", stage: "Qualitative", role: "research", kind: "llm", does: "Market-level view on rates, inflation, currency, growth, oil and volatility; sets the tilts the macro factor model prices." },
  { slug: "news-sentiment-analyst", name: "News Sentiment Analyst", stage: "Qualitative", role: "research", kind: "llm", does: "Reads the headlines themselves for catalysts and tone the word lexicon misses." },
  { slug: "sentiment-analyst", name: "Sentiment Analyst", stage: "Qualitative", role: "research", kind: "compute", does: "News tone, analyst revisions, insider buying and short interest, combined into one sentiment score." },
  { slug: "earnings-call-analyst", name: "Earnings Call Analyst", stage: "Qualitative", role: "research", kind: "compute", does: "Earnings delivery against consensus (beat rate, surprises) and the tone and hedging of the latest filing." },

  { slug: "arima-forecaster", name: "ARIMA Forecaster", stage: "Time Series", role: "research", kind: "compute", does: "ARIMA(p,1,q) on log prices, scored out of sample against a random walk with a Diebold-Mariano test." },
  { slug: "garch-forecaster", name: "GARCH Forecaster", stage: "Time Series", role: "risk", kind: "compute", does: "GARCH(1,1), σ²ₜ = ω + αε²ₜ₋₁ + βσ²ₜ₋₁: next-day and 21/63-day volatility, persistence and shock half-life." },
  { slug: "smoothing-forecaster", name: "Smoothing Forecaster", stage: "Time Series", role: "research", kind: "compute", does: "Simple and damped-Holt exponential smoothing on log prices, scored out of sample against a random walk." },
  { slug: "kalman-trend-analyst", name: "Kalman Trend Analyst", stage: "Time Series", role: "research", kind: "compute", does: "Kalman local-linear-trend filter: the denoised price level and its drift." },
  { slug: "pairs-scout", name: "Pairs Scout", stage: "Time Series", role: "research", kind: "compute", does: "Engle-Granger cointegration against each peer, validated out of sample; reads the spread's z-score." },
  { slug: "regime-detector", name: "Regime Detector", stage: "Time Series", role: "research", kind: "compute", does: "Two-state Markov regime switching (bull / bear) on weekly returns, for the stock and its index." },

  { slug: "monte-carlo-simulator", name: "Monte Carlo Simulator", stage: "Stochastic", role: "risk", kind: "compute", does: "GARCH and bootstrap Monte Carlo of the price at 1, 3 and 12 months, with the GBM dS = μS·dt + σS·dW reference." },
  { slug: "jump-diffusion-modeler", name: "Jump Diffusion Modeler", stage: "Stochastic", role: "risk", kind: "compute", does: "Merton jump diffusion: how often the stock jumps, how far, and the crash odds a Gaussian misses." },
  { slug: "mean-reversion-modeler", name: "Mean Reversion Modeler", stage: "Stochastic", role: "research", kind: "compute", does: "Ornstein-Uhlenbeck, dX = θ(μ − X)dt + σdW, on the market-model residual and the spread to the peer basket." },
  { slug: "implied-vol-reader", name: "Implied Vol Reader", stage: "Stochastic", role: "risk", kind: "compute", does: "Options-implied volatility (IV30, term slope, skew, put/call) against the GARCH forecast; India uses a VIX-based proxy." },

  { slug: "capm-analyst", name: "CAPM Analyst", stage: "Factors", role: "research", kind: "compute", does: "CAPM regression: beta, Jensen's alpha, systematic share of risk, Treynor ratio, required return." },
  { slug: "style-factor-analyst", name: "Style Factor Analyst", stage: "Factors", role: "research", kind: "compute", does: "Fama-French 3 and 5 and Carhart momentum regressions (India: ETF proxies): alpha, style tilts, alpha stability." },
  { slug: "macro-factor-analyst", name: "Macro Factor Analyst", stage: "Factors", role: "research", kind: "compute", does: "APT regression on macro factor changes; prices the macro strategist's view through the stock's exposures." },

  { slug: "technical-analyst", name: "Technical Analyst", stage: "Timing", role: "research", kind: "compute", does: "SMA/EMA crossovers, RSI, MACD, Bollinger bands, VWAP, OBV and volume, as eight indicator votes." },
  { slug: "momentum-analyst", name: "Momentum Analyst", stage: "Timing", role: "research", kind: "compute", does: "12-1 momentum, against peers and on its own: the technical signal with the strongest academic support." },

  { slug: "linear-ml-modeler", name: "Linear ML Modeler", stage: "Machine Learning", role: "research", kind: "compute", does: "OLS, ridge and lasso on price features pooled with peers, walk-forward validated by IC t-stat." },
  { slug: "tree-ensemble-modeler", name: "Tree Ensemble Modeler", stage: "Machine Learning", role: "research", kind: "compute", does: "CART, random forest and gradient boosting (XGBoost-style) on the same features, walk-forward validated." },
  { slug: "sequence-modeler", name: "Sequence Modeler", stage: "Machine Learning", role: "research", kind: "compute", does: "LSTM and Transformer nets on 20-day feature windows: purged hold-out, early stopping." },
  { slug: "rl-trader", name: "RL Trader", stage: "Machine Learning", role: "research", kind: "compute", does: "Q-learning long/flat policy trained on 70% of history and validated on after-cost timing alpha." },

  { slug: "backtest-auditor", name: "Backtest Auditor", stage: "Workflow", role: "risk", kind: "compute", does: "Walk-forward backtest of the technical rules after costs; checks look-ahead, survivorship, overfitting (deflated Sharpe) and cost drag." },
  { slug: "ensemble-combiner", name: "Ensemble Combiner", stage: "Workflow", role: "ops", kind: "compute", does: "Weights every agent by its out-of-sample evidence (fixed priors for the rest) into one composite score and direction." },
];

export const QUANT_AGENT: Readonly<Record<string, AgentSpec>> = Object.fromEntries(QUANT_AGENTS.map((a) => [a.slug, a]));
export const LLM_AGENT_SLUGS: readonly string[] = QUANT_AGENTS.filter((a) => a.kind === "llm").map((a) => a.slug);
