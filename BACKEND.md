# MERIDIAN backend (Appwrite + Upstash Vector)

All persistence runs on **Appwrite Cloud Free**. Embeddings live in **Upstash Vector** (free tier). Nothing in this stack costs money at prototype scale — only the LLM API calls do.

## 1. Environment

Copy and fill:

```bash
cp .env.local.example .env.local
```

Required:

- `NEXT_PUBLIC_APPWRITE_ENDPOINT` — `https://fra.cloud.appwrite.io/v1` (already set)
- `NEXT_PUBLIC_APPWRITE_PROJECT_ID` — `6a1436090022b92b275d` (already set)
- `NEXT_PUBLIC_APPWRITE_DATABASE_ID` — `meridian`
- `APPWRITE_API_KEY` — create in Console → Settings → API Keys. Scopes: `databases.*`, `documents.*`, `collections.*`, `attributes.*`, `indexes.*`, `users.read`.
- `UPSTASH_VECTOR_REST_URL` / `_TOKEN` — from <https://console.upstash.com/vector>

## 2. Push the schema to Appwrite

Install the CLI once:

```bash
npm i -g appwrite-cli
appwrite login
```

From repo root:

```bash
appwrite push collections
```

This reads `appwrite.json` and creates the `meridian` database, 11 collections, attributes, indexes, and permissions in your project. Re-run any time `appwrite.json` changes — it diffs.

## 3. Architecture

| Concern | Where it lives |
| --- | --- |
| Browser SDK | [src/lib/appwrite/client.ts](src/lib/appwrite/client.ts) — `Account`, `Databases`, realtime subscriptions |
| Server SDK | [src/lib/appwrite/server.ts](src/lib/appwrite/server.ts) — `createSessionClient()` (per-user) and `createAdminClient()` (API-key) |
| Auth server actions | [src/lib/appwrite/auth.ts](src/lib/appwrite/auth.ts) — `signUp`, `signIn`, `signOut`, `getCurrentUser` |
| Typed schema | [src/lib/appwrite/schema.ts](src/lib/appwrite/schema.ts) — collection ID constants + document types |
| Vector client | [src/lib/vector/upstash.ts](src/lib/vector/upstash.ts) — `vector.upsert`, `vector.query` |
| Schema source | [appwrite.json](appwrite.json) — collections, attributes, indexes |

## 4. Collections

| Collection | Purpose | Screen |
| --- | --- | --- |
| `agents` | one row per autonomous agent | Swarm |
| `clusters` | groups of agents by theme | Swarm |
| `agent_events` | thoughts / tool calls / handoffs (firehose) | Swarm |
| `filings` | SEC filings queued for parsing | Research |
| `memos` | agent-authored investment theses | Research |
| `positions` | current book | Portfolio |
| `trades` | execution log | Portfolio |
| `scenarios` | stress tests + their P&L deltas | Portfolio |
| `governance_events` | approvals / blocks / policy changes | Console |
| `budget_ledger` | spend by category (LLM, data, compute, venue) | Console / Compute |
| `operator_messages` | chat thread with the assistant | Console |
| `fund_snapshots` | daily NAV / P&L time series — drives the P&L chart + derived KPIs | Portfolio |
| `model_routes` | inference-plane load / latency per model | Compute |
| `pipelines` | data/agent pipeline status + throughput | Compute |
| `compute_nodes` | GPU fabric zones (count / utilization / temp) | Compute |

`operator_messages` uses document-level security so each operator only reads their own messages. The other collections are shared across all signed-in users (collection-level `users` permission).

## 5. Realtime

Appwrite Realtime is WebSockets out of the box. Subscribe from a client component:

```ts
import { client } from "@/lib/appwrite/client";

const unsub = client.subscribe(
  "databases.meridian.collections.agent_events.documents",
  (msg) => { /* msg.payload is an AgentEvent */ }
);
```

This replaces the "WebSockets + Redis" line item in the README.

## 6. What's still mocked

- **Portfolio** and **Compute** now read live from Appwrite. NAV is summed from `positions`; KPIs (YTD/MTD/Sharpe/Sortino/Max DD/Vol) are computed from the `fund_snapshots` return series; net factor exposures are aggregated from each position's `factor_exposures_json`; the scenario tree renders `scenarios`. Compute drives the GPU rack from `compute_nodes`, routing from `model_routes`, pipelines from `pipelines`, telemetry from fabric + routes + ledger, the knowledge graph from memo `entities_json` + position tickers, and venues from distinct `trades.venue`. Each panel falls back to an empty-state message when its collection is empty.
- Any remaining mock data in [src/lib/meridian/data.ts](src/lib/meridian/data.ts) is no longer wired into Portfolio/Compute. Other screens migrate on the same pattern (query in `queries.ts` → component fetch with fallback → row in `scripts/seed.ts`).
- LangGraph / agent runtime: nothing yet. Will live in an Appwrite Function (Node) once we wire the first agent loop. Until then `scripts/seed.ts` (idempotent) populates all collections; new collections are created headlessly with `node scripts/restore-schema.mjs` (avoid `appwrite push tables` — it has wiped the DB before).

## 7. Free-tier limits to watch

| Service | Free limit | What kills it |
| --- | --- | --- |
| Appwrite Cloud | 75K MAU, 5 GB storage, 3.5M function executions/mo, 750K DB reads/mo | Tight agent loops writing many events per second |
| Upstash Vector | 10K vectors, 10K queries/day | Embedding every chunk of every filing |
| Vercel Hobby | 100 GB bandwidth/mo, non-commercial | Going viral |
