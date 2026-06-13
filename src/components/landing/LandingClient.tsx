"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Lenis from "lenis";
import "./landing.css";

// WebGL is client-only — skip SSR so three/drei never touch the server.
const Scene = dynamic(() => import("./Scene"), {
  ssr: false,
  loading: () => null,
});

const NAV = ["Platform", "Research", "Approach", "Contact"];

// Scattered HUD "scan" markers over the centerpiece (decorative).
const HUD = [
  { x: "16%", y: "30%", l: "REF·014" },
  { x: "30%", y: "62%", l: "S·07" },
  { x: "52%", y: "22%", l: "x1.408" },
  { x: "63%", y: "48%", l: "351" },
  { x: "70%", y: "70%", l: "IST" },
  { x: "44%", y: "78%", l: "Δ·09" },
  { x: "24%", y: "46%", l: "" },
  { x: "58%", y: "64%", l: "" },
];

const STRATEGIES = [
  {
    n: "01",
    title: "Speed",
    body: "Signals priced and acted on in microseconds. Meridian closes the gap between a market event and a position before a human could read the headline.",
    icon: "Sub-ms execution",
  },
  {
    n: "02",
    title: "Research-based",
    body: "Every position is the output of an agent swarm reading filings, transcripts, and order flow — conviction built from primary sources, not sentiment.",
    icon: "Primary sources",
  },
  {
    n: "03",
    title: "Unbiased",
    body: "No desk politics, no anchoring, no ego. Capital is allocated by evidence and continuously re-weighted as the world changes.",
    icon: "Evidence-weighted",
  },
];

const STATS = [
  { v: "24/7", k: "Markets watched" },
  { v: "<8ms", k: "Decision latency" },
  { v: "1.4M", k: "Filings indexed" },
  { v: "120+", k: "Live agents" },
];

const CASES = [
  {
    tag: "US Equities",
    title: "The overnight desk",
    body: "Autonomous coverage of the US book through the IBKR gateway — researched, sized, and hedged while the team sleeps.",
  },
  {
    tag: "India Desk",
    title: "Pre-open conviction",
    body: "Kite-connected agents enrich every NSE name before the bell, surfacing the three trades that matter from a thousand that don't.",
  },
  {
    tag: "Macro",
    title: "Regime detection",
    body: "Continuous classification of the macro regime, re-weighting exposure the moment volatility, rates, or flow break trend.",
  },
  {
    tag: "Risk",
    title: "Always-on guardrails",
    body: "A supervising layer that can veto, trim, or unwind any agent in real time — autonomy with a hand on the kill switch.",
  },
];

const PILLARS = [
  { n: "A", h: "Research-based", p: "Decisions traced to primary evidence." },
  { n: "B", h: "Unbiased", p: "Allocation by data, never narrative." },
  { n: "C", h: "Global", p: "One brain across every time zone." },
  { n: "D", h: "Effortless", p: "Connect capital, the rest runs itself." },
];

const STEPS = [
  {
    n: "01",
    h: "Kick-off call",
    p: "We map your mandate, risk limits, and the markets you want covered.",
  },
  {
    n: "02",
    h: "Connect capital",
    p: "Securely link your IBKR and Kite accounts. Meridian reads the live book in minutes.",
  },
  {
    n: "03",
    h: "Deploy the swarm",
    p: "Research, portfolio, and execution agents come online under a human supervisor.",
  },
  {
    n: "04",
    h: "Launch & compound",
    p: "The system trades, learns, and reports — you watch the equity curve, not the screens.",
  },
];

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
      { threshold: 0.18, rootMargin: "0px 0px -8% 0px" }
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);
}

function useLenis() {
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const lenis = new Lenis({
      duration: 1.15,
      easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
      smoothWheel: true,
    });
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

export default function LandingClient() {
  const [stuck, setStuck] = useState(false);
  const heroRef = useRef<HTMLElement>(null);

  useLenis();
  useScrollReveal();

  useEffect(() => {
    const onScroll = () => setStuck(window.scrollY > 40);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const year = new Date().getFullYear();

  return (
    <div className="lp">
      <div className="lp-grain" aria-hidden />

      {/* nav */}
      <nav className={`lp-nav${stuck ? " is-stuck" : ""}`}>
        <a className="lp-brand" href="#top">
          <span className="lp-mark" aria-hidden />
          Meridian
        </a>
        <div className="lp-navlinks">
          {NAV.map((l) => (
            <a key={l} href={`#${l.toLowerCase()}`}>
              {l}
            </a>
          ))}
        </div>
        <a className="lp-btn" href="/desk">
          <span className="dot" aria-hidden />
          Talk to the operators
        </a>
      </nav>

      <main className="lp-main" id="top">
        {/* hero */}
        <header className="lp-hero" ref={heroRef}>
          {/* WebGL centerpiece — scoped to the hero so it scrolls away */}
          <div className="lp-hero-canvas" aria-hidden>
            <Scene />
            <div className="lp-hud">
              {HUD.map((h, i) => (
                <span
                  key={i}
                  className={`lp-hud-mark${h.l ? "" : " is-bare"}`}
                  style={{ left: h.x, top: h.y }}
                >
                  {h.l && <i>{h.l}</i>}
                </span>
              ))}
            </div>
          </div>

          <div className="lp-hero-inner lp-wrap">
            <span className="lp-eyebrow" data-reveal>
              Meridian · Autonomous Capital Intelligence
            </span>
            <h1 data-reveal data-reveal-delay="1">
              Autonomous
              <br />
              capital, <em>intelligently</em>
              <br />
              deployed.
            </h1>
            <p className="lp-hero-sub" data-reveal data-reveal-delay="2">
              An AI-native hedge fund operating system. A swarm of agents
              researches, allocates, and executes across global markets —
              supervised by a small team of humans.
            </p>
            <div className="lp-hero-cta" data-reveal data-reveal-delay="3">
              <a className="lp-btn lp-btn--solid" href="/desk">
                <span className="dot" aria-hidden />
                Get started
              </a>
              <a className="lp-btn" href="#approach">
                Learn more
              </a>
            </div>
          </div>

          <div className="lp-hero-foot lp-wrap">
            <div className="lp-scroll-hint">
              <span className="bar" aria-hidden />
              Scroll to explore
            </div>
            <div className="lp-hero-meta">
              <div>
                <b>US</b> · IBKR gateway
              </div>
              <div>
                <b>IN</b> · NSE / Kite
              </div>
              <div>
                Est. <b>{year}</b>
              </div>
            </div>
          </div>
        </header>

        {/* statement */}
        <section className="lp-section lp-section--plain">
          <div className="lp-wrap">
            <p className="lp-statement" data-reveal>
              Markets move in microseconds.{" "}
              <span className="muted">Most desks move in meetings.</span>{" "}
              Meridian moves <em>at the speed of evidence.</em>
            </p>
          </div>
        </section>

        {/* trusted-by marquee */}
        <div className="lp-marquee" aria-hidden>
          <div className="lp-marquee-track">
            {[...Array(2)].map((_, dup) => (
              <div className="lp-marquee-item" key={dup}>
                {[
                  "Interactive Brokers",
                  "Zerodha Kite",
                  "NSE",
                  "NASDAQ",
                  "Upstash Vector",
                  "Appwrite",
                  "Anthropic",
                  "EDGAR",
                ].map((b) => (
                  <span key={b}>{b}</span>
                ))}
              </div>
            ))}
          </div>
        </div>

        {/* strategies */}
        <section className="lp-section" id="approach">
          <div className="lp-wrap">
            <div className="lp-section-head">
              <h2 className="lp-section-title" data-reveal>
                An approach built on <em>three</em> strategies
              </h2>
              <span className="lp-index" data-reveal>
                [ 01 — Approach ]
              </span>
            </div>
            <div className="lp-grid-3">
              {STRATEGIES.map((s, i) => (
                <article className="lp-cell" key={s.title} data-reveal data-reveal-delay={i}>
                  <span className="lp-cell-num">{s.n}</span>
                  <h3>{s.title}</h3>
                  <p>{s.body}</p>
                  <span className="lp-cell-icon">
                    <span className="lp-mark" style={{ width: 12, height: 12 }} aria-hidden />
                    {s.icon}
                  </span>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* stats */}
        <section className="lp-section lp-section--plain">
          <div className="lp-wrap">
            <div className="lp-stats">
              {STATS.map((s, i) => (
                <div className="lp-stat" key={s.k} data-reveal data-reveal-delay={i}>
                  <div className="v">
                    <em>{s.v}</em>
                  </div>
                  <div className="k">{s.k}</div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* case studies */}
        <section className="lp-section" id="platform">
          <div className="lp-wrap">
            <div className="lp-section-head">
              <h2 className="lp-section-title" data-reveal>
                Where ambition meets <em>velocity</em>
              </h2>
              <span className="lp-index" data-reveal>
                [ 02 — Case studies ]
              </span>
            </div>
            <div className="lp-cases">
              {CASES.map((c, i) => (
                <article className="lp-case" key={c.title} data-reveal data-reveal-delay={i % 2}>
                  <div className="lp-case-top">
                    <span className="lp-case-tag">{c.tag}</span>
                    <span className="lp-index">0{i + 1}</span>
                  </div>
                  <div>
                    <h3>{c.title}</h3>
                    <p>{c.body}</p>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* pillars */}
        <section className="lp-section lp-section--plain" id="research">
          <div className="lp-wrap">
            <div className="lp-section-head">
              <h2 className="lp-section-title" data-reveal>
                Four constants behind every <em>trade</em>
              </h2>
              <span className="lp-index" data-reveal>
                [ 03 — Principles ]
              </span>
            </div>
            <div className="lp-pillars">
              {PILLARS.map((p, i) => (
                <div className="lp-pillar" key={p.h} data-reveal data-reveal-delay={i % 3}>
                  <span className="n">{p.n}</span>
                  <h4>{p.h}</h4>
                  <p>{p.p}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* how it works */}
        <section className="lp-section">
          <div className="lp-wrap">
            <div className="lp-section-head">
              <h2 className="lp-section-title" data-reveal>
                From mandate to <em>autopilot</em>
              </h2>
              <span className="lp-index" data-reveal>
                [ 04 — How it works ]
              </span>
            </div>
            <div className="lp-steps">
              {STEPS.map((s) => (
                <div className="lp-step" key={s.n} data-reveal>
                  <span className="lp-step-num">/ {s.n}</span>
                  <div className="lp-step-body">
                    <h4>{s.h}</h4>
                    <p>{s.p}</p>
                  </div>
                  <span className="lp-step-arrow" aria-hidden>
                    →
                  </span>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* final CTA */}
        <section className="lp-cta" id="contact">
          <div className="lp-wrap">
            <span className="lp-eyebrow" data-reveal>
              Ready when you are
            </span>
            <h2 data-reveal data-reveal-delay="1">
              Ready to <em>automate</em> everything?
            </h2>
            <div className="lp-hero-cta" style={{ justifyContent: "center" }} data-reveal data-reveal-delay="2">
              <a className="lp-btn lp-btn--solid" href="/desk">
                <span className="dot" aria-hidden />
                Enter the desk
              </a>
              <a className="lp-btn" href="#top">
                Back to top
              </a>
            </div>
          </div>
        </section>

        {/* footer */}
        <footer className="lp-footer">
          <div className="lp-wrap">
            <div className="lp-footer-top">
              <div className="lp-footer-brand">
                Meridian<em>.</em>
              </div>
              <div className="lp-footer-cols">
                <div className="lp-fcol">
                  <h5>Navigate</h5>
                  <a href="#approach">Approach</a>
                  <a href="#platform">Platform</a>
                  <a href="#research">Research</a>
                  <a href="#contact">Contact</a>
                </div>
                <div className="lp-fcol">
                  <h5>Desks</h5>
                  <a href="#platform">US · IBKR</a>
                  <a href="#platform">India · Kite</a>
                  <a href="#platform">Macro</a>
                  <a href="#platform">Risk</a>
                </div>
                <div className="lp-fcol">
                  <h5>Social</h5>
                  <a href="#">X / Twitter</a>
                  <a href="#">LinkedIn</a>
                  <a href="#">GitHub</a>
                  <a href="mailto:hello@meridian.fund">Email</a>
                </div>
              </div>
            </div>
            <div className="lp-footer-bottom">
              <span>© {year} Meridian Capital Intelligence</span>
              <span>Built with three.js · React Three Fiber</span>
            </div>
          </div>
        </footer>
      </main>
    </div>
  );
}
