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
import { nextTicker } from "./universe";
import {
  bootstrapAgents,
  parser, analyst, critic, pm, risk, riskOverlay, compliance, broker,
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
  console.log(`\n=== MERIDIAN tech loop — ${ticker} ===\n`);

  let ctx: Ctx = { ticker, agentIds };
  ctx = await parser(ctx);
  ctx = await analyst(ctx);
  ctx = await critic(ctx);
  ctx = await pm(ctx);
  ctx = await risk(ctx);
  ctx = await riskOverlay(ctx);
  ctx = await compliance(ctx);
  ctx = await broker(ctx);

  console.log(`\n=== Done. Trade: ${ctx.trade?.status ?? "no fill"} ===`);
}

async function main() {
  const agentIds = await bootstrapAgents();

  if (RUN_ONCE) {
    await runCycle(agentIds);
    return;
  }

  console.log(`[tech] continuous mode — ${INTERVAL_MS}ms between cycles (MERIDIAN_TECH_ONCE=1 for a single run)`);
  while (!stopping) {
    try {
      await runCycle(agentIds);
    } catch (err) {
      console.error(`[tech] cycle failed: ${(err as Error).message}`);
      if (!stopping) await sleep(ERROR_BACKOFF_MS);
      continue;
    }
    if (stopping) break;
    await sleep(INTERVAL_MS);
  }
  console.log(`[tech] stopped.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
