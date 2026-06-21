"use client";

import { useEffect, useState } from "react";
import Lenis from "lenis";
import "../landing/landing.css";
import "./howitworks.css";

/* ----------------------------------------------------------------
   Content model — every row here maps to something that actually
   runs in scripts/agents/. Keep it truthful: if the code changes,
   change this page.
   ---------------------------------------------------------------- */

const NAV = [
  { id: "website", label: "The website" },
  { id: "pipeline", label: "The pipeline" },
  { id: "agents", label: "The agents" },
  { id: "loops", label: "The loops" },
  { id: "operator", label: "Operator runbook" },
];

// The five operator screens (route `/`) and what each reads.
const SCREENS = [
  {
    n: "01",
    h: "Swarm Command",
    p: "Air-traffic control for the agent fleet. Clusters, live agent roster, and a realtime firehose of every status change and event.",
    src: "clusters · agents · agent_events",
  },
  {
    n: "02",
    h: "Research Engine",
    p: "The ingest queue and the memos it produces — filings linked to theses, with the extracted entity graph behind each one.",
    src: "filings · memos · entities",
  },
  {
    n: "03",
    h: "Portfolio OS",
    p: "The live book: NAV, net factor exposures, the P&L curve, stress scenarios, and any trades waiting on an operator vote.",
    src: "positions · fund_snapshots · scenarios · trades",
  },
  {
    n: "04",
    h: "Operator Console",
    p: "Where a human talks to the system. A chat thread answered by the responder agent, plus the governance log and the spend ledger.",
    src: "operator_messages · governance_events · budget_ledger",
  },
  {
    n: "05",
    h: "Compute Layer",
    p: "The infrastructure view — the GPU fabric, model routing per agent, the running pipelines, and the knowledge graph the memos build.",
    src: "compute_nodes · model_routes · pipelines",
  },
];

// The bounded decision chain, in execution order. Mirrors runCycle() in
// tech-loop.ts / india-loop.ts. `tier` is the prompt's default model.
const PIPELINE = [
  { n: "00", name: "Budget Controller", tier: "haiku", role: "gate", what: "Runs before every cycle. Reads the 24h token ledger and returns allow / throttle / kill. The loop obeys it — over budget, the whole thing stops." },
  { n: "01", name: "Filing Parser", tier: "haiku", role: "research", what: "US: an HTTP-only EDGAR reader pulls the latest 10-K/Q/8-K, then a tool-less summarizer turns the untrusted excerpt into structured JSON. India: a from-knowledge company brief (no filing fetch)." },
  { n: "02", name: "Earnings Reviewer", tier: "sonnet", role: "research", what: "Reads the earnings-call transcript and scores tone and deflection. Feeds the analyst as a supplemental signal — it does not write the thesis." },
  { n: "03", name: "Sector Analyst", tier: "opus", role: "research", what: "The right specialist for the ticker (one of six sector desks) drafts the investment memo: explicit catalyst, quantified risk, and a conviction score. No sizing." },
  { n: "04", name: "Quant Researcher", tier: "opus", role: "research", what: "An orthogonal, factor-based read on the same name — a composite score and the factor exposures that drive it, independent of the narrative." },
  { n: "05", name: "Red-Team Critic", tier: "opus", role: "gate", what: "Adversarially stress-tests the memo. Returns a robustness score and a verdict. A 'revise' triggers exactly one re-run of the analyst, then it stages for review." },
  { n: "06", name: "Valuation Reviewer", tier: "opus", role: "research", what: "A quick DCF / peer-multiple sanity check on the memo's implied entry. Returns a fairness band so nobody sizes into an obviously rich print." },
  { n: "07", name: "CIO / Committee", tier: "opus", role: "gate", what: "Synthesizes memo + critique + valuation + quant signal into one go / no-go. The gate the PM must respect before any capital is sized." },
  { n: "08", name: "Portfolio Manager", tier: "opus", role: "decision", what: "Sizes the position from the approved memo, applying NAV and per-name weight limits. Output is a proposal — risk and compliance still gate it." },
  { n: "09", name: "Treasury", tier: "sonnet", role: "decision", what: "Decides how the position is funded: cash vs margin, borrow availability for shorts, and the financing drag in basis points." },
  { n: "10", name: "Risk Officer", tier: "haiku", role: "gate", what: "Pre-trade risk. Estimates 1-day 95% VaR on the proposed position and approves only if it sits inside policy." },
  { n: "11", name: "Risk Overlay", tier: "code", role: "gate", what: "Deterministic, no-LLM portfolio check: gross leverage, name count, position weight, and book-level VaR caps. Vetoes anything that breaches a limit." },
  { n: "12", name: "Compliance", tier: "haiku", role: "gate", what: "Pre-trade rules: restricted list, position limits, wash sale, Reg SHO. It can block, but it never approves sizing." },
  { n: "13", name: "Smart Router", tier: "haiku", role: "execution", what: "Chooses venue and algorithm (TWAP / VWAP / IS) for the approved trade. No discretion over size — only how it reaches the market." },
  { n: "14", name: "Paper Broker", tier: "code", role: "execution", what: "Stub fills, no LLM. Simulates the execution and writes the trade so the book and the P&L move." },
  { n: "15", name: "TCA", tier: "haiku", role: "post", what: "Post-trade cost analysis: slippage vs benchmark, fees, market impact. Records the cost of the fill — no discretion over the trade itself." },
  { n: "16", name: "Attribution & Recon", tier: "haiku", role: "post", what: "Reconciles intended vs executed, ties the trade out against the book, and attributes the new position's expected return to its factor sources. Closes the loop." },
];

const SECTORS = ["Tech", "Healthcare", "Energy", "Financials", "Consumer", "Industrials"];

// The long-running workers. Each is a real npm script under scripts/agents/.
const LOOPS = [
  {
    name: "Tech Loop",
    cmd: "agents:tech",
    cadence: "~60s / cycle",
    what: "The US desk orchestrator. Each cycle refreshes IBKR holdings, picks one US ticker round-robin, and runs it through the full 16-stage chain — writing every step to Appwrite so the screens tick live.",
    why: "It's the engine. Everything on Swarm / Research / Portfolio is the exhaust of this loop running over the US universe.",
    when: "Started from the Operator Console (or `npm run agents:tech`). Runs continuously; a stop finishes the current cycle then exits cleanly.",
  },
  {
    name: "India Loop",
    cmd: "agents:india",
    cadence: "~60s / cycle",
    what: "The same chain for the NSE book (market=IN). Refreshes connected Kite holdings each cycle and round-robins the held NSE names. The parser skips EDGAR and reasons LLM-only over the company.",
    why: "India filings aren't on EDGAR, so the desk needs its own roster, universe, and a knowledge-based brief step in place of the filing fetch.",
    when: "Started independently of the US loop, typically after the morning Kite re-login so it trades against a fresh book.",
  },
  {
    name: "Console Responder",
    cmd: "agents:responder",
    cadence: "polls 3s",
    what: "Watches operator_messages and replies to any operator turn that has no assistant follow-up. Each reply is grounded in a fresh snapshot of memos, positions, news, and governance for the active desk.",
    why: "It's the human-facing voice of the system — the thing an operator actually talks to in the Console.",
    when: "Auto-starts when the Next server boots (disable with MERIDIAN_AUTOSTART=0). No backfill: it only answers messages newer than its boot watermark.",
  },
  {
    name: "News Ingestor",
    cmd: "agents:news",
    cadence: "~30 min",
    what: "Fetches Google News RSS per ticker for both books and indexes results into the news collection. Deduped on a hash of the URL, so re-runs are safe. No API key, no LLM.",
    why: "Gives the responder and the desks a live, free headline feed without paying for a news API.",
    when: "Run continuously alongside the desks, or once with MERIDIAN_NEWS_ONCE=1.",
  },
  {
    name: "Held-Book Ingest",
    cmd: "agents:ingest",
    cadence: "~30 min",
    what: "Walks the positions book and tops up the filings collection with the latest disclosure for every held ticker — SEC EDGAR for US, NSE corporate announcements for India. Pure HTTP + upsert, no LLM.",
    why: "Keeps the Research Engine's ingest queue populated with whatever is actually on the book, not just whatever the loop happened to touch.",
    when: "Runs continuously in the background; failures (e.g. NSE rate-limits) skip the ticker rather than write a placeholder.",
  },
  {
    name: "Remote Dispatcher",
    cmd: "agents:dispatch",
    cadence: "polls 2s",
    what: "The bridge between a Vercel-hosted Console and the agents that must run on the machine where `claude login` lives. Drains command rows from Appwrite, manages the child processes via the supervisor, and republishes their live status back.",
    why: "A serverless UI can't spawn long-lived processes. This lets the deployed Console start/stop the loops on your laptop.",
    when: "Only needed when the UI is hosted remotely. Keep it running on the machine that owns the broker sessions and the LLM login.",
  },
];

const GUARDRAILS = [
  { h: "Trust tiers", p: "Untrusted filing bytes never reach an agent with tools. The EDGAR reader is HTTP-only (no LLM, no DB); the summarizer is LLM-only (no fetch, no DB); the indexer is persistence-only. A prompt-injection in a filing can at worst produce nonsense JSON that fails schema check." },
  { h: "Human-in-the-loop", p: "A trade auto-executes only if the critic passes, conviction × score ≥ 0.4, AND MERIDIAN_AUTO_APPROVE=1 is set for the session. Anything weaker writes the memo as 'review' and stops. The env var is standing approval for one session, never the default." },
  { h: "One job per agent", p: "Analysts don't size. PMs don't execute. Risk doesn't re-size. Compliance doesn't approve sizing. Each boundary is stated in the agent's own prompt, and each prompt lives in its own file — never inlined in code." },
  { h: "Bounded revision", p: "A critic 'revise' verdict triggers exactly one re-run of the analyst with the concerns attached. If the second pass still doesn't clear, the memo is staged for an operator. Bounded retries beat infinite negotiation." },
  { h: "Budget kill switch", p: "The budget controller runs before every cycle and gates on real subscription token usage over 24h. Over the cap, it throttles the cadence or kills the loop outright — heavier models burn it faster." },
];

// What a human actually has to do.
const RUNBOOK = [
  { n: "01", h: "Sign in as an operator", p: "Auth is an email allowlist (NEXT_PUBLIC_OPERATOR_EMAILS). Signed-in users outside the list are signed straight back out. Everything behind `/` is gated; `/guided` is the open, plain-English tour." },
  { n: "02", h: "Connect the US book (IBKR)", p: "IBKR has no hosted OAuth, so positions come through a local Client Portal Gateway you run on your laptop. Log into the gateway, then hit '+ Connect IBKR account' in Portfolio OS once it reads authenticated. The app stores no password — only the account id." },
  { n: "03", h: "Connect the India book (Kite)", p: "Link each Zerodha account via Kite Connect. Personal apps are single-user, so a second account holder adds their own app key. Kite access tokens expire daily — expect a fresh login every trading morning before starting the India loop." },
  { n: "04", h: "Start the loops", p: "Bring the desks online from the Operator Console (start / stop / restart) or via npm. The responder is already up; start the tech and/or india loops, and the news + ingest workers if you want the feeds fresh." },
  { n: "05", h: "Decide the autonomy level", p: "By default the system stages every trade for review — you approve in Portfolio OS. To let it execute on its own for a session, set MERIDIAN_AUTO_APPROVE=1. It only fires on high-conviction, critic-passed trades even then." },
  { n: "06", h: "Supervise, don't micromanage", p: "Watch the budget ledger and the governance log. Talk to the system in the Console. Veto, trim, or unwind through the risk layer. Re-login the brokers when sessions go stale. The loop does the reading; you hold the kill switch." },
];

const TIER_NOTE: Record<string, string> = {
  haiku: "Cheap, fast — gates and mechanical steps.",
  sonnet: "Mid-tier — judgement without the full cost.",
  opus: "Most capable — the research and decision core.",
  code: "Deterministic code, no LLM.",
};

function useLenis() {
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const lenis = new Lenis({ duration: 1.15, smoothWheel: true });
    let raf = 0;
    const loop = (time: number) => {
      lenis.raf(time);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      lenis.destroy();
    };
  }, []);
}

function useScrollReveal() {
  useEffect(() => {
    const els = Array.from(document.querySelectorAll<HTMLElement>(".lp [data-reveal]"));
    if (!("IntersectionObserver" in window) || els.length === 0) {
      els.forEach((el) => el.classList.add("is-in"));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-in");
            io.unobserve(entry.target);
          }
        }
      },
      { threshold: 0.12, rootMargin: "0px 0px -6% 0px" }
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);
}

export default function HowItWorksClient() {
  const [stuck, setStuck] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">("dark");

  useLenis();
  useScrollReveal();

  useEffect(() => {
    const stored = window.localStorage.getItem("lp-theme");
    if (stored === "dark" || stored === "light") setTheme(stored);
    else if (window.matchMedia("(prefers-color-scheme: dark)").matches) setTheme("dark");
  }, []);

  const toggleTheme = () =>
    setTheme((t) => {
      const next = t === "light" ? "dark" : "light";
      window.localStorage.setItem("lp-theme", next);
      return next;
    });

  useEffect(() => {
    const onScroll = () => setStuck(window.scrollY > 40);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const year = new Date().getFullYear();

  return (
    <div className="lp hiw" data-theme={theme}>
      <div className="lp-grain" aria-hidden />

      {/* nav */}
      <nav className={`lp-nav${stuck ? " is-stuck" : ""}`}>
        <a className="lp-brand" href="/">
          <span className="lp-mark" aria-hidden />
          Meridian
        </a>
        <div className="lp-navlinks">
          {NAV.map((l) => (
            <a key={l.id} href={`#${l.id}`}>
              {l.label}
            </a>
          ))}
        </div>
        <div className="lp-nav-right">
          <button
            type="button"
            className="lp-themetoggle"
            onClick={toggleTheme}
            aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
          >
            {theme === "dark" ? "☀" : "☾"}
          </button>
          <a className="lp-btn" href="/desk">
            <span className="dot" aria-hidden />
            Enter the desk
          </a>
        </div>
      </nav>

      <main className="lp-main">
        {/* hero */}
        <header className="hiw-hero lp-wrap">
          <a className="hiw-back" href="/">
            ← Back to home
          </a>
          <span className="lp-eyebrow" data-reveal>
            Meridian · How the system works
          </span>
          <h1 data-reveal data-reveal-delay="1">
            Every agent, every loop,
            <br />
            and <em>who does what.</em>
          </h1>
          <p className="hiw-lede" data-reveal data-reveal-delay="2">
            Meridian is an AI-native hedge-fund operating system: a swarm of
            specialized agents reads filings, builds conviction, sizes and
            risk-checks trades, and reports — while a small team of human
            operators supervises with a hand on the kill switch. This page is
            the honest map of what runs, why it runs, when it runs, and what a
            human still has to do.
          </p>
          <div className="hiw-jump" data-reveal data-reveal-delay="3">
            {NAV.map((l) => (
              <a key={l.id} href={`#${l.id}`} className="hiw-chip">
                {l.label}
              </a>
            ))}
          </div>
        </header>

        {/* 1 — the website */}
        <section className="lp-section" id="website">
          <div className="lp-wrap">
            <div className="lp-section-head">
              <h2 className="lp-section-title" data-reveal>
                Two doors into <em>one brain</em>
              </h2>
              <span className="lp-index" data-reveal>
                [ 01 — The website ]
              </span>
            </div>

            <div className="hiw-prose" data-reveal>
              <p>
                The site has two front doors. <b>/</b> is the operator cockpit —
                a dense, five-screen view gated behind an operator sign-in.{" "}
                <b>/guided</b> is a calm, one-idea-at-a-time tour that explains
                the same system in plain English, with a hover glossary on every
                piece of jargon. Both read the <em>same live data</em> out of
                Appwrite over realtime websockets; the cockpit just shows all of
                it at once.
              </p>
              <p>
                There is no separate backend service. Persistence, auth,
                realtime, and the spend ledger all collapse into Appwrite. The
                agents run as Node worker processes next to the app (so they can
                use your local <code>claude login</code> and broker sessions),
                and everything they decide is written back to a collection that
                a screen is already subscribed to. Change the data, the screen
                moves.
              </p>
            </div>

            <div className="hiw-screens">
              {SCREENS.map((s, i) => (
                <article className="hiw-screen" key={s.h} data-reveal data-reveal-delay={i % 3}>
                  <span className="hiw-screen-n">{s.n}</span>
                  <h3>{s.h}</h3>
                  <p>{s.p}</p>
                  <span className="hiw-src">{s.src}</span>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* 2 — the pipeline */}
        <section className="lp-section lp-section--plain" id="pipeline">
          <div className="lp-wrap">
            <div className="lp-section-head">
              <h2 className="lp-section-title" data-reveal>
                One ticker, <em>sixteen</em> hand-offs
              </h2>
              <span className="lp-index" data-reveal>
                [ 02 — The pipeline ]
              </span>
            </div>

            <div className="hiw-prose" data-reveal>
              <p>
                Each cycle of a desk loop takes a single name and walks it down a
                bounded chain. Trust <em>decreases</em> as data moves rightward
                and authority <em>increases</em>: research first, then decision,
                then a wall of gates, then execution, then the post-trade
                accounting. No stage can do another stage's job, and a trade only
                reaches the broker if every gate clears.
              </p>
            </div>

            <ol className="hiw-chain">
              {PIPELINE.map((step) => (
                <li className={`hiw-step hiw-role-${step.role}`} key={step.n} data-reveal>
                  <div className="hiw-step-rail">
                    <span className="hiw-step-n">{step.n}</span>
                  </div>
                  <div className="hiw-step-body">
                    <div className="hiw-step-head">
                      <h3>{step.name}</h3>
                      <span className={`hiw-tier hiw-tier-${step.tier}`}>{step.tier}</span>
                      <span className="hiw-role-tag">{step.role}</span>
                    </div>
                    <p>{step.what}</p>
                  </div>
                </li>
              ))}
            </ol>

            <div className="hiw-legend" data-reveal>
              <span><i className="hiw-dot hiw-d-research" />research</span>
              <span><i className="hiw-dot hiw-d-decision" />decision</span>
              <span><i className="hiw-dot hiw-d-gate" />gate</span>
              <span><i className="hiw-dot hiw-d-execution" />execution</span>
              <span><i className="hiw-dot hiw-d-post" />post-trade</span>
            </div>
          </div>
        </section>

        {/* 3 — the agents (model tiers + sector analysts + guardrails) */}
        <section className="lp-section" id="agents">
          <div className="lp-wrap">
            <div className="lp-section-head">
              <h2 className="lp-section-title" data-reveal>
                The right model for <em>each job</em>
              </h2>
              <span className="lp-index" data-reveal>
                [ 03 — The agents ]
              </span>
            </div>

            <div className="hiw-prose" data-reveal>
              <p>
                Every agent declares a default model in its own prompt file —
                <code>haiku</code>, <code>sonnet</code>, or <code>opus</code> —
                and that default can be overridden per-agent or globally with an
                env var, no rebuild. Cheap models run the mechanical gates;
                the expensive ones run research and the investment decision.
              </p>
            </div>

            <div className="hiw-tiers">
              {(["opus", "sonnet", "haiku", "code"] as const).map((t) => (
                <div className="hiw-tier-card" key={t} data-reveal>
                  <span className={`hiw-tier hiw-tier-${t}`}>{t}</span>
                  <p>{TIER_NOTE[t]}</p>
                  <span className="hiw-tier-count">
                    {PIPELINE.filter((s) => s.tier === t).length} stages
                  </span>
                </div>
              ))}
            </div>

            <div className="hiw-subhead" data-reveal>
              <h3>Six sector desks, one router</h3>
              <p>
                The single &ldquo;Sector Analyst&rdquo; stage above is really six
                specialists. The orchestrator routes each ticker to the right one
                by sector — each is its own opus-tier agent with its own coverage
                universe and its own row in the fleet.
              </p>
            </div>
            <div className="hiw-sectors" data-reveal>
              {SECTORS.map((s) => (
                <span className="hiw-sector" key={s}>
                  {s}
                </span>
              ))}
            </div>

            <div className="hiw-subhead" data-reveal>
              <h3>The rules every agent runs under</h3>
              <p>
                Autonomy is only safe because of the constraints around it. These
                five are non-negotiable and enforced in code, not just in prompts.
              </p>
            </div>
            <div className="hiw-guards">
              {GUARDRAILS.map((g, i) => (
                <article className="hiw-guard" key={g.h} data-reveal data-reveal-delay={i % 3}>
                  <h4>{g.h}</h4>
                  <p>{g.p}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* 4 — the loops */}
        <section className="lp-section lp-section--plain" id="loops">
          <div className="lp-wrap">
            <div className="lp-section-head">
              <h2 className="lp-section-title" data-reveal>
                The loops that <em>keep it alive</em>
              </h2>
              <span className="lp-index" data-reveal>
                [ 04 — The loops ]
              </span>
            </div>

            <div className="hiw-prose" data-reveal>
              <p>
                The pipeline above is one cycle. These long-running workers are
                what fire it on repeat, keep the data fresh, and connect a
                hosted UI to processes that have to run on your machine. Each is
                a real worker you can start and stop.
              </p>
            </div>

            <div className="hiw-loops">
              {LOOPS.map((l, i) => (
                <article className="hiw-loop" key={l.name} data-reveal data-reveal-delay={i % 2}>
                  <div className="hiw-loop-top">
                    <h3>{l.name}</h3>
                    <span className="hiw-cadence">{l.cadence}</span>
                  </div>
                  <code className="hiw-cmd">npm run {l.cmd}</code>
                  <dl className="hiw-wwh">
                    <div>
                      <dt>What</dt>
                      <dd>{l.what}</dd>
                    </div>
                    <div>
                      <dt>Why</dt>
                      <dd>{l.why}</dd>
                    </div>
                    <div>
                      <dt>When</dt>
                      <dd>{l.when}</dd>
                    </div>
                  </dl>
                </article>
              ))}
            </div>

            <div className="hiw-cron" data-reveal>
              <span className="hiw-cron-tag">+ scheduled</span>
              <p>
                <b>Weekly India enrichment</b> runs on a Vercel cron, not as a
                worker. It re-pulls ~34 price histories to refresh betas and
                snapshots for the India book, guarded by a <code>CRON_SECRET</code>{" "}
                bearer token so the write endpoint can&rsquo;t be hit anonymously.
              </p>
            </div>
          </div>
        </section>

        {/* 5 — operator runbook */}
        <section className="lp-section" id="operator">
          <div className="lp-wrap">
            <div className="lp-section-head">
              <h2 className="lp-section-title" data-reveal>
                What an <em>operator</em> actually does
              </h2>
              <span className="lp-index" data-reveal>
                [ 05 — Operator runbook ]
              </span>
            </div>

            <div className="hiw-prose" data-reveal>
              <p>
                The system reads, reasons, and stages — but a human owns capital,
                connections, and the kill switch. Here&rsquo;s the whole job, in
                order.
              </p>
            </div>

            <div className="hiw-steps">
              {RUNBOOK.map((s) => (
                <div className="hiw-runstep" key={s.n} data-reveal>
                  <span className="hiw-runstep-n">/ {s.n}</span>
                  <div>
                    <h4>{s.h}</h4>
                    <p>{s.p}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* CTA */}
        <section className="lp-cta">
          <div className="lp-wrap">
            <span className="lp-eyebrow" data-reveal>
              That&rsquo;s the whole machine
            </span>
            <h2 data-reveal data-reveal-delay="1">
              See it <em>running.</em>
            </h2>
            <div className="lp-hero-cta" style={{ justifyContent: "center" }} data-reveal data-reveal-delay="2">
              <a className="lp-btn lp-btn--solid" href="/desk">
                <span className="dot" aria-hidden />
                Enter the desk
              </a>
              <a className="lp-btn" href="/guided">
                Take the guided tour
              </a>
            </div>
          </div>
        </section>

        {/* footer */}
        <footer className="lp-footer">
          <div className="lp-wrap">
            <div className="lp-footer-bottom" style={{ marginTop: 0 }}>
              <span>© {year} Meridian Capital Intelligence</span>
              <span>
                <a href="/">Home</a> · <a href="/guided">Guided tour</a> ·{" "}
                <a href="/desk">Operator desk</a>
              </span>
            </div>
          </div>
        </footer>
      </main>
    </div>
  );
}
