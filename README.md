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
| Realtime            | WebSockets + Redis _(planned)_                          |
| Backend APIs        | FastAPI _(planned)_                                     |
| Agent Orchestration | LangGraph + Temporal _(planned)_                        |
| LLM Layer           | Claude + OpenAI _(planned)_                             |
| DB                  | Postgres + pgvector _(planned)_                         |
| Infra               | Vercel (frontend) + Railway _(planned)_                 |
| Auth                | Clerk _(planned)_                                       |
| Analytics           | PostHog _(planned)_                                     |
| Observability       | Langfuse _(planned)_                                    |

The frontend layer is built. Backend / agent / persistence layers are scaffolded as TODOs and will be wired up incrementally once keys/services are configured.

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
