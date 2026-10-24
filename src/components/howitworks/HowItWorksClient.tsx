"use client";

import { ReactNode, useEffect, useState } from "react";
import Link from "next/link";
import { useTheme } from "@/lib/meridian/theme";
import { QUANT_AGENTS, STAGES } from "@/lib/quant/roster";
import { PIPE, ROLES, ROLE_DOT, TIERS, roleLabel, type Role } from "@/lib/meridian/pipeline";
import { SiteFooter, SiteNav } from "@/components/site/Site";

/* ----------------------------------------------------------------
   Content model — every row here maps to something that actually
   runs in scripts/agents/. Keep it truthful: if the code changes,
   change this page. The pipeline itself lives in lib/meridian/pipeline.
   ---------------------------------------------------------------- */

const CHAPTERS: [string, string][] = [
  ["website", "The website"],
  ["pipeline", "The pipeline"],
  ["agents", "The agents"],
  ["loops", "The loops"],
  ["operator", "Runbook"],
];

// The desk's seven sections and the collections each one reads.
const SCREENS: [string, string, string, string][] = [
  ["Monitor", "Today", "What needs you: trades waiting for approval with their thesis, size and the checks they cleared, what the agents did since you last looked, and the guardrails in force.", "trades · agent_events · audit_log"],
  ["Monitor", "Book", "The fund against its mandate: NAV, holdings, cash and the risk budget, plus your advisory account's holdings, synced read-only from the broker.", "positions · fund_snapshots · fund_mandate"],
  ["Monitor", "Risk", "The latest risk report: VaR, expected shortfall and tracking error, where the risk sits by name, stress replays and liquidity in days of volume.", "risk_reports"],
  ["Decide", "Research", `The filing inbox and the memo each filing produced, plus the quant desk on one name: a card per agent (${QUANT_AGENTS.length} in all) and the ensemble's verdict.`, "filings · memos · quant_reports"],
  ["Operate", "Agents", "Clusters and their live activity, the fleet by status, model routing, venues from recent orders, and today's model spend.", "clusters · agents · agent_events · budget_ledger"],
  ["Operate", "Console", "Talk to the system through the Operator responder, start and stop the desk loops, and check book posture and today's spend.", "operator_messages · agent_status · budget_ledger"],
  ["Record", "Audit log", "Every approval, fill and guardrail check. An approval can be undone until it executes.", "audit_log"],
];

const RULES: [string, ReactNode][] = [
  ["Trust tiers", "Untrusted filing text never reaches an agent with tools. Reader, summariser and indexer are split, so a prompt injection can at worst produce JSON that fails validation."],
  ["Human-in-the-loop", <>A trade auto-executes only if the critic and the investment committee pass it, conviction × score ≥ 0.25, and <code>MERIDIAN_AUTO_APPROVE=1</code> is set for the session. Otherwise it waits for you.</>],
  ["One job per agent", "Analysts don't size. PMs don't execute. Risk doesn't re-size. Compliance doesn't approve sizing. Each prompt lives in its own file."],
  ["Bounded revision", "A critic “revise” triggers exactly one re-run. If it still doesn't clear, it goes to an operator. Bounded retries beat endless negotiation."],
  ["Budget kill switch", "Before every cycle, the budget controller checks 24h token use. Over the cap, it throttles or stops the loop."],
];

// name, npm script, cadence, what, why, when
const LOOPS: [string, string, string, string, string, string][] = [
  ["Tech Loop", "agents:tech", "~60s / cycle", "The US desk orchestrator. Refreshes IBKR holdings, picks one ticker round-robin and runs the full chain, writing every step so screens update live.", "It's the engine. Agents, Research and Book are all its output.", "Start from the Console or npm. A stop finishes the current cycle, then exits cleanly."],
  ["India Loop", "agents:india", "~60s / cycle", "The same chain for the NSE book. Refreshes the book from Horizon (at most every 15 min); the parser reasons from knowledge instead of EDGAR.", "India filings aren't on EDGAR, so the desk needs its own roster and universe.", "Runs independently of the US desk."],
  ["Console Responder", "agents:responder", "polls 3s", "Replies to any operator message without a follow-up, grounded in a fresh snapshot of memos, positions, news and governance.", "It's the voice you actually talk to in the Console.", "Starts with the server. Only answers messages newer than its boot time."],
  ["News Ingestor", "agents:news", "~30 min", "Fetches Google News RSS per ticker for both books and indexes it, deduped by URL. No API key, no LLM.", "A free, live headline feed for the responder and desks.", "Runs continuously, or once with MERIDIAN_NEWS_ONCE=1."],
  ["Held-Book Ingest", "agents:ingest", "~30 min", "Tops up filings for every held ticker — EDGAR for US, NSE announcements for India. Pure HTTP, no LLM.", "Keeps Research stocked with what's actually on the book.", "Runs in the background; failures skip the ticker rather than write junk."],
  ["Remote Dispatcher", "agents:dispatch", "polls 2s", "Bridges a hosted Console to agents on your machine: drains commands, manages child processes and reports status back.", "A serverless UI can't spawn long-lived processes.", "Only needed when the UI is hosted remotely."],
];

const RUNBOOK: [string, string][] = [
  ["Sign in as an operator", "Access is an email allowlist. Anyone outside it is signed straight back out. The guided tour stays open to everyone."],
  ["Connect the US book (IBKR)", "Run IBKR's Client Portal Gateway locally, log in, then connect it under Sources in Book. No password is stored — only the account id."],
  ["Connect the India book (Horizon)", "Point Meridian at Horizon with HORIZON_URL and HORIZON_EXPORT_TOKEN, then sync from Book. Horizon keeps the broker logins; Meridian never sees them."],
  ["Start the loops", "Start, stop or restart desks from the Console. The responder is already running."],
  ["Choose the autonomy level", "By default every trade waits for your approval. Turn on auto-approve for a session and only high-conviction, critic-passed trades fire."],
  ["Supervise, don't micromanage", "Watch spend and governance. Talk to the system. Veto, trim or unwind through the risk layer."],
];

const SECTORS = ["Tech", "Healthcare", "Energy", "Financials", "Consumer", "Industrials"];

function Head({ n, title }: { n: number; title: string }) {
  return (
    <>
      <div className="s-eyebrow" style={{ fontSize: 13 }}>
        {String(n).padStart(2, "0")} · {CHAPTERS[n - 1][1] === "Runbook" ? "Operator runbook" : CHAPTERS[n - 1][1]}
      </div>
      <h2 className="s-h2" style={{ marginTop: 6 }}>
        {title}
      </h2>
    </>
  );
}

export default function HowItWorksClient() {
  const [theme, toggleTheme] = useTheme("light", true);
  const [role, setRole] = useState<Role | "all">("all");
  const [active, setActive] = useState(0);

  useEffect(() => {
    const onScroll = () => {
      let a = 0;
      CHAPTERS.forEach(([id], i) => {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top < 160) a = i;
      });
      setActive(a);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const go = (id: string) => {
    const el = document.getElementById(id);
    if (!el) return;
    const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 100, behavior: smooth ? "smooth" : "auto" });
  };

  return (
    <div className="mx s-page" data-theme={theme} style={{ fontSize: 15, lineHeight: 1.55 }}>
      <SiteNav
        theme={theme}
        toggle={toggleTheme}
        middle={<span className="s-crumb" style={{ marginLeft: 8 }}>How it works</span>}
        end={
          <Link href="/desk" className="s-cta sm">
            Enter the desk
          </Link>
        }
      />

      <div className="s-wrap s-doc">
        <aside className="s-toc">
          <nav aria-label="Chapters">
            {CHAPTERS.map(([id, label], i) => (
              <button key={id} onClick={() => go(id)} aria-current={i === active ? "true" : undefined}>
                <span>{String(i + 1).padStart(2, "0")}</span>
                {label}
              </button>
            ))}
          </nav>
        </aside>

        <main className="s-doc-main">
          <Link href="/" style={{ fontSize: 13 }}>
            ← Home
          </Link>
          <h1 className="s-display" style={{ marginTop: 20, fontSize: "clamp(44px,6.4vw,80px)" }}>
            Every agent, every loop, and who does what.
          </h1>
          <p className="s-body" style={{ marginTop: 24, fontSize: "clamp(17px,1.6vw,19px)", maxWidth: "60ch" }}>
            Specialised agents read filings, build conviction, size and risk-check trades, then report. A small team of humans supervises, with a hand on the kill switch. This is the honest map of what runs, why, and when.
          </p>

          <section id="website" className="s-sec">
            <Head n={1} title="Two doors into one brain." />
            <p className="s-body">
              The <Link href="/desk">desk</Link> is the operator cockpit: seven sections behind a sign-in, grouped by what you&apos;re doing: monitor, decide, operate, record. The <Link href="/guided">guided tour</Link> explains the same system one idea at a time, with a plain-English glossary on every term, on sample data.
            </p>
            <p className="s-body">
              There&apos;s no separate backend. Auth, storage, realtime and the spend ledger all live in Appwrite. Agents run as workers next to the app and write every decision back to a collection a screen is already watching. Change the data and the screen moves.
            </p>
            <div className="s-rows">
              {SCREENS.map(([group, name, what, data]) => (
                <div key={name} className="s-row screen">
                  <div>
                    <span className="m-meta">{group}</span>
                    <div className="k">{name}</div>
                  </div>
                  <div className="v">{what}</div>
                  <div className="d">{data}</div>
                </div>
              ))}
            </div>
          </section>

          <section id="pipeline" className="s-sec">
            <Head n={2} title="One ticker, seventeen hand-offs." />
            <p className="s-body">
              Each cycle takes one name down a bounded chain. Research first, then a decision, then a wall of gates, then execution and accounting. No stage can do another&apos;s job, and nothing reaches the broker unless every gate clears.
            </p>
            <div className="s-pills" role="group" aria-label="Filter stages by role" style={{ margin: "28px 0 8px" }}>
              {(["all", ...ROLES] as const).map((r) => (
                <button key={r} className="s-pill" aria-pressed={role === r} onClick={() => setRole(r)}>
                  <span className="s-dot" style={{ background: r === "all" ? "var(--ink-3)" : ROLE_DOT[r] }} />
                  {r === "all" ? "All stages" : roleLabel(r)}
                </button>
              ))}
            </div>
            {PIPE.filter((p) => role === "all" || p[3] === role).map(([n, name, tier, r, what]) => (
              <div key={n} className="s-stage">
                <span className="n">{n}</span>
                <div style={{ minWidth: 0 }}>
                  <div className="h">
                    <b>{name}</b>
                    <span>
                      <span className="s-dot" style={{ background: ROLE_DOT[r] }} />
                      {roleLabel(r)}
                    </span>
                    <i>{tier}</i>
                  </div>
                  <p>{what}</p>
                </div>
              </div>
            ))}
          </section>

          <section id="agents" className="s-sec">
            <Head n={3} title="The right model for each job." />
            <p className="s-body">
              Every agent declares a default model in its prompt file, overridable per agent or globally with an env var. Cheap models run the mechanical gates; the expensive ones run research and the investment decision. Deterministic code does the sizing and the risk maths.
            </p>
            <div className="s-tiers">
              {TIERS.map(([t, note]) => (
                <div key={t}>
                  <div className="m-mono" style={{ fontSize: 13 }}>
                    {t}
                  </div>
                  <div className="m-serif m-num" style={{ fontSize: 34, lineHeight: 1.1 }}>
                    {PIPE.filter((p) => p[2] === t).length} <span className="m-meta" style={{ fontFamily: "var(--m-sans)", fontSize: 13 }}>stages</span>
                  </div>
                  <div className="m-sub" style={{ marginTop: 4, textWrap: "pretty" }}>
                    {note}
                  </div>
                </div>
              ))}
            </div>

            <h3>Six sector desks, one router</h3>
            <p>The single Sector Analyst stage is really six opus-tier specialists. Each ticker is routed to the right one by sector.</p>
            <div className="s-pills" style={{ marginTop: 12 }}>
              {SECTORS.map((s) => (
                <span key={s} className="s-pill">
                  {s}
                </span>
              ))}
            </div>

            <h3>The quant desk: {QUANT_AGENTS.length} agents, one method each</h3>
            <p>
              Short-term prices are close to random, so no single model gets a vote on its own. Each agent runs one method and reports a score with its evidence. Most are plain code; the ones marked LLM read text, with no tools. An ensemble weights each score by how well that method held up out of sample.
            </p>
            <div style={{ marginTop: 12 }}>
              {STAGES.map((stage) => (
                <div key={stage} className="s-row kv">
                  <div className="k">{stage}</div>
                  <div className="s-pills">
                    {QUANT_AGENTS.filter((a) => a.stage === stage).map((a) => (
                      <span key={a.slug} className="s-pill" title={a.does} style={{ fontSize: 12, padding: "3px 10px" }}>
                        {a.name}
                        {a.kind === "llm" && <span className="m-tag accent">LLM</span>}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            <h3>The rules every agent runs under</h3>
            <p>Five constraints, enforced in code, not just in prompts.</p>
            <div style={{ marginTop: 12, borderTop: "1px solid var(--line)" }}>
              {RULES.map(([h, p]) => (
                <div key={h} className="s-row kv">
                  <div className="k">{h}</div>
                  <div className="v">{p}</div>
                </div>
              ))}
            </div>
          </section>

          <section id="loops" className="s-sec">
            <Head n={4} title="The loops that keep it alive." />
            <p className="s-body">
              The pipeline is one cycle. These workers fire it on repeat, keep data fresh, and connect a hosted UI to processes on your machine.
            </p>
            <div style={{ marginTop: 28 }}>
              {LOOPS.map(([name, cmd, cadence, what, why, when]) => (
                <details key={cmd} className="s-loop">
                  <summary>
                    <b>{name}</b>
                    <span className="m-meta">{cadence}</span>
                    <code>npm run {cmd}</code>
                  </summary>
                  <div className="body">
                    {[["What", what], ["Why", why], ["When", when]].map(([k, v]) => (
                      <Pair key={k} k={k} v={v} />
                    ))}
                  </div>
                </details>
              ))}
            </div>
            <p className="s-body" style={{ marginTop: 20, paddingTop: 16, borderTop: "1px solid var(--line)", fontSize: 14 }}>
              <b style={{ color: "var(--ink)" }}>Weekly India enrichment</b> runs on a Vercel cron rather than a worker. It refreshes ~34 price histories for India-book betas, guarded by a <code>CRON_SECRET</code> bearer token.
            </p>
          </section>

          <section id="operator" className="s-sec">
            <Head n={5} title="What an operator actually does." />
            <p className="s-body">The system reads, reasons and stages. A human owns the capital, the connections and the kill switch.</p>
            <ol className="s-run">
              {RUNBOOK.map(([h, p], i) => (
                <li key={h}>
                  <span>{i + 1}</span>
                  <div>
                    <b>{h}</b>
                    <p>{p}</p>
                  </div>
                </li>
              ))}
            </ol>
          </section>

          <section className="s-endcard">
            <h2 className="s-h2" style={{ fontSize: "clamp(28px,3.4vw,40px)" }}>
              That&apos;s the whole machine. See it running.
            </h2>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "center", marginTop: 20 }}>
              <Link href="/desk" className="s-cta">
                Enter the desk
              </Link>
              <Link href="/guided">Take the guided tour →</Link>
            </div>
          </section>
        </main>
      </div>

      <SiteFooter links={[["Home", "/"], ["Guided tour", "/guided"], ["Desk", "/desk"]]} />
    </div>
  );
}

function Pair({ k, v }: { k: string; v: string }) {
  return (
    <>
      <span className="m-ink3">{k}</span>
      <span className="m-ink2" style={{ textWrap: "pretty" }}>
        {v}
      </span>
    </>
  );
}
