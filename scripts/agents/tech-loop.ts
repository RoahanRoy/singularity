/**
 * MERIDIAN — Tech-sector MVP agent loop.
 *
 * Run with: npm run agents:tech   (or via the Operator Console "start" button)
 *
 * Prerequisites:
 *   1. `claude login` (uses your Pro/Max subscription for LLM calls)
 *   2. .env.local has Appwrite endpoint / project / database / API key
 *   3. `appwrite push collections` has been run
 *
 * Behavior: runs continuously — each cycle picks one tech ticker (round-robin),
 * runs it through the seven agents, and writes every step to Appwrite so the
 * Swarm / Research / Portfolio screens tick live. Between cycles it pauses for
 * MERIDIAN_TECH_INTERVAL_MS (default 60s). A SIGTERM (what the Console "stop"
 * button sends) finishes the current cycle, then exits cleanly; a second signal
 * exits immediately.
 *
 * Env knobs:
 *   MERIDIAN_TECH_ONCE=1             run a single cycle and exit (for testing)
 *   MERIDIAN_TECH_INTERVAL_MS        pause between cycles (default 60000)
 *   MERIDIAN_TECH_ERROR_BACKOFF_MS   pause after a failed cycle (default 15000)
 */
import { nextTicker, sectorOf } from "./universe";
import {
  bootstrapAgents,
  parser, earningsReview, analyst, critic, valuation,
  pm, risk, riskOverlay, compliance, smartRouter, broker, tca,
  budgetController,
  type Ctx,
} from "./nodes";

const RUN_ONCE = process.env.MERIDIAN_TECH_ONCE === "1";
const INTERVAL_MS = Number(process.env.MERIDIAN_TECH_INTERVAL_MS || 60_000);
const ERROR_BACKOFF_MS = Number(process.env.MERIDIAN_TECH_ERROR_BACKOFF_MS || 15_000);

let stopping = false;
function requestStop(sig: string) {
  if (stopping) process.exit(0); // second signal → don't wait, exit now
  stopping = true;
  console.log(`\n[tech] ${sig} received — finishing current cycle, then stopping…`);
}
process.on("SIGTERM", () => requestStop("SIGTERM"));
process.on("SIGINT", () => requestStop("SIGINT"));

/** Sleep that wakes early once a stop has been requested. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(t); clearInterval(iv); resolve(); };
    const t = setTimeout(done, ms);
    const iv = setInterval(() => { if (stopping) done(); }, 250);
    if (typeof t.unref === "function") t.unref();
    if (typeof iv.unref === "function") iv.unref();
  });
}

type AgentIds = Awaited<ReturnType<typeof bootstrapAgents>>;

async function runCycle(agentIds: AgentIds): Promise<void> {
  const ticker = nextTicker();
  const sector = sectorOf(ticker);
  console.log(`\n=== MERIDIAN loop — ${ticker} (${sector}) ===\n`);

  let ctx: Ctx = { ticker, agentIds };
  ctx = await parser(ctx);
  ctx = await earningsReview(ctx);
  ctx = await analyst(ctx);
  ctx = await critic(ctx);
  ctx = await valuation(ctx);
  ctx = await pm(ctx);
  ctx = await risk(ctx);
  ctx = await riskOverlay(ctx);
  ctx = await compliance(ctx);
  ctx = await smartRouter(ctx);
  ctx = await broker(ctx);
  ctx = await tca(ctx);

  console.log(`\n=== Done. Trade: ${ctx.trade?.status ?? "no fill"} ===`);
}

async function main() {
  const agentIds = await bootstrapAgents();

  if (RUN_ONCE) {
    await runCycle(agentIds);
    return;
  }

  console.log(`[loop] continuous mode — base ${INTERVAL_MS}ms between cycles (MERIDIAN_TECH_ONCE=1 for a single run)`);
  let throttleMs = 0;
  while (!stopping) {
    // Budget gate — runs every cycle, can throttle or kill the loop.
    try {
      const verdict = await budgetController(agentIds);
      if (verdict.verdict === "kill") {
        console.log(`[loop] budget KILL — $${verdict.spend_24h_usd.toFixed(4)} of $${verdict.limit_24h_usd} (${verdict.pct_of_limit.toFixed(1)}%). Stopping.`);
        break;
      }
      throttleMs = verdict.verdict === "throttle"
        ? Math.max(INTERVAL_MS, verdict.next_check_minutes * 60_000)
        : 0;
    } catch (err) {
      console.warn(`[loop] budget check failed (continuing): ${(err as Error).message}`);
    }

    try {
      await runCycle(agentIds);
    } catch (err) {
      console.error(`[loop] cycle failed: ${(err as Error).message}`);
      if (!stopping) await sleep(ERROR_BACKOFF_MS);
      continue;
    }
    if (stopping) break;
    await sleep(Math.max(INTERVAL_MS, throttleMs));
  }
  console.log(`[loop] stopped.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
