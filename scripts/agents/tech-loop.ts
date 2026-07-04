/**
 * MERIDIAN — US (tech) desk loop.
 *
 * Thin wrapper over the shared desk loop (see desk-loop.ts for the cycle body,
 * stop handling, budget gate, and env knobs). This file only supplies the
 * US-desk config: the US universe, the US agent roster, market="US", and the
 * IBKR sync route.
 *
 * Run with: npm run agents:tech   (or via the Operator Console "start" button)
 */
import { nextTicker, sectorOf } from "./universe";
import { bootstrapAgents } from "./nodes";
import { runDesk } from "./desk-loop";

runDesk({
  key: "tech",
  envPrefix: "MERIDIAN_TECH",
  label: "MERIDIAN loop",
  market: "US",
  syncPath: "/api/ibkr/sync",
  bootstrap: bootstrapAgents,
  nextTicker,
  sectorOf,
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
