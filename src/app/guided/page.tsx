"use client";

import { ReactNode, createContext, useCallback, useContext, useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { lookup } from "@/lib/meridian/glossary";
import { useTheme } from "@/lib/meridian/theme";
import { SiteNav } from "@/components/site/Site";
import { DemoFrame, type DemoScreen } from "@/components/desk-demo/Demo";

type Tip = { key: string; x: number; y: number };
const TipCtx = createContext<(t: Tip | null) => void>(() => {});

/** A dotted glossary term. Hover, focus or tap shows its plain-English meaning. */
function T({ term, children }: { term?: string; children: ReactNode }) {
  const setTip = useContext(TipCtx);
  const key = (term ?? (typeof children === "string" ? children : "")).toLowerCase();
  const show = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const x = Math.max(12, Math.min(window.innerWidth - 312, r.left));
    const below = r.bottom + 180 < window.innerHeight;
    setTip({ key, x, y: below ? r.bottom + 8 : Math.max(12, r.top - 150) });
  };
  return (
    <button
      type="button"
      className="s-term"
      aria-describedby="s-tip"
      onMouseEnter={(e) => show(e.currentTarget)}
      onMouseLeave={() => setTip(null)}
      onFocus={(e) => show(e.currentTarget)}
      onBlur={() => setTip(null)}
      onClick={(e) => show(e.currentTarget)}
    >
      {children}
    </button>
  );
}

type Step = {
  id: string;
  label: string;
  kicker: string;
  screen: DemoScreen;
  caption: string;
  lede: ReactNode;
  /** [bold head or null, text] */
  bullets: [string | null, ReactNode][];
};

// Every claim here is something the desk does today; the frame under each step
// is the sample desk on the screen it describes.
const STEPS: Step[] = [
  {
    id: "agents",
    label: "The agents",
    kicker: "Agent intelligence",
    screen: "agents",
    caption: "The Agents screen: clusters, recent activity and the fleet.",
    lede: (
      <>
        A team of AI <T term="agent">agents</T> works the desk, each with one job. One parses filings, one reviews earnings
        calls, sector analysts write the case, and a <T>red team</T> critic attacks it before it reaches the PM.
      </>
    ),
    bullets: [
      [null, <>Agents sit in clusters: a desk per sector, Research, Quant Research, Risk, Execution and Governance.</>],
      [
        null,
        <>
          Work is event-driven. A new filing on a covered name goes first, then the best-ranked ideas from the sweep, then
          the rest of the coverage in turn.
        </>,
      ],
      [null, <>Every step an agent takes lands in the activity trace, including the trades risk blocked.</>],
    ],
  },
  {
    id: "research",
    label: "The research",
    kicker: "Autonomous analysis",
    screen: "research",
    caption: "Research: the inbox on the left, the memo on the right.",
    lede: (
      <>
        When a covered company files a <T term="10-k">10-K</T>, <T term="8-k">8-K</T> or 10-Q, or holds an{" "}
        <T>earnings call</T>, agents read it, summarise it and decide whether it changes the case.
      </>
    ),
    bullets: [
      [null, <>The Earnings Reviewer scores management&apos;s tone and counts deflected questions, against prior calls.</>],
      [
        null,
        <>
          The sector analyst writes a <T>memo</T> with a <T>conviction</T> score. The <T>red team</T> can pass it, send it
          back once for revision, or reject it.
        </>,
      ],
      [
        null,
        <>
          The quant desk measures each name on its own (screen, valuation, models, factors) and the critic checks the
          memo&apos;s figures against those numbers.
        </>,
      ],
    ],
  },
  {
    id: "book",
    label: "The book",
    kicker: "Capital allocation",
    screen: "book",
    caption: "Book: NAV over time, then holdings and their share of risk.",
    lede: (
      <>
        The fund is a <T>paper fund</T>: mandate cash plus what the agents bought, marked at live prices. You see its{" "}
        <T term="nav">NAV</T>, <T term="pnl">P&amp;L</T> and how much of the risk each holding carries.
      </>
    ),
    bullets: [
      [
        null,
        <>
          Return, <T>drawdown</T>, volatility and <T term="sharpe">Sharpe</T> are measured from the fund&apos;s own NAV
          history.
        </>,
      ],
      [
        null,
        <>
          Risk shows each name&apos;s share of risk and of <T>tracking error</T> against the S&amp;P 500, with{" "}
          <T term="var">VaR</T> and replays of past selloffs.
        </>,
      ],
      [
        null,
        <>
          An advisory book can sit alongside: your real holdings, synced read-only from IBKR or Horizon. The desk advises on
          it and never sends orders there.
        </>,
      ],
    ],
  },
  {
    id: "operator",
    label: "The operator",
    kicker: "Human + AI",
    screen: "today",
    caption: "Today: proposals waiting for you, each with its action plan.",
    lede: (
      <>
        You don&apos;t place trades. The PM stages each buy with a size, a route and the checks it passed, and nothing
        executes until you approve it.
      </>
    ),
    bullets: [
      [
        null,
        <>
          Each proposal opens to its plan: the order, its size as a share of NAV, the route (<T term="twap">TWAP</T> or{" "}
          <T term="vwap">VWAP</T>, and the venue) and the arrival price.
        </>,
      ],
      [
        null,
        <>
          A pre-trade risk gate blocks any trade that would push a name&apos;s <T>active risk</T> or the fund&apos;s{" "}
          <T>tracking error</T> past the <T>risk budget</T>. Blocks are logged.
        </>,
      ],
      [
        null,
        <>Ask the Console in plain language, like why a trade was blocked, and it answers from the live book.</>,
      ],
    ],
  },
  {
    id: "compute",
    label: "The compute",
    kicker: "Infrastructure",
    screen: "agents",
    caption: "Agents, with model spend today at the top.",
    lede: (
      <>
        Each agent runs on a Claude model sized to its job, and every call is metered. <T>Inference</T> spend shows on
        Today, Agents and the Console.
      </>
    ),
    bullets: [
      [
        null,
        <>
          Heavy reasoning (the analysts, the red team, the CIO) runs on Opus, reviews on Sonnet, and fast{" "}
          <T term="ingest">ingestion</T> and routing on Haiku.
        </>,
      ],
      [
        null,
        <>A Budget Controller reads the ledger every model call writes, and slows or stops the loops near the daily allowance.</>,
      ],
      [
        null,
        <>
          Orders fill on a paper broker, and transaction-cost analysis measures each fill&apos;s <T>slippage</T> against the
          price the PM sized at.
        </>,
      ],
    ],
  },
  {
    id: "start",
    label: "Build a fund",
    kicker: "Getting started",
    screen: "today",
    caption: "Where you'll start each day.",
    lede: (
      <>
        You bring a <T>mandate</T>; the agents bring the research and the paperwork. Here&apos;s the path from an empty book
        to a running fund.
      </>
    ),
    bullets: [
      [
        "Set your mandate.",
        <>
          {" "}
          Capital, the index to beat and a <T>tracking error</T> target. The risk limits follow from that one number.
        </>,
      ],
      ["Let the desk orient.", <> Agents pick up covered names and new filings, and draft memos as <T>conviction</T> builds.</>],
      ["Review the research.", <> Read each memo and what the <T>red team</T> said about it.</>],
      ["Approve each trade.", <> Every buy waits for you with its plan and risk checks. You can undo an approval until it fills.</>],
      ["Supervise.", <> Watch the risk budget, pause the agents from Today, and read every action in the audit log.</>],
    ],
  },
];
const STEP_KEY = "meridian-tour-step";

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

// The tour is public: it explains the system on sample data and reads nothing live.
export default function GuidedPage() {
  const router = useRouter();
  const [theme, toggleTheme] = useTheme("light", true);
  const i = useSyncExternalStore(subscribeStep, readStep, () => 0);
  const [tip, setTip] = useState<Tip | null>(null);

  const go = useCallback((k: number) => {
    if (k < 0 || k >= STEPS.length) return;
    writeStep(k);
    setTip(null);
    window.scrollTo(0, 0);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
      if (e.key === "ArrowRight") go(i + 1);
      if (e.key === "ArrowLeft") go(i - 1);
      if (e.key === "Escape") setTip(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, i]);

  const s = STEPS[i];
  const entry = tip ? lookup(tip.key) : undefined;
  const last = i === STEPS.length - 1;

  return (
    <TipCtx.Provider value={setTip}>
      <div className="mx s-page" data-theme={theme}>
        <SiteNav
          theme={theme}
          toggle={toggleTheme}
          middle={
            <span className="s-crumb">
              Guided tour · {i + 1} of {STEPS.length}
            </span>
          }
          end={
            <Link href="/desk" className="s-cta sm">
              Open the desk
            </Link>
          }
        >
          <div className="s-progress">
            <i style={{ width: `${((i + 1) / STEPS.length) * 100}%` }} />
          </div>
        </SiteNav>

        <div className="s-wrap s-tour">
          <nav className="s-rail" aria-label="Tour steps">
            <ol>
              {STEPS.map((st, k) => (
                <li key={st.id}>
                  <button onClick={() => go(k)} aria-current={k === i ? "step" : undefined} className={k < i ? "done" : undefined}>
                    <span className="n">{k < i ? "✓" : k + 1}</span>
                    {st.label}
                  </button>
                </li>
              ))}
            </ol>
          </nav>

          <main className="s-tour-main">
            <div key={s.id} style={{ maxWidth: 660, animation: "mer-rise .3s ease" }}>
              <div className="s-eyebrow" style={{ fontSize: 13 }}>
                {String(i + 1).padStart(2, "0")} · {s.kicker}
              </div>
              <h1 className="s-display" style={{ margin: "6px 0 0", fontSize: "clamp(40px,5.6vw,68px)" }}>
                {s.label}.
              </h1>
              <p style={{ margin: "20px 0 0", fontFamily: "var(--m-serif)", fontSize: "clamp(19px,1.9vw,22px)", lineHeight: 1.5, textWrap: "pretty" }}>
                {s.lede}
              </p>
              <ol className="s-bullets">
                {s.bullets.map(([head, body], k) => (
                  <li key={k}>
                    <span>{String(k + 1).padStart(2, "0")}</span>
                    <span>
                      {head && <b>{head}</b>}
                      {body}
                    </span>
                  </li>
                ))}
              </ol>
              {last && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "center", marginTop: 24 }}>
                  <Link href="/sign-in" className="s-cta">
                    Get started
                  </Link>
                  <Link href="/how-it-works">Read the technical map →</Link>
                </div>
              )}
            </div>

            <figure style={{ margin: 0 }}>
              <DemoFrame theme={theme} screen={s.screen} key={s.id} />
              <figcaption className="s-caption" style={{ marginTop: 10, fontSize: 12 }}>
                {s.caption} Live, on sample data.
              </figcaption>
            </figure>

            <div className="s-tour-foot">
              <button className="s-cta2" style={{ minHeight: 42, padding: "9px 14px", fontSize: 14 }} onClick={() => go(i - 1)} disabled={i === 0}>
                ← Back
              </button>
              <span>
                <span className="wide">Hover or tap any dotted term. ← → to move.</span>
                <span className="narrow">Tap any dotted term.</span>
              </span>
              <button
                className="s-cta"
                style={{ marginLeft: "auto", minHeight: 42, padding: "10px 16px", fontSize: 14 }}
                onClick={() => (last ? router.push("/sign-in") : go(i + 1))}
              >
                {last ? "Get started →" : `Next: ${STEPS[i + 1].label} →`}
              </button>
            </div>
          </main>
        </div>

        {tip && entry && (
          <div id="s-tip" role="tooltip" className="s-tip" style={{ left: tip.x, top: tip.y }}>
            <div style={{ fontWeight: 600 }}>{entry.title}</div>
            <div style={{ marginTop: 4, fontSize: 14, color: "var(--ink-2)", textWrap: "pretty" }}>{entry.body}</div>
          </div>
        )}
      </div>
    </TipCtx.Provider>
  );
}
