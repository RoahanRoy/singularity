"use client";

import { ReactNode, createContext, useCallback, useContext, useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { lookup } from "@/lib/meridian/glossary";
import { useTheme } from "@/lib/meridian/theme";
import { BrandMark } from "@/components/desk-demo/DeskDemo";

const STEPS: [string, string, string][] = [
  ["swarm", "The swarm", "Agent intelligence"],
  ["research", "The research", "Autonomous analysis"],
  ["portfolio", "The portfolio", "Capital allocation"],
  ["console", "The operator", "Human + AI"],
  ["compute", "The compute", "Infrastructure"],
  ["start", "Build a fund", "Getting started"],
];
const STEP_KEY = "meridian-tour-step";

type Tip = { key: string; x: number; y: number };
const TipCtx = createContext<(t: Tip | null) => void>(() => {});

/** A dotted glossary term. Hover, focus or tap shows its plain-English meaning. */
function T({ term, children }: { term?: string; children: ReactNode }) {
  const setTip = useContext(TipCtx);
  const key = (term ?? (typeof children === "string" ? children : "")).toLowerCase();
  const show = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const x = Math.max(12, Math.min(window.innerWidth - 312, r.left));
    const below = r.bottom + 200 < window.innerHeight;
    setTip({ key, x, y: below ? r.bottom + 10 : r.top - 150 });
  };
  return (
    <span
      data-term={key}
      tabIndex={0}
      onMouseEnter={(e) => show(e.currentTarget)}
      onMouseLeave={() => setTip(null)}
      onFocus={(e) => show(e.currentTarget)}
      onBlur={() => setTip(null)}
      onClick={(e) => show(e.currentTarget)}
      style={{ borderBottom: "1.5px dotted var(--ink-3)", cursor: "help" }}
    >
      {children}
    </span>
  );
}

const P = ({ children }: { children: ReactNode }) => (
  <p style={{ margin: "0 0 24px", color: "var(--ink)", textWrap: "pretty" }}>{children}</p>
);
const UL = ({ children }: { children: ReactNode }) => (
  <ul style={{ margin: 0, paddingLeft: "1.1em", display: "grid", gap: 12 }}>{children}</ul>
);
const B = ({ children }: { children: ReactNode }) => <b style={{ color: "var(--ink)" }}>{children}</b>;

const SLIDES: Record<string, ReactNode> = {
  swarm: (
    <>
      <P>
        Thousands of AI <T term="agent">agents</T> work in parallel — reading filings, parsing earnings, watching the news — grouped by what they specialise in. An <T>orchestrator</T> watches over them like air-traffic control.
      </P>
      <UL>
        <li>Each cluster is a team of specialists: <T>macro</T>, equities, <T>vol</T>, credit, <T>alt-data</T>.</li>
        <li>When agents agree on an idea, <T>conviction</T> rises and it&apos;s escalated to a human.</li>
        <li>Disagreement — <T>dissent</T> — is logged and shown to you, never hidden.</li>
      </UL>
    </>
  ),
  research: (
    <>
      <P>
        Whenever a company files a <T term="10-k">10-K</T>, <T term="8-k">8-K</T> or <T term="13f">13F</T>, or holds an <T>earnings call</T>, agents read it in seconds and look for what management isn&apos;t saying.
      </P>
      <UL>
        <li>Phrases are compared with historical baselines, so hedging language gets flagged.</li>
        <li>Tone is scored against prior calls. Deflections and softer guidance become numbers.</li>
        <li>Past a threshold, the system drafts a <T>thesis</T> with a suggested trade.</li>
      </UL>
    </>
  ),
  portfolio: (
    <>
      <P>
        Positions rebalance continuously. You see live <T term="nav">NAV</T>, <T term="pnl">P&amp;L</T>, <T term="factor exposure">factor exposures</T> and a tree of likely 24-hour outcomes.
      </P>
      <UL>
        <li><T term="sharpe">Sharpe</T> and <T term="sortino">Sortino</T> measure return per unit of risk. Higher is better.</li>
        <li><T term="var">VaR</T> caps losses on a normal bad day; <T>drawdown</T> tracks the worst run.</li>
        <li><T term="leverage">Leverage</T> is capped, and every <T>rebalance</T> passes a pre-trade risk check.</li>
      </UL>
    </>
  ),
  console: (
    <>
      <P>
        An operator doesn&apos;t click buttons all day. You state intent in plain language, and the agents do the work and bring back action cards for approval.
      </P>
      <UL>
        <li>&ldquo;Reduce China-linked semi exposure 15%, keep the idiosyncratic <T>alpha</T>.&rdquo;</li>
        <li>The system models execution paths, scores <T>slippage</T>, and asks for one tap to authorise.</li>
        <li>If two agents <T>dissent</T>, a human must review before anything fires.</li>
      </UL>
    </>
  ),
  compute: (
    <>
      <P>
        Underneath is a small data centre: thousands of GPUs running <T>inference</T> across specialist models, backed by a <T>vector store</T> of every filing.
      </P>
      <UL>
        <li>Work is routed by model: heavy reasoning to Opus, fast <T term="ingest">ingestion</T> to Haiku.</li>
        <li><T term="latency">Latency</T> from idea to executed order is milliseconds, not minutes.</li>
        <li>Connections to 13 execution <T term="venue">venues</T> are kept warm and monitored.</li>
      </UL>
    </>
  ),
  start: (
    <>
      <P>
        You bring the capital and a mandate. The swarm brings the research, execution and round-the-clock attention. Here&apos;s the path from an empty book to a live fund.
      </P>
      <ol style={{ margin: 0, paddingLeft: "1.2em", display: "grid", gap: 12 }}>
        <li><B>Set your mandate.</B> Strategy, universe and hard limits: max <T>leverage</T> and a daily <T term="var">VaR</T> cap.</li>
        <li><B>Let the swarm orient.</B> Specialist clusters pick up the mandate and surface ideas as <T>conviction</T> builds.</li>
        <li><B>Review the research.</B> Accept, reject or send back each auto-drafted <T>thesis</T>.</li>
        <li><B>Shape the portfolio.</B> Approved theses become positions. Tune <T term="sharpe">Sharpe</T> and <T>drawdown</T> targets.</li>
        <li><B>Authorise execution.</B> One tap per trade; any <T>dissent</T> forces a review.</li>
        <li><B>Supervise.</B> Track spend in Compute and set direction. The swarm runs the book.</li>
      </ol>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 32 }}>
        <Link href="/sign-in" style={{ background: "var(--btn)", color: "var(--btn-ink)", padding: "13px 24px", borderRadius: 980, fontSize: 17, fontWeight: 500, textDecoration: "none" }}>
          Get started
        </Link>
        <Link href="/how-it-works" style={{ fontSize: 17, padding: "13px 8px" }}>
          Read the technical map ›
        </Link>
      </div>
    </>
  ),
};

// The current step, persisted so a returning reader resumes where they left
// off. `memStep` keeps navigation working when storage is blocked.
const STEP_EVENT = "meridian-tour-step-change";
let memStep = 0;
function readStep(): number {
  try {
    const s = Number(window.localStorage.getItem(STEP_KEY));
    if (Number.isInteger(s) && s >= 0 && s < STEPS.length) return s;
  } catch {
    /* storage blocked */
  }
  return memStep;
}
function writeStep(k: number) {
  memStep = k;
  try {
    window.localStorage.setItem(STEP_KEY, String(k));
  } catch {
    /* storage blocked — memStep carries it */
  }
  window.dispatchEvent(new Event(STEP_EVENT));
}
function subscribeStep(cb: () => void) {
  window.addEventListener(STEP_EVENT, cb);
  return () => window.removeEventListener(STEP_EVENT, cb);
}

function useWide() {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia("(min-width: 860px)");
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    },
    () => window.matchMedia("(min-width: 860px)").matches,
    () => true,
  );
}

// The tour is public: it explains the system and reads no live data.
export default function GuidedPage() {
  const router = useRouter();
  const [theme, toggleTheme] = useTheme("light", true);
  const wide = useWide();
  const i = useSyncExternalStore(subscribeStep, readStep, () => 0);
  const [tip, setTip] = useState<Tip | null>(null);

  const go = useCallback((k: number) => {
    if (k < 0 || k >= STEPS.length) return;
    writeStep(k);
    setTip(null);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") go(i + 1);
      if (e.key === "ArrowLeft") go(i - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, i]);

  const entry = tip ? lookup(tip.key) : undefined;
  const last = i === STEPS.length - 1;

  return (
    <TipCtx.Provider value={setTip}>
      <div
        className="mx-page"
        data-theme={theme}
        style={{ minHeight: "100vh", background: "var(--bg)", color: "var(--ink)", fontFamily: "var(--f-text)", fontSize: 17, lineHeight: 1.47, letterSpacing: "-0.01em", display: "flex", flexDirection: "column" }}
      >
        <nav
          className="mx-glass"
          style={{ height: 52, flex: "none", display: "flex", alignItems: "center", gap: 16, padding: "0 20px", borderBottom: "1px solid var(--line)", background: "var(--glass)", backdropFilter: "saturate(180%) blur(20px)", WebkitBackdropFilter: "saturate(180%) blur(20px)", position: "sticky", top: 0, zIndex: 20 }}
        >
          <Link href="/" style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--ink)", fontWeight: 600, textDecoration: "none" }}>
            <BrandMark />
            Meridian
          </Link>
          <span style={{ fontSize: 13, color: "var(--ink-3)" }}>Guided tour</span>
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 13, color: "var(--ink-3)", fontVariantNumeric: "tabular-nums" }}>
              {i + 1} of {STEPS.length}
            </span>
            <button onClick={toggleTheme} aria-label="Toggle appearance" style={{ width: 32, height: 32, borderRadius: "50%", border: 0, background: "var(--fill)", color: "var(--ink)", cursor: "pointer", fontSize: 14 }}>
              {theme === "dark" ? "☀" : "☾"}
            </button>
            <Link href="/desk" style={{ fontSize: 13, fontWeight: 500, color: "var(--btn-ink)", background: "var(--btn)", padding: "7px 14px", borderRadius: 980, textDecoration: "none" }}>
              Open the desk
            </Link>
          </div>
        </nav>

        <div style={{ flex: 1, display: "flex", flexDirection: wide ? "row" : "column", gap: 24, maxWidth: 1180, width: "100%", margin: "0 auto", padding: "clamp(16px,3vw,32px) 20px" }}>
          <aside aria-label="Tour steps" style={{ flex: `0 0 ${wide ? "240px" : "auto"}`, display: "flex", flexDirection: wide ? "column" : "row", gap: 4, overflowX: "auto" }}>
            {STEPS.map(([id, label], k) => {
              const on = k === i;
              const done = k < i;
              return (
                <button
                  key={id}
                  onClick={() => go(k)}
                  aria-current={on ? "step" : undefined}
                  style={{ flex: "none", display: "flex", alignItems: "center", gap: 12, border: 0, textAlign: "left", borderRadius: 14, padding: "12px 14px", font: "inherit", cursor: "pointer", background: on ? "var(--surface)" : "transparent", color: "var(--ink)" }}
                >
                  <span
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: "50%",
                      flex: "none",
                      display: "grid",
                      placeItems: "center",
                      fontSize: 13,
                      fontWeight: 600,
                      background: on ? "var(--btn)" : done ? "color-mix(in oklch,var(--up) 18%,transparent)" : "var(--fill)",
                      color: on ? "var(--btn-ink)" : done ? "var(--up)" : "var(--ink-2)",
                    }}
                  >
                    {done ? "✓" : k + 1}
                  </span>
                  <span style={{ fontSize: 15, fontWeight: on ? 600 : 400, whiteSpace: "nowrap" }}>{label}</span>
                </button>
              );
            })}
          </aside>

          <main style={{ flex: 1, minWidth: 0, background: "var(--surface)", borderRadius: 28, padding: "clamp(28px,5vw,64px)", display: "flex", flexDirection: "column", boxShadow: "var(--shadow)" }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: "var(--accent-ink)" }}>
              {String(i + 1).padStart(2, "0")} · {STEPS[i][2]}
            </div>
            <h1 style={{ margin: "6px 0 24px", fontSize: "clamp(40px,6vw,72px)", lineHeight: 1.02, letterSpacing: "-0.045em", fontWeight: 700 }}>
              {STEPS[i][1]}.
            </h1>
            <div key={STEPS[i][0]} style={{ maxWidth: 760, fontSize: "clamp(19px,1.8vw,22px)", lineHeight: 1.5, color: "var(--ink-2)", animation: "mer-rise .3s ease" }}>
              {SLIDES[STEPS[i][0]]}
            </div>

            <div style={{ marginTop: "auto", paddingTop: 40, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
              <span style={{ fontSize: 13, color: "var(--ink-3)" }}>
                Hover or tap any dotted term for a plain-English explanation. Use ← → to navigate.
              </span>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => go(i - 1)} disabled={i === 0} style={{ border: 0, background: "var(--fill)", color: "var(--ink)", borderRadius: 980, padding: "10px 18px", font: "inherit", fontSize: 15, cursor: i > 0 ? "pointer" : "default", opacity: i > 0 ? 1 : 0.35 }}>
                  ‹ Back
                </button>
                <button
                  onClick={() => (last ? router.push("/sign-in") : go(i + 1))}
                  style={{ border: 0, background: "var(--btn)", color: "var(--btn-ink)", borderRadius: 980, padding: "10px 20px", font: "inherit", fontSize: 15, fontWeight: 500, cursor: "pointer" }}
                >
                  {last ? "Get started ›" : `Next: ${STEPS[i + 1][1]} ›`}
                </button>
              </div>
            </div>
          </main>
        </div>

        {tip && entry && (
          <div
            role="tooltip"
            style={{ position: "fixed", zIndex: 100, left: tip.x, top: tip.y, width: 300, maxWidth: "calc(100vw - 24px)", background: "var(--tip)", color: "var(--tip-ink)", borderRadius: 16, padding: "14px 16px", boxShadow: "0 12px 40px rgba(0,0,0,0.25)", pointerEvents: "none", animation: "mer-rise .15s ease" }}
          >
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>{entry.title}</div>
            <div style={{ fontSize: 14, lineHeight: 1.45, color: "var(--tip-2)" }}>{entry.body}</div>
          </div>
        )}
      </div>
    </TipCtx.Provider>
  );
}
