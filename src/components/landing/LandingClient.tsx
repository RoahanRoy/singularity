"use client";

import { useState } from "react";
import Link from "next/link";
import { useTheme } from "@/lib/meridian/theme";
import { PIPE, roleLabel } from "@/lib/meridian/pipeline";
import { SiteFooter, SiteNav } from "@/components/site/Site";
import { DemoFrame, type DemoScreen } from "@/components/desk-demo/Demo";

// [screen, tab, kicker, heading, body]. Each chapter describes the screen the
// frame beside it shows, and only what that screen does.
const CHAPTERS: [DemoScreen, string, string, string, string][] = [
  [
    "today",
    "Today",
    "01 · Monitor",
    "Start with what needs you.",
    "While you're away the agents read the filings and the news. When you look, you get a short list of proposals, each with its plan: the size, the route, and the risk and compliance checks it passed. Nothing trades until you approve it.",
  ],
  [
    "research",
    "Research",
    "02 · Decide",
    "Read the case before the trade.",
    "Agents parse each filing and earnings call, a sector analyst drafts the memo with a conviction score, and a red-team critic passes, revises or rejects it. The quant desk measures every name alongside.",
  ],
  [
    "risk",
    "Risk",
    "03 · Check",
    "Know where the risk sits before you act.",
    "VaR, expected shortfall and tracking error against the S&P 500, broken down by name, replayed through past selloffs, and measured against how long each position would take to exit.",
  ],
  [
    "agents",
    "Agents",
    "04 · Operate",
    "See every step. Stop any loop.",
    "See what each cluster is doing right now, read every step in the activity trace, and start or stop each desk loop. Every model call is metered against the day's allowance.",
  ],
];

const CONTROLS: [string, string][] = [
  ["Every trade waits for you", "Agents stage buys; none executes until you approve it. An approval can be undone until it fills."],
  ["A plan before every action", "Each proposal shows its size, route, arrival price and the risk and compliance results before you decide."],
  ["One risk budget", "You set a tracking error target against the S&P 500. Single-name limits and halt rules follow from it, and a trade that would break them is blocked."],
  ["Spend is metered", "Every model call writes to a ledger. A budget controller slows or stops the loops as usage nears the daily allowance."],
  ["Stop at any level", "Pause all agents from Today, or start and stop each desk loop from the Console."],
  ["An audit log", "Every approval, fill and guardrail check is logged with who or what made it."],
];

export default function LandingClient() {
  const [theme, toggleTheme] = useTheme("light", true);
  const [chap, setChap] = useState(0);
  const [screen, , kicker, heading, body] = CHAPTERS[chap];
  const stages = PIPE.map((p) => p[1]);

  return (
    <div className="mx s-page" data-theme={theme}>
      <SiteNav
        theme={theme}
        toggle={toggleTheme}
        middle={
          <nav className="s-navlinks" aria-label="Site">
            <Link href="/how-it-works">How it works</Link>
            <Link href="/guided">Guided tour</Link>
          </nav>
        }
        end={
          <>
            <Link href="/sign-in" className="s-hide-sm" style={{ fontSize: 14, color: "var(--ink)" }}>
              Sign in
            </Link>
            <Link href="/desk" className="s-cta sm">
              Open the desk
            </Link>
          </>
        }
      />

      <header className="s-wrap s-hero">
        <h1 className="s-display">A hedge fund run by agents. Supervised by you.</h1>
        <div style={{ display: "flex", flexDirection: "column", gap: 24, paddingBottom: 8 }}>
          <p>Meridian reads every filing, drafts the thesis, sizes the trade and checks the risk. You approve every trade.</p>
          <div className="s-ctas" style={{ gap: 16, alignItems: "center" }}>
            <Link href="/desk" className="s-cta">
              Open the desk
            </Link>
            <Link href="/guided">Take the guided tour →</Link>
          </div>
        </div>
      </header>

      <section className="s-wrap" aria-label="Desk preview">
        <div className="s-tabs" role="tablist" aria-label="Preview screen">
          {CHAPTERS.map(([id, label], k) => (
            <button key={id} role="tab" aria-selected={k === chap} onClick={() => setChap(k)}>
              {label}
            </button>
          ))}
        </div>
        <div className="s-chap" role="tabpanel">
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div className="s-eyebrow">{kicker}</div>
            <h2>{heading}</h2>
            <p className="s-body">{body}</p>
            <Link href="/desk" style={{ marginTop: 4, fontSize: 14 }}>
              Open this screen →
            </Link>
          </div>
          <DemoFrame theme={theme} screen={screen} key={screen} />
        </div>
        <p className="s-caption" style={{ fontSize: 12, textAlign: "right" }}>
          The desk&apos;s own screens, on sample data. Click around.
        </p>
      </section>

      <section className="s-wrap s-band s-split">
        <div>
          <div className="s-kicker">Oversight</div>
          <h2 className="s-h2" style={{ marginTop: 8 }}>
            The agents propose. Nothing moves without you.
          </h2>
        </div>
        <div className="s-controls">
          {CONTROLS.map(([k, v]) => (
            <div key={k}>
              <b>{k}</b>
              <span>{v}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="s-wrap s-band">
        <div className="s-split" style={{ alignItems: "end" }}>
          <div>
            <div className="s-kicker">Under the hood</div>
            <h2 className="s-h2" style={{ marginTop: 8 }}>
              Seventeen hand-offs between a filing and a fill.
            </h2>
          </div>
          <div>
            <p className="s-body" style={{ maxWidth: "56ch" }}>
              {stages.slice(0, -1).join(", ")} and {stages[stages.length - 1]}. Each stage does one job and can&apos;t do
              another&apos;s.
            </p>
            <Link href="/how-it-works" style={{ display: "inline-block", marginTop: 14 }}>
              See the full pipeline →
            </Link>
          </div>
        </div>
        <ol className="s-stages">
          {PIPE.map(([n, name, , role]) => (
            <li key={n}>
              <div className="n">{n}</div>
              <div className="name">{name}</div>
              <div className="k" style={{ color: role === "gate" ? "var(--warn)" : role === "decision" ? "var(--accent)" : undefined }}>
                {roleLabel(role).toLowerCase()}
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="s-wrap s-band">
        <div className="s-split s-cta-card">
          <h2 className="s-h2">Start a paper fund. Watch it work.</h2>
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            <p className="s-body">
              The desk trades a paper fund at live prices. Connect Interactive Brokers (US) or Horizon (India) to sync your real
              holdings read-only as an advisory book; nothing is sent to a broker.
            </p>
            <div className="s-ctas" style={{ gap: 16, alignItems: "center" }}>
              <Link href="/desk" className="s-cta">
                Open the desk
              </Link>
              <Link href="/guided">Take the guided tour →</Link>
            </div>
          </div>
        </div>
      </section>

      <SiteFooter
        links={[
          ["How it works", "/how-it-works"],
          ["Guided tour", "/guided"],
          ["Operator sign-in", "/sign-in"],
          ["hello@meridian.fund", "mailto:hello@meridian.fund"],
        ]}
      />
    </div>
  );
}
