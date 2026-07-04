/**
 * MERIDIAN — shared desk agent loop.
 *
 * The US (tech) and India desks run the exact same continuous chain; the only
 * differences are their universe, bootstrap roster, market tag, and sync route.
 * Those are captured in a DeskConfig, and tech-loop.ts / india-loop.ts are thin
 * wrappers that call runDesk() with their config. Keeping one loop body means a
 * fix to the cycle mechanics (stop handling, budget gate, short-circuit) lands
 * on both desks at once.
 *
 * Run with: npm run agents:tech / npm run agents:india
 *   (or via the Operator Console "start" button, which spawns the wrapper.)
 *
 * Prerequisites:
 *   1. `claude login` (uses your Pro/Max subscription for LLM calls)
 *   2. .env.local has Appwrite endpoint / project / database / API key
 *
 * Behavior: runs continuously — each cycle picks one ticker (round-robin over
 * the held book, falling back to the desk's static universe), runs it through
 * the agent chain, and writes every step to Appwrite so the Swarm / Research /
 * Portfolio screens tick live. A SIGTERM (what the Console "stop" button sends)
 * finishes the current cycle, then exits cleanly; a second signal exits now.
 *
 * Env knobs (PREFIX is MERIDIAN_TECH or MERIDIAN_INDIA per desk):
 *   <PREFIX>_ONCE=1            run a single cycle and exit (for testing)
 *   <PREFIX>_INTERVAL_MS       pause between cycles (default 60000)
 *   <PREFIX>_ERROR_BACKOFF_MS  pause after a failed cycle (default 15000)
 *   MERIDIAN_SYNC_BASE         base URL of the running app for the sync route
 *                              (default http://localhost:3000)
 */
import type { Sector } from "./universe";
import { db, DB, Query } from "./appwrite";
import {
  parser, analyst, quant, critic, valuation, cio,
  pm, treasury, risk, riskOverlay, compliance, smartRouter, broker, tca, attribution,
  budgetController, sweepApprovedMemos,
  type Ctx,
} from "./nodes";
import { marketState } from "./market-hours";

export type DeskConfig = {
  /** Short tag used for log lines and env-var prefixing (e.g. "tech", "india"). */
  key: string;
  /** Uppercase env prefix, e.g. "MERIDIAN_TECH" / "MERIDIAN_INDIA". */
  envPrefix: string;
  /** Header shown at the top of each cycle, e.g. "MERIDIAN loop". */
  label: string;
  /** Desk market — gates positions reads and the parser's data source. */
  market: "US" | "IN";
  /** App sync route that refreshes this desk's holdings (best-effort). */
  syncPath: string;
  /** Extra fallback for the sync base URL (India uses KITE_REDIRECT_BASE). */
  syncBaseFallback?: string;
  /** Boots this desk's agent roster and returns the id map. */
  bootstrap: () => Promise<Record<string, string>>;
  /** Round-robins the desk universe, skipping/rotating past held names. */
  nextTicker: (held: readonly string[]) => string;
  /** Resolves a ticker's sector for this desk. */
  sectorOf: (ticker: string) => Sector;
};

export async function runDesk(config: DeskConfig): Promise<void> {
  const { key, envPrefix, market } = config;
  const RUN_ONCE = process.env[`${envPrefix}_ONCE`] === "1";
  const INTERVAL_MS = Number(process.env[`${envPrefix}_INTERVAL_MS`] || 60_000);
  const ERROR_BACKOFF_MS = Number(process.env[`${envPrefix}_ERROR_BACKOFF_MS`] || 15_000);
  // Trade only during the desk's regular session. When closed we don't run
  // cycles (no stale-price fills, no wasted tokens); we re-check on this cadence
  // so we resume promptly at the open. RUN_ONCE ignores hours (manual test).
  const IGNORE_HOURS = process.env.MERIDIAN_IGNORE_MARKET_HOURS === "1";
  const CLOSED_POLL_MS = Number(process.env[`${envPrefix}_CLOSED_POLL_MS`] || 10 * 60_000);
  const SYNC_BASE = (
    process.env.MERIDIAN_SYNC_BASE || config.syncBaseFallback || "http://localhost:3000"
  ).replace(/\/$/, "");

  let stopping = false;
  function requestStop(sig: string) {
    if (stopping) process.exit(0); // second signal → don't wait, exit now
    stopping = true;
    console.log(`\n[${key}] ${sig} received — finishing current cycle, then stopping…`);
  }
  process.on("SIGTERM", () => requestStop("SIGTERM"));
  process.on("SIGINT", () => requestStop("SIGINT"));

  /**
   * Sleep that wakes early once a stop has been requested. Note: the timer is
   * deliberately NOT unref'd — between cycles it is the only pending handle, so
   * unref'ing would let Node exit silently (code 0) before the sleep resolves,
   * killing the loop after a single pass. See ingest-held.ts for the same trap.
   */
  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => { clearTimeout(t); clearInterval(iv); resolve(); };
      const t = setTimeout(done, ms);
      const iv = setInterval(() => { if (stopping) done(); }, 250);
    });
  }

  /** Refresh connected holdings via the app's sync route. Best-effort. */
  async function refreshHoldings(): Promise<void> {
    try {
      const res = await fetch(`${SYNC_BASE}${config.syncPath}`, { method: "POST" });
      if (!res.ok) console.warn(`[${key}] sync route ${res.status} (continuing)`);
    } catch (err) {
      console.warn(`[${key}] holdings sync skipped (${(err as Error).message})`);
    }
  }

  /** Current held tickers for this desk's market. */
  async function heldTickers(): Promise<string[]> {
    try {
      const res = await db.listDocuments(DB, "positions", [
        Query.equal("market", market),
        Query.limit(200),
      ]);
      return res.documents
        .map((d) => String(d.ticker ?? "").toUpperCase())
        .filter(Boolean);
    } catch (err) {
      console.warn(`[${key}] could not read held book (${(err as Error).message})`);
      return [];
    }
  }

  type AgentIds = Awaited<ReturnType<typeof config.bootstrap>>;

  async function runCycle(agentIds: AgentIds): Promise<void> {
    await refreshHoldings();
    // Execute any trades the operator approved since the last cycle (no LLM —
    // uses the sizing persisted when the broker held the fill).
    const executed = await sweepApprovedMemos(market, agentIds);
    if (executed > 0) console.log(`[${key}] executed ${executed} operator-approved trade(s)`);
    const held = await heldTickers();
    const ticker = config.nextTicker(held);
    const sector = config.sectorOf(ticker);
    console.log(`\n=== ${config.label} — ${ticker} (${sector}) · book=${held.length} names ===\n`);

    let ctx: Ctx = { ticker, agentIds, market };
    ctx = await parser(ctx);
    if (!ctx.needsAnalysis) {
      console.log(`\n=== ${ticker}: no new disclosure — reused prior summary, skipping analysis ===`);
      return;
    }
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

  const agentIds = await config.bootstrap();

  if (RUN_ONCE) {
    await runCycle(agentIds);
    return;
  }

  console.log(`[${key}] continuous mode — base ${INTERVAL_MS}ms between cycles (${envPrefix}_ONCE=1 for a single run)`);
  let throttleMs = 0;
  let wasClosed = false;
  while (!stopping) {
    // Market-hours gate — skip cycles when the desk's session is closed.
    if (!IGNORE_HOURS) {
      const state = marketState(market);
      if (!state.open) {
        if (!wasClosed) {
          console.log(`[${key}] market closed (${state.label}) — pausing trading; re-checking every ${Math.round(CLOSED_POLL_MS / 60_000)}m (MERIDIAN_IGNORE_MARKET_HOURS=1 to override)`);
          wasClosed = true;
        }
        await sleep(CLOSED_POLL_MS);
        continue;
      }
      if (wasClosed) {
        console.log(`[${key}] market open — resuming trading`);
        wasClosed = false;
      }
    }

    // Budget gate — runs every cycle, can throttle or kill the loop.
    try {
      const verdict = await budgetController(agentIds);
      if (verdict.verdict === "kill") {
        console.log(`[${key}] budget KILL — ${verdict.tokens_24h.toLocaleString()} of ${verdict.token_limit_24h.toLocaleString()} tokens (${verdict.pct_of_limit.toFixed(1)}%). Stopping.`);
        break;
      }
      throttleMs = verdict.verdict === "throttle"
        ? Math.max(INTERVAL_MS, verdict.next_check_minutes * 60_000)
        : 0;
    } catch (err) {
      console.warn(`[${key}] budget check failed (continuing): ${(err as Error).message}`);
    }

    try {
      await runCycle(agentIds);
    } catch (err) {
      console.error(`[${key}] cycle failed: ${(err as Error).message}`);
      if (!stopping) await sleep(ERROR_BACKOFF_MS);
      continue;
    }
    if (stopping) break;
    await sleep(Math.max(INTERVAL_MS, throttleMs));
  }
  console.log(`[${key}] stopped.`);
}
