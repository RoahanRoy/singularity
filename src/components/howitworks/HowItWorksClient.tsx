"use client";

import { CSSProperties, ReactNode, useState } from "react";
import Link from "next/link";
import { useTheme } from "@/lib/meridian/theme";
import { BrandMark } from "@/components/desk-demo/DeskDemo";

/* ----------------------------------------------------------------
   Content model — every row here maps to something that actually
   runs in scripts/agents/. Keep it truthful: if the code changes,
   change this page.
   ---------------------------------------------------------------- */

const CHAPTERS: [string, string][] = [
  ["website", "The website"],
  ["pipeline", "The pipeline"],
  ["agents", "The agents"],
  ["loops", "The loops"],
  ["operator", "Runbook"],
];

// The five desk screens and the collections each one reads.
const SCREENS: [string, string, string, string][] = [
  ["01", "Swarm", "Air-traffic control for the agent fleet. Clusters, roster, and a live feed of everything they do.", "clusters · agents · agent_events"],
  ["02", "Research", "The ingest queue and the memos it produces, with the entity graph behind each one.", "filings · memos · entities"],
  ["03", "Portfolio", "The live book: NAV, exposures, P&L, stress scenarios and trades waiting on your vote.", "positions · fund_snapshots · trades"],
  ["04", "Console", "Talk to the system. A chat answered by the responder agent, plus governance and spend.", "operator_messages · budget_ledger"],
  ["05", "Compute", "GPU fabric, model routing per agent, running pipelines and the knowledge graph.", "compute_nodes · model_routes · pipelines"],
];

type Role = "research" | "decision" | "gate" | "execution" | "post";
type Tier = "opus" | "sonnet" | "haiku" | "code";

const ROLE_DOT: Record<Role, string> = {
  research: "var(--blue)",
  decision: "var(--accent)",
  gate: "var(--down)",
  execution: "var(--up)",
  post: "var(--ink-3)",
};
const TIER: Record<Tier, [string, string]> = {
  opus: ["color-mix(in oklch,var(--accent) 22%,transparent)", "var(--accent-ink)"],
  sonnet: ["color-mix(in oklch,var(--blue) 16%,transparent)", "var(--blue)"],
  haiku: ["color-mix(in oklch,var(--up) 16%,transparent)", "var(--up)"],
  code: ["var(--fill-2)", "var(--ink-2)"],
};

// The bounded decision chain, in execution order. Mirrors runCycle() in the
// desk loop. The tier is the prompt's default model.
const PIPE: [string, string, Tier, Role, string][] = [
  ["00", "Budget Controller", "haiku", "gate", "Runs before every cycle. Checks the 24h token ledger and returns allow, throttle or kill. Over budget, everything stops."],
  ["01", "Filing Parser", "haiku", "research", "US: an HTTP-only EDGAR reader pulls the latest 10-K/Q/8-K, then a tool-less summariser turns it into structured JSON. India: a company brief from knowledge."],
  ["02", "Earnings Reviewer", "sonnet", "research", "Reads the earnings-call transcript and scores tone and deflection. A supplemental signal — it doesn't write the thesis."],
  ["03", "Sector Analyst", "opus", "research", "One of six sector specialists drafts the memo: explicit catalyst, quantified risk, conviction score. No sizing."],
  ["04", "Quant Researcher", "opus", "research", "An independent, factor-based read on the same name: a composite score and the exposures behind it."],
  ["05", "Red-Team Critic", "opus", "gate", "Stress-tests the memo and returns a robustness score. A 'revise' triggers exactly one re-run, then it goes to review."],
  ["06", "Valuation Reviewer", "opus", "research", "A quick DCF and peer-multiple check on the implied entry, so nobody sizes into an obviously rich print."],
  ["07", "CIO / Committee", "opus", "gate", "Combines memo, critique, valuation and quant signal into one go / no-go. The PM must respect it."],
  ["08", "Portfolio Manager", "opus", "decision", "Sizes the position within NAV and per-name limits. It's a proposal — risk and compliance still gate it."],
  ["09", "Treasury", "sonnet", "decision", "Decides funding: cash vs margin, borrow for shorts, and the financing cost in basis points."],
  ["10", "Risk Officer", "haiku", "gate", "Estimates 1-day 95% VaR on the proposed position and approves only if it's inside policy."],
  ["11", "Risk Overlay", "code", "gate", "Deterministic book-level check: gross leverage, name count, position weight and VaR caps. Vetoes any breach."],
  ["12", "Compliance", "haiku", "gate", "Restricted list, position limits, wash sale, Reg SHO. It can block, but never approves sizing."],
  ["13", "Smart Router", "haiku", "execution", "Picks venue and algorithm (TWAP / VWAP / IS). No say over size — only how it reaches the market."],
  ["14", "Paper Broker", "code", "execution", "Simulated fills, no LLM. Writes the trade so the book and P&L move."],
  ["15", "TCA", "haiku", "post", "Post-trade cost analysis: slippage vs benchmark, fees and market impact."],
  ["16", "Attribution & Recon", "haiku", "post", "Reconciles intended vs executed and attributes expected return to its factor sources. Closes the loop."],
];

const TIERS: [Tier, string][] = [
  ["opus", "Most capable — the research and decision core."],
  ["sonnet", "Mid-tier — judgement without the full cost."],
  ["haiku", "Cheap and fast — gates and mechanical steps."],
  ["code", "Deterministic code, no LLM."],
];

const RULES: [string, ReactNode][] = [
  ["Trust tiers", "Untrusted filing text never reaches an agent with tools. Reader, summariser and indexer are split, so a prompt injection can at worst produce JSON that fails validation."],
  ["Human-in-the-loop", <>A trade auto-executes only if the critic passes, conviction × score ≥ 0.4, and <code>MERIDIAN_AUTO_APPROVE=1</code> is set for the session. Otherwise it waits for you.</>],
  ["One job per agent", "Analysts don't size. PMs don't execute. Risk doesn't re-size. Compliance doesn't approve sizing. Each prompt lives in its own file."],
  ["Bounded revision", "A critic “revise” triggers exactly one re-run. If it still doesn't clear, it goes to an operator. Bounded retries beat endless negotiation."],
  ["Budget kill switch", "Before every cycle, the budget controller checks 24h token use. Over the cap, it throttles or stops the loop."],
];

// name, npm script, cadence, what, why, when
const LOOPS: [string, string, string, string, string, string][] = [
  ["Tech Loop", "agents:tech", "~60s / cycle", "The US desk orchestrator. Refreshes IBKR holdings, picks one ticker round-robin and runs the full chain, writing every step so screens update live.", "It's the engine. Swarm, Research and Portfolio are all its output.", "Start from the Console or npm. A stop finishes the current cycle, then exits cleanly."],
  ["India Loop", "agents:india", "~60s / cycle", "The same chain for the NSE book. Refreshes Kite holdings each cycle; the parser reasons from knowledge instead of EDGAR.", "India filings aren't on EDGAR, so the desk needs its own roster and universe.", "Runs independently, usually after the morning Kite login."],
  ["Console Responder", "agents:responder", "polls 3s", "Replies to any operator message without a follow-up, grounded in a fresh snapshot of memos, positions, news and governance.", "It's the voice you actually talk to in the Console.", "Starts with the server. Only answers messages newer than its boot time."],
  ["News Ingestor", "agents:news", "~30 min", "Fetches Google News RSS per ticker for both books and indexes it, deduped by URL. No API key, no LLM.", "A free, live headline feed for the responder and desks.", "Runs continuously, or once with MERIDIAN_NEWS_ONCE=1."],
  ["Held-Book Ingest", "agents:ingest", "~30 min", "Tops up filings for every held ticker — EDGAR for US, NSE announcements for India. Pure HTTP, no LLM.", "Keeps Research stocked with what's actually on the book.", "Runs in the background; failures skip the ticker rather than write junk."],
  ["Remote Dispatcher", "agents:dispatch", "polls 2s", "Bridges a hosted Console to agents on your machine: drains commands, manages child processes and reports status back.", "A serverless UI can't spawn long-lived processes.", "Only needed when the UI is hosted remotely."],
];

const RUNBOOK: [string, string][] = [
  ["Sign in as an operator", "Access is an email allowlist. Anyone outside it is signed straight back out. The guided tour stays open to everyone."],
  ["Connect the US book (IBKR)", "Run IBKR's Client Portal Gateway locally, log in, then tap Connect in Portfolio. No password is stored — only the account id."],
  ["Connect the India book (Kite)", "Link each Zerodha account via Kite Connect. Tokens expire daily, so expect a quick login each trading morning."],
  ["Start the loops", "Start, stop or restart desks from the Console. The responder is already running."],
  ["Choose the autonomy level", "By default every trade waits for your approval. Turn on auto-approve for a session and only high-conviction, critic-passed trades fire."],
  ["Supervise, don't micromanage", "Watch spend and governance. Talk to the system. Veto, trim or unwind through the risk layer."],
];

const SECTORS = ["Tech", "Healthcare", "Energy", "Financials", "Consumer", "Industrials"];

const CARD: CSSProperties = { background: "var(--surface)", borderRadius: 22, padding: 26 };
const EYEBROW: CSSProperties = { fontSize: 17, fontWeight: 600, color: "var(--accent-ink)" };
const H2: CSSProperties = { fontSize: "clamp(32px,4.5vw,48px)", letterSpacing: "-0.04em", lineHeight: 1.08, fontWeight: 700 };
const LEDE: CSSProperties = { margin: "0 0 28px", color: "var(--ink-2)", fontSize: 19, maxWidth: 760, textWrap: "pretty" };
const SECTION: CSSProperties = { paddingTop: "clamp(56px,8vw,96px)", scrollMarginTop: 110 };
const GLASS: CSSProperties = {
  background: "var(--glass)",
  backdropFilter: "saturate(180%) blur(20px)",
  WebkitBackdropFilter: "saturate(180%) blur(20px)",
  borderBottom: "1px solid var(--line)",
};
const grid = (min: string, gap = 16): CSSProperties => ({
  display: "grid",
  gridTemplateColumns: `repeat(auto-fit,minmax(${min},1fr))`,
  gap,
});

export default function HowItWorksClient() {
  const [theme, toggleTheme] = useTheme("light", true);
  const [role, setRole] = useState<Role | "all">("all");

  const go = (id: string) => {
    const el = document.getElementById(id);
    if (!el) return;
    const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 110, behavior: smooth ? "smooth" : "auto" });
  };

  return (
    <div
      className="mx-page"
      data-theme={theme}
      style={{ minHeight: "100vh", background: "var(--bg)", color: "var(--ink)", fontFamily: "var(--f-text)", fontSize: 17, lineHeight: 1.47, letterSpacing: "-0.01em" }}
    >
      <nav className="mx-glass" style={{ ...GLASS, position: "sticky", top: 0, zIndex: 50, height: 52, display: "flex", alignItems: "center", gap: 20, padding: "0 max(20px,calc((100% - 1080px)/2))" }}>
        <Link href="/" style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--ink)", fontWeight: 600, textDecoration: "none" }}>
          <BrandMark />
          Meridian
        </Link>
        <span style={{ fontSize: 13, color: "var(--ink-3)" }}>How it works</span>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
          <button onClick={toggleTheme} aria-label="Toggle appearance" style={{ width: 32, height: 32, borderRadius: "50%", border: 0, background: "var(--fill)", color: "var(--ink)", cursor: "pointer", fontSize: 14 }}>
            {theme === "dark" ? "☀" : "☾"}
          </button>
          <Link href="/desk" style={{ fontSize: 13, fontWeight: 500, color: "var(--btn-ink)", background: "var(--btn)", padding: "7px 14px", borderRadius: 980, textDecoration: "none" }}>
            Enter the desk
          </Link>
        </div>
      </nav>

      <header style={{ maxWidth: 1080, margin: "0 auto", padding: "clamp(56px,8vw,104px) 20px 32px" }}>
        <Link href="/" style={{ fontSize: 15 }}>‹ Home</Link>
        <h1 style={{ margin: "18px 0 0", fontSize: "clamp(42px,7vw,80px)", lineHeight: 1.02, letterSpacing: "-0.045em", fontWeight: 700, maxWidth: 900, textWrap: "balance" }}>
          Every agent, every loop, and who does what.
        </h1>
        <p style={{ margin: "22px 0 0", fontSize: "clamp(19px,2vw,22px)", lineHeight: 1.4, color: "var(--ink-2)", maxWidth: 720, textWrap: "pretty" }}>
          Specialised agents read filings, build conviction, size and risk-check trades, then report. A small team of humans supervises, with a hand on the kill switch. This is the honest map of what runs, why, and when.
        </p>
      </header>

      <div className="mx-glass" style={{ ...GLASS, position: "sticky", top: 52, zIndex: 40 }}>
        <div style={{ maxWidth: 1080, margin: "0 auto", padding: "10px 20px", display: "flex", gap: 6, overflowX: "auto" }}>
          {CHAPTERS.map(([id, label], i) => (
            <button key={id} onClick={() => go(id)} style={{ flex: "none", border: 0, borderRadius: 980, padding: "7px 14px", font: "inherit", fontSize: 14, fontWeight: 500, cursor: "pointer", background: "var(--fill)", color: "var(--ink)" }}>
              {i + 1} · {label}
            </button>
          ))}
        </div>
      </div>

      <main style={{ maxWidth: 1080, margin: "0 auto", padding: "0 20px clamp(64px,8vw,120px)" }}>
        <section id="website" style={SECTION}>
          <div style={EYEBROW}>01 · The website</div>
          <h2 style={{ ...H2, margin: "6px 0 20px" }}>Two doors into one brain.</h2>
          <div style={{ ...grid("min(100%,320px)", 24), color: "var(--ink-2)", fontSize: 19, maxWidth: 960 }}>
            <p style={{ margin: 0, textWrap: "pretty" }}>
              The <b style={{ color: "var(--ink)" }}>desk</b> is the operator cockpit: five screens, behind a sign-in. The <b style={{ color: "var(--ink)" }}>guided tour</b> explains the same system one idea at a time, with a plain-English glossary on every term.
            </p>
            <p style={{ margin: 0, textWrap: "pretty" }}>
              There&apos;s no separate backend. Auth, storage, realtime and the spend ledger all live in Appwrite. Agents run as workers next to the app and write every decision back to a collection a screen is already watching. Change the data and the screen moves.
            </p>
          </div>
          <div style={{ ...grid("min(100%,300px)"), marginTop: 36 }}>
            {SCREENS.map(([n, h, p, src]) => (
              <article key={n} style={CARD}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ink-3)" }}>{n}</div>
                <h3 style={{ margin: "6px 0", fontSize: 21, letterSpacing: "-0.02em" }}>{h}</h3>
                <p style={{ margin: "0 0 14px", color: "var(--ink-2)", fontSize: 15 }}>{p}</p>
                <code>{src}</code>
              </article>
            ))}
          </div>
        </section>

        <section id="pipeline" style={SECTION}>
          <div style={EYEBROW}>02 · The pipeline</div>
          <h2 style={{ ...H2, margin: "6px 0 16px" }}>One ticker, sixteen hand-offs.</h2>
          <p style={LEDE}>
            Each cycle takes one name down a bounded chain. Research first, then a decision, then a wall of gates, then execution and accounting. No stage can do another&apos;s job, and nothing reaches the broker unless every gate clears.
          </p>
          <div role="group" aria-label="Filter stages by role" style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 20 }}>
            {(["all", "research", "decision", "gate", "execution", "post"] as const).map((r) => {
              const on = role === r;
              return (
                <button
                  key={r}
                  aria-pressed={on}
                  onClick={() => setRole(r)}
                  style={{ display: "flex", alignItems: "center", gap: 8, border: "1px solid var(--line)", borderRadius: 980, padding: "6px 14px", font: "inherit", fontSize: 14, cursor: "pointer", background: on ? "var(--fill-2)" : "transparent", color: on ? "var(--ink)" : "var(--ink-2)" }}
                >
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: r === "all" ? "var(--ink)" : ROLE_DOT[r] }} />
                  {r === "all" ? "All stages" : r === "post" ? "Post-trade" : r[0].toUpperCase() + r.slice(1)}
                </button>
              );
            })}
          </div>
          <div style={{ background: "var(--surface)", borderRadius: 24, overflow: "hidden" }}>
            {PIPE.filter((p) => role === "all" || p[3] === role).map(([n, name, tier, r, what], i) => (
              <div key={n} style={{ display: "grid", gridTemplateColumns: "44px minmax(0,1fr)", gap: 16, padding: "20px 24px", borderTop: i ? "1px solid var(--line)" : 0 }}>
                <div style={{ width: 36, height: 36, borderRadius: "50%", background: "var(--fill)", display: "grid", placeItems: "center", fontSize: 13, fontWeight: 600, fontVariantNumeric: "tabular-nums", border: `2px solid ${ROLE_DOT[r]}` }}>{n}</div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 17, fontWeight: 600, letterSpacing: "-0.02em" }}>{name}</span>
                    <span style={{ fontSize: 12, fontWeight: 600, padding: "2px 8px", borderRadius: 980, background: TIER[tier][0], color: TIER[tier][1] }}>{tier}</span>
                    <span style={{ fontSize: 12, color: "var(--ink-3)" }}>{r}</span>
                  </div>
                  <div style={{ marginTop: 4, color: "var(--ink-2)", fontSize: 15, textWrap: "pretty" }}>{what}</div>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section id="agents" style={SECTION}>
          <div style={EYEBROW}>03 · The agents</div>
          <h2 style={{ ...H2, margin: "6px 0 16px" }}>The right model for each job.</h2>
          <p style={LEDE}>
            Every agent declares a default model in its prompt file, overridable per agent or globally with an env var. Cheap models run the mechanical gates; the expensive ones run research and the investment decision.
          </p>
          <div style={grid("200px")}>
            {TIERS.map(([t, note]) => (
              <div key={t} style={{ background: "var(--surface)", borderRadius: 22, padding: 24, display: "flex", flexDirection: "column", gap: 10 }}>
                <span style={{ alignSelf: "flex-start", fontSize: 13, fontWeight: 600, padding: "3px 10px", borderRadius: 980, background: TIER[t][0], color: TIER[t][1] }}>{t}</span>
                <div style={{ fontSize: 40, fontWeight: 600, letterSpacing: "-0.04em", lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>
                  {PIPE.filter((p) => p[2] === t).length}
                  <span style={{ fontSize: 15, fontWeight: 500, color: "var(--ink-3)", letterSpacing: 0 }}> stages</span>
                </div>
                <div style={{ color: "var(--ink-2)", fontSize: 15 }}>{note}</div>
              </div>
            ))}
          </div>

          <div style={{ ...grid("min(100%,340px)", 28), marginTop: 48, alignItems: "start" }}>
            <div>
              <h3 style={{ margin: "0 0 8px", fontSize: 24, letterSpacing: "-0.03em" }}>Six sector desks, one router</h3>
              <p style={{ margin: 0, color: "var(--ink-2)" }}>
                The single Sector Analyst stage is really six opus-tier specialists. Each ticker is routed to the right one by sector.
              </p>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {SECTORS.map((s) => (
                <span key={s} style={{ padding: "10px 18px", borderRadius: 980, background: "var(--surface)", fontWeight: 500 }}>{s}</span>
              ))}
            </div>
          </div>

          <h3 style={{ margin: "56px 0 8px", fontSize: 24, letterSpacing: "-0.03em" }}>The rules every agent runs under</h3>
          <p style={{ margin: "0 0 20px", color: "var(--ink-2)" }}>Five constraints, enforced in code, not just in prompts.</p>
          <div style={grid("min(100%,300px)")}>
            {RULES.map(([h, p]) => (
              <article key={h} style={CARD}>
                <h4 style={{ margin: "0 0 6px", fontSize: 19 }}>{h}</h4>
                <p style={{ margin: 0, color: "var(--ink-2)", fontSize: 15 }}>{p}</p>
              </article>
            ))}
          </div>
        </section>

        <section id="loops" style={SECTION}>
          <div style={EYEBROW}>04 · The loops</div>
          <h2 style={{ ...H2, margin: "6px 0 16px" }}>The loops that keep it alive.</h2>
          <p style={LEDE}>
            The pipeline is one cycle. These workers fire it on repeat, keep data fresh, and connect a hosted UI to processes on your machine.
          </p>
          <div style={grid("min(100%,440px)")}>
            {LOOPS.map(([name, cmd, cadence, what, why, when]) => (
              <article key={cmd} style={{ ...CARD, display: "flex", flexDirection: "column", gap: 12 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                  <h3 style={{ margin: 0, fontSize: 21, letterSpacing: "-0.02em" }}>{name}</h3>
                  <span style={{ fontSize: 12, fontWeight: 600, color: "var(--ink-2)", background: "var(--fill)", padding: "3px 10px", borderRadius: 980, whiteSpace: "nowrap" }}>{cadence}</span>
                </div>
                <code style={{ alignSelf: "flex-start" }}>npm run {cmd}</code>
                <div style={{ display: "grid", gridTemplateColumns: "52px minmax(0,1fr)", gap: "8px 12px", fontSize: 15 }}>
                  {[["What", what], ["Why", why], ["When", when]].map(([k, v]) => (
                    <FragmentRow key={k} k={k} v={v} />
                  ))}
                </div>
              </article>
            ))}
          </div>
          <div style={{ marginTop: 16, background: "var(--fill)", borderRadius: 22, padding: "22px 26px", color: "var(--ink-2)", fontSize: 15 }}>
            <b style={{ color: "var(--ink)" }}>Weekly India enrichment</b> runs on a Vercel cron rather than a worker. It refreshes ~34 price histories for India-book betas, guarded by a <code>CRON_SECRET</code> bearer token.
          </div>
        </section>

        <section id="operator" style={SECTION}>
          <div style={EYEBROW}>05 · Operator runbook</div>
          <h2 style={{ ...H2, margin: "6px 0 16px" }}>What an operator actually does.</h2>
          <p style={LEDE}>The system reads, reasons and stages. A human owns the capital, the connections and the kill switch.</p>
          <ol style={{ listStyle: "none", margin: 0, padding: 0, background: "var(--surface)", borderRadius: 24, overflow: "hidden" }}>
            {RUNBOOK.map(([h, p], i) => (
              <li key={h} style={{ display: "grid", gridTemplateColumns: "44px minmax(0,1fr)", gap: 16, padding: "22px 26px", borderTop: i ? "1px solid var(--line)" : 0 }}>
                <div style={{ width: 36, height: 36, borderRadius: "50%", background: "var(--btn)", color: "var(--btn-ink)", display: "grid", placeItems: "center", fontWeight: 600 }}>{i + 1}</div>
                <div>
                  <div style={{ fontSize: 19, fontWeight: 600 }}>{h}</div>
                  <div style={{ color: "var(--ink-2)", fontSize: 15, marginTop: 2 }}>{p}</div>
                </div>
              </li>
            ))}
          </ol>
        </section>
      </main>

      <section style={{ background: "var(--inv)", color: "var(--inv-ink)" }}>
        <div style={{ maxWidth: 1080, margin: "0 auto", padding: "clamp(72px,10vw,128px) 20px", textAlign: "center" }}>
          <div style={{ fontSize: 17, color: "var(--inv-2)" }}>That&apos;s the whole machine.</div>
          <h2 style={{ margin: "8px 0 28px", fontSize: "clamp(40px,6vw,72px)", letterSpacing: "-0.045em", lineHeight: 1.02, fontWeight: 700 }}>See it running.</h2>
          <div style={{ display: "flex", gap: 14, justifyContent: "center", flexWrap: "wrap" }}>
            <Link href="/desk" style={{ background: "var(--inv-ink)", color: "var(--inv)", padding: "13px 24px", borderRadius: 980, fontWeight: 500, textDecoration: "none" }}>
              Enter the desk
            </Link>
            <Link href="/guided" style={{ color: "var(--inv-ink)", padding: "13px 8px" }}>
              Take the guided tour ›
            </Link>
          </div>
        </div>
      </section>
      <footer style={{ maxWidth: 1080, margin: "0 auto", padding: "24px 20px 40px", display: "flex", flexWrap: "wrap", gap: 12, justifyContent: "space-between", fontSize: 12, color: "var(--ink-3)" }}>
        <span>© 2026 Meridian Capital Intelligence</span>
        <span style={{ display: "flex", gap: 16 }}>
          <Link href="/">Home</Link>
          <Link href="/guided">Guided tour</Link>
          <Link href="/desk">Desk</Link>
        </span>
      </footer>
    </div>
  );
}

function FragmentRow({ k, v }: { k: string; v: string }) {
  return (
    <>
      <span style={{ fontWeight: 600, color: "var(--ink-3)" }}>{k}</span>
      <span style={{ color: "var(--ink-2)" }}>{v}</span>
    </>
  );
}
