# MERIDIAN — Autonomous Capital Intelligence

An interactive prototype of an AI-native hedge fund operating system. A small team of human operators supervises clusters of specialized AI agents that read SEC filings, parse earnings, generate trade theses, construct portfolios, and stage trades for approval — with humans in the loop by default.

Codename: **MERIDIAN**. Concept for an AI-native hedge fund (YC Spring 2026 brief).

## Two routes

- `/` — **Operator view.** Full 5-screen cockpit: Swarm Command, Research Engine, Portfolio OS, Operator Console, Compute Layer. Live data from Appwrite, realtime agent-activity streams, dense information architecture. Behind an operator sign-in gate.
- `/guided` — **Guided tour.** Simplified, one-idea-at-a-time walkthrough with plain-English explanations. Hover any underlined term (NAV, Sharpe, VaR, alpha, factor exposure, etc.) for an inline glossary tooltip.

## What's actually wired

The frontend, persistence, auth, and the first agent loop are **built and running** — not scaffolding. The screens read live from Appwrite (with realtime subscriptions and empty-state fallbacks), the operator console talks to an auto-started assistant, and a filing → thesis → risk → compliance → paper-fill chain runs against real SEC EDGAR data.

| Layer               | Choice                                                       | Status |
| ------------------- | ------------------------------------------------------------ | ------ |
| Frontend            | Next.js 16 (App Router) + React 19 + TypeScript              | ✅ built |
| UI                  | Tailwind CSS v4 + shadcn/ui                                  | ✅ built |
| Auth                | Appwrite Auth (email/password) + operator email allowlist    | ✅ built |
| DB                  | Appwrite Databases — 17 collections (see [BACKEND.md](BACKEND.md)) | ✅ built |
| Realtime            | Appwrite Realtime (WebSockets) — agent events, trades, chat  | ✅ built |
| Embeddings          | Upstash Vector (filings / memos)                             | ✅ wired |
| Agent runtime       | Function-chain orchestrator in `scripts/agents/` + responder | ✅ first loop live |
| LLM layer           | Claude + OpenAI (server-only keys)                           | ✅ wired |
| Data ingestion      | SEC EDGAR filing reader (HTTP-only trust tier)               | ✅ live |
| Infra               | Vercel (frontend) + Appwrite Cloud Free                      | ✅ deployed |

Backend collapses into Appwrite Cloud's free tier (75K MAU, 5 GB storage, 3.5M function executions/mo, realtime included) — one service replaces the previously planned Clerk + Postgres + Railway + Redis + FastAPI stack. The only thing that costs money at prototype scale is LLM API calls; spend is logged to the `budget_ledger` collection.

## The agent loop

`npm run agents:tech` runs one orchestrator cycle through a bounded function chain (see [scripts/agents/AGENT_DESIGN.md](scripts/agents/AGENT_DESIGN.md)):

```
edgarReader → summarize → indexFiling → analyst → critic → pm → risk → riskOverlay → compliance → broker
```

Three principles enforced throughout:

- **Trust tiers.** Filing ingestion is split so untrusted bytes never reach an agent with tools: `edgarReader` is HTTP-only (no LLM, no DB), `filing-summarizer` is LLM-only (no fetch, no DB), `indexFiling` is persistence-only (no LLM). A prompt-injection attempt in a filing can at worst produce nonsense JSON that fails schema check.
- **Human-in-the-loop by default.** A trade auto-executes only if the critic passes, `conviction × score ≥ 0.4`, **and** `MERIDIAN_AUTO_APPROVE=1` is set for the session. Anything weaker writes the memo as `review` and stops.
- **One job per agent.** Analysts don't size, PMs don't execute, risk doesn't re-size, compliance doesn't approve sizing. Each system prompt lives in `scripts/agents/prompts/<slug>.md` — never inlined in TypeScript.

### Choosing models per agent

Each prompt declares a default model in its frontmatter (`model: haiku | sonnet | opus`). That default can be overridden at runtime via environment variables — no file edits, no rebuild. Precedence, most specific wins:

| Variable | Scope | Example |
|---|---|---|
| `MERIDIAN_MODEL__<SLUG>` | one agent (filename upper-cased, non-alphanumerics → `_`) | `MERIDIAN_MODEL__RED_TEAM_CRITIC=opus` |
| `MERIDIAN_MODEL_<TIER>` | every agent whose prompt declares that tier | `MERIDIAN_MODEL_SONNET=opus` (bump all sonnet agents) |
| `MERIDIAN_MODEL` | every agent (blunt global override) | `MERIDIAN_MODEL=haiku` (run everything cheap) |

A value must be a tier alias (`haiku`/`sonnet`/`opus`) or a full `claude-…` model id; anything else is logged and ignored, falling back to the declared default. Heavier models burn the rolling token budget (`MERIDIAN_BUDGET_DAILY_TOKENS`, default ~5M) faster, so the loop will throttle/kill sooner the more agents you promote.

The **operator-console responder** (`npm run agents:responder`) auto-starts when the Next server boots (via `src/instrumentation.ts`; disable with `MERIDIAN_AUTOSTART=0`) so the assistant replies to operator messages. Both workers are managed by a supervisor exposed at `/api/agents` (status) and `/api/agents/control` (start / stop / restart).

## Running

```bash
npm install
cp .env.local.example .env.local   # then fill in the keys below
```

Required environment (`.env.local`):

- `NEXT_PUBLIC_APPWRITE_ENDPOINT`, `NEXT_PUBLIC_APPWRITE_PROJECT_ID`, `NEXT_PUBLIC_APPWRITE_DATABASE_ID` — Appwrite project (defaults pre-filled in the example)
- `NEXT_PUBLIC_OPERATOR_EMAILS` — comma-separated allowlist; signed-in users outside it are signed out
- `APPWRITE_API_KEY` — server-only, for schema + seed scripts
- `UPSTASH_VECTOR_REST_URL` / `_TOKEN` — embeddings
- `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` — LLM calls (agent loop only)
- `KITE_API_KEY` / `KITE_API_SECRET` — Zerodha Kite Connect (India desk), server-only. Without these, linking or refreshing a Kite account fails with `KITE_API_KEY is not set`. **Must also be set in Vercel for production** — they have no `NEXT_PUBLIC_` prefix, so they don't ship with the build; add them in the project env vars and redeploy. Optional `KITE_APP_LABEL` names the app in the Connect UI.
- `KITE_API_KEY_2` / `KITE_API_SECRET_2` (+ optional `KITE_APP_LABEL_2`), up to `_5` — **additional Kite apps**. Zerodha Personal apps are single-user (locked to the Zerodha id that created them), so to aggregate a *second* account in the India book that account holder creates their **own** Personal app and you add its key/secret here. The India desk shows one Connect button per configured app and sums every connected account's holdings into one book. Each app's Redirect URL must point at the same `<KITE_REDIRECT_BASE>/api/kite/callback`.
- `KITE_REDIRECT_BASE` — base URL Kite redirects back to after login (e.g. `http://localhost:3000` locally, your `https://…vercel.app` in production; no trailing slash). The Kite app's Redirect URL in the [developer console](https://developers.kite.trade/apps) must be set to `<KITE_REDIRECT_BASE>/api/kite/callback` and match the environment, or the login round-trip fails. Kite access tokens expire daily, so a re-login is expected each trading morning.
- `CRON_SECRET` — bearer token guarding the weekly India-enrichment cron (`/api/cron/enrich-india`). Set the same value in the Vercel project's env vars; Vercel attaches it to scheduled requests. Generate one with `openssl rand -hex 32`.
- `HORIZON_URL` / `HORIZON_EXPORT_TOKEN` — make **Horizon** (the operator's finance app) the source of the real book. See **Using Horizon as the book source** below. Server-only; set in Vercel too.
- `IBKR_GATEWAY_URL` — base URL of your local Interactive Brokers **Client Portal Gateway** (default `https://localhost:5000`). Only set if your gateway runs elsewhere. See **Connecting IBKR** below.

### Using Horizon as the book source

[Horizon](https://github.com/RoahanRoy/finance-manager) already maintains every real investment — Kite, Zerodha Coin, Groww, IBKR, Trading 212, Revolut, across family members — and serves that book read-only at `/api/export/holdings`. With it configured, Meridian pulls the whole book from there instead of linking each brokerage:

1. In Horizon's Vercel env set `HOLDINGS_EXPORT_TOKEN` (`openssl rand -hex 32`) and `HOLDINGS_EXPORT_EMAIL` (your Horizon login email), then redeploy.
2. In Meridian's env (`.env.local` and Vercel) set `HORIZON_URL=https://<horizon-domain>` and `HORIZON_EXPORT_TOKEN=<same token>`, then redeploy.
3. Open **Portfolio OS** and hit **sync now** on the **Horizon · Real Book** panel.

What a sync does (`POST /api/horizon/sync`, [src/lib/horizon/sync.ts](src/lib/horizon/sync.ts)):

- Rupee holdings land on the **India** desk in INR; everything held abroad lands on the **US** desk, converted to USD at Horizon's own rate. The same instrument held by several members or brokers is one row.
- Mutual funds have no listing, so they are booked as `MF:<AMFI code>` with the scheme name in `label`; the desk loops skip `MF:` tickers when picking names to research.
- Rows carry `horizon_source` (the brokers, e.g. `Kite · Groww`). Every sync replaces them — and removes any direct Kite / IBKR rows, since Horizon supersedes those links. The paper book is never touched.
- While Horizon is configured, the Kite / IBKR panels are hidden and `/api/kite/sync` / `/api/ibkr/sync` delegate to the Horizon sync, so the running desk loops keep the book fresh (re-pulled at most every 15 minutes).

Schema: `positions` gains `horizon_source` (string 64) and `label` (string 128) — `node scripts/restore-schema.mjs` adds them.

### Connecting IBKR (US desk)

The US desk pulls your real positions from Interactive Brokers the same way the India desk pulls from Zerodha — read-only, projected onto the `positions` + `fund_snapshots` book (`market="US"`). IBKR has no hosted OAuth redirect, so the brokerage session lives in a **local gateway** you run:

1. Download and start IBKR's **Client Portal Gateway** (Java). It listens on `https://localhost:5000` with a self-signed cert.
2. Open `https://localhost:5000` in a browser and complete the IBKR SSO login (accept the self-signed cert warning).
3. In the app, switch the desk to **US**, open **Portfolio OS**, and the **IBKR Accounts** panel shows the gateway state. Once it reads *"Gateway authenticated"*, click **+ Connect IBKR account**.

The app talks REST to the gateway server-side; it stores no IBKR password or token — only which account id the authenticated gateway exposes. The gateway session goes stale after inactivity (status flips to `needs_reauth`); re-login in the gateway and hit **reconnect**. Because the gateway is local-only, this flow runs on your laptop, not on Vercel. Endpoints: `/api/ibkr/status` (gateway auth), `/api/ibkr/connect` (register + first sync), `/api/ibkr/sync` (re-pull holdings).

Provision the database, then run the app:

```bash
node scripts/restore-schema.mjs     # create DB + 17 collections from appwrite.json (idempotent, additive)
npx tsx --env-file=.env.local scripts/seed.ts   # populate every collection (idempotent)
npm run dev
```

> Use `restore-schema.mjs` to create collections, **not** `appwrite push tables` — the CLI has misread this collections-format config as "no tables" and wiped the database before.

Then visit http://localhost:3000 for the operator view or http://localhost:3000/guided for the guided tour.

Optional — drive the agents manually:

```bash
npm run agents:tech        # one filing → thesis → risk → compliance → paper-fill cycle
npm run agents:responder   # operator-console assistant (also auto-starts with the server)
```

## Screens & their live sources

| Screen | Reads from |
| --- | --- |
| **Swarm Command** | `clusters`, `agents`, `agent_events` (realtime firehose) |
| **Research Engine** | `filings`, `memos` (+ `entities_json` graph, `filing_id` linkage) |
| **Portfolio OS** | `positions` (NAV + net factor exposures), `fund_snapshots` (P&L chart + derived KPIs), `scenarios` (stress tree), `trades` (pending votes) |
| **Operator Console** | `operator_messages` (live chat + responder), `governance_events`, `budget_ledger`, `positions` |
| **Compute Layer** | `compute_nodes` (GPU fabric), `model_routes`, `pipelines`, `budget_ledger`, memo entities (knowledge graph), `trades.venue` |

The `risk_limits` and `audit_log` collections back the agent runtime (the risk-officer and compliance nodes), not a screen yet. See [BACKEND.md](BACKEND.md) for the full collection schema, realtime channels, and free-tier limits.

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
    sign-in/page.tsx        # Appwrite email/password gate
    guided/                 # /guided route (walkthrough + glossary)
    api/agents/             # supervisor status + control endpoints
    globals.css             # tailwind + shadcn + MERIDIAN tokens
  instrumentation.ts        # auto-starts the console responder on boot
  components/
    ui/                     # shadcn primitives
    meridian/
      Shell.tsx             # rail / topbar / status frame
      AuthGate.tsx          # operator allowlist gate + context
      primitives.tsx        # Panel, Tag, UTCClock, Sparkline, MarketTicker
      GlossTerm.tsx         # hover-explained glossary term
      screens/              # Swarm, Research, Portfolio, Console, Compute
  lib/
    appwrite/               # client, server, auth, schema, queries
    agents/supervisor.ts    # spawns/tracks responder + tech workers
    vector/upstash.ts       # embeddings client
    meridian/               # data.ts (Swarm/ticker seed), glossary.ts
    auth/operator.ts        # operator-email allowlist helper

scripts/
  seed.ts                   # idempotent seed for every collection
  restore-schema.mjs        # headless collection creation from appwrite.json
  agents/                   # orchestrator, nodes, EDGAR reader, LLM client,
                            # prompts/*.md (one system prompt per agent)

reference/                  # the original Claude Design HTML/JSX prototype
```
