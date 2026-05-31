"use client";

import Link from "next/link";
import { useState } from "react";
import { GlossTerm as G } from "@/components/meridian/GlossTerm";
import { AuthGate } from "@/components/meridian/AuthGate";
import "./guided.css";

type Step = { id: string; num: string; label: string; eyebrow: string };

const STEPS: Step[] = [
  { id: "swarm",     num: "01", label: "The Swarm",        eyebrow: "AGENT INTELLIGENCE" },
  { id: "research",  num: "02", label: "The Research",     eyebrow: "AUTONOMOUS ANALYSIS" },
  { id: "portfolio", num: "03", label: "The Portfolio",    eyebrow: "CAPITAL ALLOCATION" },
  { id: "console",   num: "04", label: "The Operator",     eyebrow: "HUMAN + AI" },
  { id: "compute",   num: "05", label: "The Compute",      eyebrow: "INFRASTRUCTURE" },
  { id: "start",     num: "06", label: "Build a Fund",     eyebrow: "GETTING STARTED" },
];

function SwarmSlide() {
  return (
    <>
      <p className="lede">
        Six thousand AI <G>agents</G> work in parallel — reading filings, parsing earnings, watching the news — clustered by
        what they specialize in. A human <G term="orchestrator">orchestrator</G> watches them like air-traffic
        control.
      </p>
      <ul className="bullets">
        <li>Each cluster is a team of specialists — <G>macro</G>, equities, <G>vol</G>, <G>credit</G>, <G>alt-data</G>.</li>
        <li>When agents converge on an idea, <G>conviction</G> climbs and the idea is escalated to a human.</li>
        <li>Disagreement — known as <G>dissent</G> — is logged and shown to the operator, not hidden.</li>
      </ul>
    </>
  );
}

function ResearchSlide() {
  return (
    <>
      <p className="lede">
        Whenever a company files something — a <G term="10-k">10-K</G>, <G term="8-k">8-K</G>, <G term="13f">13F</G>, or
        runs an <G term="earnings call">earnings call</G> — agents read it in seconds and look for what management is{" "}
        <em>not</em> saying.
      </p>
      <ul className="bullets">
        <li>Phrase frequencies are compared to historical baselines: hedge language gets flagged.</li>
        <li>Tone is scored against prior calls; deflections and softening guidance show up as numbers.</li>
        <li>If a pattern crosses a threshold, the system auto-drafts an <G>thesis</G> with a suggested expression.</li>
      </ul>
    </>
  );
}

function PortfolioSlide() {
  return (
    <>
      <p className="lede">
        The fund&apos;s positions are continuously rebalanced. The dashboard shows live <G>nav</G>,{" "}
        <G term="pnl">P&amp;L</G>, <G term="factor exposure">factor exposures</G>, and a tree of probable 24-hour outcomes.
      </p>
      <ul className="bullets">
        <li><G>sharpe</G> and <G>sortino</G> measure return per unit of risk — higher is better.</li>
        <li><G>var</G> caps how much can be lost on a normal bad day; <G>drawdown</G> tracks the worst run.</li>
        <li><G>leverage</G> is bounded, and every <G>rebalance</G> passes through a pre-trade risk overlay.</li>
      </ul>
    </>
  );
}

function ConsoleSlide() {
  return (
    <>
      <p className="lede">
        A human <em>operator</em> doesn&apos;t click buttons. They give the system intent in plain language and supervise.
        The agents do the work and surface action cards for approval.
      </p>
      <ul className="bullets">
        <li>&ldquo;Reduce China-linked semi exposure 15%, preserve idiosyncratic <G>alpha</G>.&rdquo;</li>
        <li>The system models execution paths, scores <G>slippage</G>, and asks for one click to authorize.</li>
        <li>If two agents <G>dissent</G>, a human review is required before anything fires.</li>
      </ul>
    </>
  );
}

function ComputeSlide() {
  return (
    <>
      <p className="lede">
        Underneath sits a small data center — thousands of GPUs running <G>inference</G> across specialist models,
        backed by a <G term="vector store">vector store</G> of every filing ever filed.
      </p>
      <ul className="bullets">
        <li>Requests are routed model-by-model: heavy reasoning to Opus, fast <G term="ingest">ingestion</G> to Haiku.</li>
        <li><G>latency</G> from idea to executed order is measured in milliseconds, not minutes.</li>
        <li>Connections to 13 <G term="venue">execution venues</G> are kept warm and monitored continuously.</li>
      </ul>
    </>
  );
}

function StartSlide() {
  return (
    <>
      <p className="lede">
        Building a fund on MERIDIAN, end to end. You bring the capital and a mandate; the swarm brings the
        research, execution, and round-the-clock vigilance. Here is the operator&apos;s path from an empty
        book to a live fund.
      </p>
      <ul className="bullets">
        <li>
          <strong>Step 1 — Set your mandate.</strong> Sign in as an operator and state your intent in plain
          language in the Console: strategy, universe, and hard risk limits — max <G>leverage</G> and a daily{" "}
          <G>var</G> cap.
        </li>
        <li>
          <strong>Step 2 — Let the Swarm orient.</strong> Specialist clusters — <G>macro</G>, equities,{" "}
          <G>vol</G>, <G>credit</G>, <G>alt-data</G> — pick up your mandate and surface ideas as{" "}
          <G>conviction</G> builds.
        </li>
        <li>
          <strong>Step 3 — Review the Research.</strong> Agents read every filing and{" "}
          <G term="earnings call">earnings call</G> and auto-draft a <G>thesis</G>; you accept, reject, or send
          it back for more work.
        </li>
        <li>
          <strong>Step 4 — Shape the Portfolio.</strong> Approved theses become positions. Watch live{" "}
          <G>nav</G>, <G term="pnl">P&amp;L</G>, and <G term="factor exposure">factor exposures</G>, and tune{" "}
          <G>sharpe</G> and <G>drawdown</G> targets to taste.
        </li>
        <li>
          <strong>Step 5 — Authorize execution.</strong> The system models each trade, scores <G>slippage</G>,
          and asks for one click — any agent <G>dissent</G> forces a human review before anything fires.
        </li>
        <li>
          <strong>Step 6 — Supervise, don&apos;t micromanage.</strong> Track spend on the Compute layer and let
          the swarm run the book while you set direction.
        </li>
      </ul>
    </>
  );
}

const SLIDES: Record<string, () => React.ReactElement> = {
  swarm: SwarmSlide,
  research: ResearchSlide,
  portfolio: PortfolioSlide,
  console: ConsoleSlide,
  compute: ComputeSlide,
  start: StartSlide,
};

export default function GuidedPage() {
  return (
    <AuthGate>
      <GuidedInner />
    </AuthGate>
  );
}

function GuidedInner() {
  const [active, setActive] = useState<string>("swarm");
  const idx = STEPS.findIndex((s) => s.id === active);
  const step = STEPS[idx];
  const Slide = SLIDES[active];
  const prev = idx > 0 ? STEPS[idx - 1] : null;
  const next = idx < STEPS.length - 1 ? STEPS[idx + 1] : null;

  return (
    <div className="guided">
      <aside className="g-rail">
        <div className="g-brand">
          <div className="mark" />
          <div>
            <div className="name">MERIDIAN</div>
            <div className="sub">A GUIDED TOUR</div>
          </div>
        </div>
        <nav>
          {STEPS.map((s, i) => (
            <button key={s.id} className={active === s.id ? "active" : ""} onClick={() => setActive(s.id)}>
              <span className="num">{s.num}</span>
              <span className="label">{s.label}</span>
              {idx > i && <span className="done">✓</span>}
            </button>
          ))}
        </nav>
        <div className="g-rail-foot">
          <Link href="/" className="link">→ open full UI</Link>
        </div>
      </aside>

      <main className="g-main">
        <header className="g-top">
          <div className="eyebrow">
            {step.num} · {step.eyebrow}
          </div>
          <div className="g-pager">
            {prev ? (
              <button onClick={() => setActive(prev.id)}>← Previous</button>
            ) : (
              <span className="disabled">← Previous</span>
            )}
            <span className="count">
              {idx + 1} / {STEPS.length}
            </span>
            {next ? (
              <button onClick={() => setActive(next.id)}>Next →</button>
            ) : (
              <span className="disabled">Next →</span>
            )}
          </div>
        </header>

        <section className="g-content">
          <h1 className="g-headline">{step.label}.</h1>
          <Slide />
        </section>

        <footer className="g-foot">
          <span>Hover any underlined term for a plain-English explanation.</span>
          <Link href="/" className="link">Operator view →</Link>
        </footer>
      </main>
    </div>
  );
}
