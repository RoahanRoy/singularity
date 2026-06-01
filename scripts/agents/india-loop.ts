/**
 * MERIDIAN — India-desk agent loop (NSE).
 *
 * Run with: npm run agents:india   (or via the Operator Console "start" button)
 *
 * Mirrors the tech loop, but for the India book:
 *   - bootstraps the India agent roster (India-tagged clusters, " · IN" names),
 *   - each cycle refreshes the connected Kite holdings (best-effort, via the
 *     /api/kite/sync route) so the book stays current — "tracked over time",
 *   - round-robins through the *held* NSE tickers (falls back to a static NSE
 *     universe when nothing is connected yet),
 *   - runs the same seven-stage chain with ctx.market="IN", which makes the
 *     parser skip EDGAR and reason LLM-only over the company.
 *
 * Env knobs mirror the tech loop (MERIDIAN_INDIA_* variants):
 *   MERIDIAN_INDIA_ONCE=1            run a single cycle and exit
 *   MERIDIAN_INDIA_INTERVAL_MS       pause between cycles (default 60000)
 *   MERIDIAN_INDIA_ERROR_BACKOFF_MS  pause after a failed cycle (default 15000)
 *   MERIDIAN_SYNC_BASE               base URL of the running app for Kite sync
 *                                    (default http://localhost:3000)
 */
import { nextIndiaTicker, indiaSectorOf } from "./universe";
import { db, DB, Query } from "./appwrite";
import {
  bootstrapAgentsIndia,
  parser, earningsReview, analyst, quant, critic, valuation, cio,
  pm, treasury, risk, riskOverlay, compliance, smartRouter, broker, tca, attribution,
  budgetController,
  type Ctx,
} from "./nodes";

const RUN_ONCE = process.env.MERIDIAN_INDIA_ONCE === "1";
const INTERVAL_MS = Number(process.env.MERIDIAN_INDIA_INTERVAL_MS || 60_000);
const ERROR_BACKOFF_MS = Number(process.env.MERIDIAN_INDIA_ERROR_BACKOFF_MS || 15_000);
const SYNC_BASE = (process.env.MERIDIAN_SYNC_BASE || process.env.KITE_REDIRECT_BASE || "http://localhost:3000").replace(/\/$/, "");

let stopping = false;
function requestStop(sig: string) {
  if (stopping) process.exit(0);
  stopping = true;
  console.log(`\n[india] ${sig} received — finishing current cycle, then stopping…`);
}
process.on("SIGTERM", () => requestStop("SIGTERM"));
process.on("SIGINT", () => requestStop("SIGINT"));

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(t); clearInterval(iv); resolve(); };
    const t = setTimeout(done, ms);
    const iv = setInterval(() => { if (stopping) done(); }, 250);
    if (typeof t.unref === "function") t.unref();
    if (typeof iv.unref === "function") iv.unref();
  });
}

/** Refresh connected Kite holdings via the app's sync route. Best-effort. */
async function refreshHoldings(): Promise<void> {
  try {
    const res = await fetch(`${SYNC_BASE}/api/kite/sync`, { method: "POST" });
    if (!res.ok) console.warn(`[india] sync route ${res.status} (continuing)`);
  } catch (err) {
    console.warn(`[india] holdings sync skipped (${(err as Error).message})`);
  }
}

/** Current held NSE tickers from the India book. */
async function heldTickers(): Promise<string[]> {
  try {
    const res = await db.listDocuments(DB, "positions", [
      Query.equal("market", "IN"),
      Query.limit(200),
    ]);
    return res.documents.map((d) => String(d.ticker)).filter(Boolean);
  } catch (err) {
    console.warn(`[india] could not read held book (${(err as Error).message})`);
    return [];
  }
}

type AgentIds = Awaited<ReturnType<typeof bootstrapAgentsIndia>>;

async function runCycle(agentIds: AgentIds): Promise<void> {
  await refreshHoldings();
  const held = await heldTickers();
  const ticker = nextIndiaTicker(held);
  const sector = indiaSectorOf(ticker);
  console.log(`\n=== MERIDIAN India loop — ${ticker} (${sector}) · book=${held.length} names ===\n`);

  let ctx: Ctx = { ticker, agentIds, market: "IN" };
  ctx = await parser(ctx);
  ctx = await earningsReview(ctx);
  ctx = await analyst(ctx);
  ctx = await quant(ctx);
  ctx = await critic(ctx);
  ctx = await valuation(ctx);
  ctx = await cio(ctx);
  ctx = await pm(ctx);
  ctx = await treasury(ctx);
  ctx = await risk(ctx);
  ctx = await riskOverlay(ctx);
  ctx = await compliance(ctx);
  ctx = await smartRouter(ctx);
  ctx = await broker(ctx);
  ctx = await tca(ctx);
  ctx = await attribution(ctx);

  console.log(`\n=== Done. Trade: ${ctx.trade?.status ?? "no fill"} ===`);
}

async function main() {
  const agentIds = await bootstrapAgentsIndia();

  if (RUN_ONCE) {
    await runCycle(agentIds);
    return;
  }

  console.log(`[india] continuous mode — base ${INTERVAL_MS}ms between cycles (MERIDIAN_INDIA_ONCE=1 for a single run)`);
  let throttleMs = 0;
  while (!stopping) {
    try {
      const verdict = await budgetController(agentIds);
      if (verdict.verdict === "kill") {
        console.log(`[india] budget KILL — ${verdict.tokens_24h.toLocaleString()} of ${verdict.token_limit_24h.toLocaleString()} tokens. Stopping.`);
        break;
      }
      throttleMs = verdict.verdict === "throttle"
        ? Math.max(INTERVAL_MS, verdict.next_check_minutes * 60_000)
        : 0;
    } catch (err) {
      console.warn(`[india] budget check failed (continuing): ${(err as Error).message}`);
    }

    try {
      await runCycle(agentIds);
    } catch (err) {
      console.error(`[india] cycle failed: ${(err as Error).message}`);
      if (!stopping) await sleep(ERROR_BACKOFF_MS);
      continue;
    }
    if (stopping) break;
    await sleep(Math.max(INTERVAL_MS, throttleMs));
  }
  console.log(`[india] stopped.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
