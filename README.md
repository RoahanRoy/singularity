# MERIDIAN — Autonomous Capital Intelligence

An interactive prototype of an AI-native hedge fund operating system. Visualizes a future where a small team of human operators supervises thousands of specialized AI agents that read filings, parse earnings, generate trade theses, construct portfolios, and execute trades autonomously.

Codename: **MERIDIAN**. Concept for an AI-native hedge fund (YC Spring 2026 brief).

## Two routes

- `/` — **Operator view.** Full 5-screen cockpit: Swarm Command, Research Engine, Portfolio OS, Operator Console, Compute Layer. Live-ticking data, agent activity streams, dense information architecture.
- `/guided` — **Guided tour.** Simplified, one-idea-at-a-time walkthrough with plain-English explanations. Hover any underlined term (NAV, Sharpe, VaR, alpha, factor exposure, etc.) for an inline glossary tooltip.

## Stack

| Layer               | Choice                                                  |
| ------------------- | ------------------------------------------------------- |
| Frontend            | Next.js 16 (App Router) + TypeScript                    |
| UI                  | Tailwind CSS v4 + shadcn/ui                             |
| Auth                | Appwrite Auth _(planned)_                               |
| DB                  | Appwrite Databases _(planned)_                          |
| Realtime            | Appwrite Realtime (WebSockets) _(planned)_              |
| Storage             | Appwrite Storage _(planned)_                            |
| Backend APIs        | Appwrite Functions (Node/Python) _(planned)_            |
| Agent Orchestration | LangGraph in Appwrite Functions _(planned)_             |
| LLM Layer           | Claude + OpenAI _(planned)_                             |
| Infra               | Vercel (frontend) + Appwrite Cloud Free _(planned)_     |
| Analytics           | PostHog free tier _(planned)_                           |
| Observability       | Langfuse self-host / cloud hobby _(planned)_            |

Backend collapses into Appwrite Cloud's free tier (75K MAU, 2 DBs, 5 GB storage, 3.5M function executions/mo, realtime included) — one service replaces the previously planned Clerk + Postgres + Railway + Redis + FastAPI stack. The frontend layer is built; backend / agent / persistence layers are scaffolded as TODOs and will be wired up incrementally once Appwrite keys are configured.

## Running

```bash
npm install
npm run dev
```

Then visit http://localhost:3000 for the operator view or http://localhost:3000/guided for the guided tour.

## Design system

- Matte graphite surfaces (`#06070a` base, `#11141a` panels), scoped under `.meridian-root` so it coexists with shadcn variables
- Sodium-amber accent (`oklch(0.78 0.13 75)`) for alpha / conviction signals
- Cool cyan (`oklch(0.80 0.09 220)`) for AI reasoning paths
- Newsreader (serif headlines), Geist (UI), JetBrains Mono (data)
- No gradients, no glow soup

## Project structure

```
src/
  app/
    layout.tsx              # fonts + html shell
    page.tsx                # operator view (5-screen switch)
    guided/                 # /guided route
      page.tsx              # walkthrough + slides
      guided.css            # guided-tour styles
    globals.css             # tailwind + shadcn + MERIDIAN tokens
  components/
    ui/                     # shadcn primitives (button, tooltip, ...)
    meridian/
      Shell.tsx             # rail / topbar / status frame
      primitives.tsx        # Panel, Tag, UTCClock, Sparkline, MarketTicker
      GlossTerm.tsx         # hover-explained glossary term
      screens/
        Swarm.tsx           # agent constellation + clusters + activity feed
        Research.tsx        # filing queue + transcript + memo + entity graph
        Portfolio.tsx       # NAV / P&L / exposures / scenario tree / heatmap
        Console.tsx         # operator chat + governance + budget
        Compute.tsx         # GPU rack + routing + knowledge graph + venues
  lib/
    meridian/
      data.ts               # mock clusters / ticker / feed seed
      glossary.ts           # finance/AI term definitions (64 entries)
    utils.ts                # shadcn cn()

reference/                  # the original Claude Design HTML/JSX prototype
```
