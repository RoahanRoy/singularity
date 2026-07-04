/**
 * MERIDIAN — India desk loop (NSE).
 *
 * Thin wrapper over the shared desk loop (see desk-loop.ts for the cycle body,
 * stop handling, budget gate, and env knobs). This file only supplies the
 * India-desk config: the NSE universe, the India agent roster (India-tagged
 * clusters, " · IN" names), market="IN" (which makes the parser skip EDGAR and
 * reason LLM-only over the company), and the Kite sync route.
 *
 * Env knobs mirror the US desk under the MERIDIAN_INDIA_* prefix. The sync base
 * also falls back to KITE_REDIRECT_BASE when MERIDIAN_SYNC_BASE is unset.
 *
 * Run with: npm run agents:india   (or via the Operator Console "start" button)
 */
import { nextIndiaTicker, indiaSectorOf } from "./universe";
import { bootstrapAgentsIndia } from "./nodes";
import { runDesk } from "./desk-loop";

runDesk({
  key: "india",
  envPrefix: "MERIDIAN_INDIA",
  label: "MERIDIAN India loop",
  market: "IN",
  syncPath: "/api/kite/sync",
  syncBaseFallback: process.env.KITE_REDIRECT_BASE,
  bootstrap: bootstrapAgentsIndia,
  nextTicker: nextIndiaTicker,
  sectorOf: indiaSectorOf,
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
