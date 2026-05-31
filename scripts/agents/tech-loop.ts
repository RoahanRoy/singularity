/**
 * MERIDIAN — Tech-sector MVP agent loop.
 *
 * Run with: npm run agents:tech
 *
 * Prerequisites:
 *   1. `claude login` (uses your Pro/Max subscription for LLM calls)
 *   2. .env.local has Appwrite endpoint / project / database / API key
 *   3. `appwrite push collections` has been run
 *
 * Behavior: picks one tech ticker (round-robin), runs it through the seven
 * agents, and writes every step to Appwrite so the Swarm / Research / Portfolio
 * screens tick live. Re-run, or wrap in `while true; do npm run agents:tech; sleep 60; done`.
 */
import { nextTicker } from "./universe";
import {
  bootstrapAgents,
  parser, analyst, critic, pm, risk, riskOverlay, compliance, broker,
  type Ctx,
} from "./nodes";

async function main() {
  const agentIds = await bootstrapAgents();
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
