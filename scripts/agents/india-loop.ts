/**
 * MERIDIAN — India desk loop (NSE).
 *
 * Thin wrapper over the shared desk loop (see desk-loop.ts for the cycle body,
 * stop handling, budget gate, and env knobs). This file only supplies the
 * India-desk config: the NSE universe, the India agent roster (India-tagged
 * clusters, " · IN" names), market="IN" (which makes the parser skip EDGAR and
 * reason LLM-only over the company), and the Horizon sync route (the real
 * book comes from Horizon; `?loop=1` re-pulls it at most every 15 minutes).
 *
 * Env knobs mirror the US desk under the MERIDIAN_INDIA_* prefix.
 *
 * Run with: npm run agents:india   (or via the Operator Console "start" button)
 */
import { nextIndiaTicker, indiaSectorOf, INDIA_UNIVERSE } from "./universe";
import { bootstrapAgentsIndia } from "./nodes";
import { fetchLatestIndiaKey, hasNseAnnouncements } from "./india";
import { runDesk } from "./desk-loop";

runDesk({
  key: "india",
  envPrefix: "MERIDIAN_INDIA",
  label: "MERIDIAN India loop",
  market: "IN",
  syncPath: "/api/horizon/sync?loop=1",
  bootstrap: bootstrapAgentsIndia,
  // Held ETFs, gold bonds and SME listings post no NSE announcements for the
  // chain to read, so the round-robin walks past them. Only the pick is
  // checked (NSE rate-limits hard), moving on until one has announcements.
  nextTicker: async (held) => {
    let pick = await nextIndiaTicker(held);
    for (let i = 1; i < held.length && !(await hasNseAnnouncements(pick)); i++) {
      console.log(`[india] ${pick}: no NSE announcements, skipping`);
      pick = await nextIndiaTicker(held);
    }
    return pick;
  },
  sectorOf: indiaSectorOf,
  universe: INDIA_UNIVERSE,
  latestFilingKey: fetchLatestIndiaKey,
  // NSE fronts its JSON behind a bot wall and rate-limits hard, so probe fewer
  // names per cycle than the US desk; news-driven events (Appwrite) fill the gap.
  eventScanBatch: 4,
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
