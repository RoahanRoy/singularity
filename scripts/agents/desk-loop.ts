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
 * Behavior: runs continuously. Each cycle first scans for new filings (see
 * events.ts) on names the desk covers — held, or researched — and drains any
 * into a priority queue; the ticker for the cycle is the next queued update,
 * or, when the queue is empty,
 * the strongest unresearched idea from the daily quant sweep (ideas.ts), or,
 * when none is left, a round-robin pick over the held book (falling back to the
 * static universe).
 * That ticker runs through the agent chain, and every step is written to
 * Appwrite so the Swarm / Research / Portfolio screens tick live. A SIGTERM
 * (what the Console "stop" button sends) finishes the current cycle, then exits
 * cleanly; a second signal exits now.
 *
 * Env knobs (PREFIX is MERIDIAN_TECH or MERIDIAN_INDIA per desk):
 *   <PREFIX>_ONCE=1            run a single cycle and exit (for testing)
 *   <PREFIX>_INTERVAL_MS       pause between cycles (default 60000)
 *   <PREFIX>_ERROR_BACKOFF_MS  pause after a failed cycle (default 15000)
 *   <PREFIX>_EVENT_SCAN=0      don't scan for filings on covered names
 *   <PREFIX>_EVENT_BATCH       names probed for new filings per cycle (default 10)
 *   <PREFIX>_IDEAS=0           don't research ideas from the quant sweep
 *   MERIDIAN_SYNC_BASE         base URL of the running app for the sync route
 *                              (default http://localhost:3000)
 *   CRON_SECRET                bearer for that sync route (must match the app's)
 *   MERIDIAN_STATE_STORE=appwrite  keep cursors/watermarks in Appwrite instead
 *                              of dotfiles (for throwaway checkouts, e.g. cloud)
 */
import type { Sector } from "./universe";
import { emit, quotaCheck, flushQuota } from "./appwrite";
import {
  parser, analyst, quant, critic, valuation, cio,
  pm, treasury, risk, riskOverlay, compliance, smartRouter, broker, tca, attribution,
  budgetController, sweepApprovedMemos,
  type Ctx,
} from "./nodes";
import { quantDesk } from "./quant-nodes";
import { heldTickers as heldOnBooks } from "./coverage";
import { markFundNav } from "./fund-nav";
import { reportRisk } from "./portfolio-risk";
import { marketState } from "./market-hours";
import { collectEvents, type EventHit, type LatestFilingKey } from "./events";
import { hasMemo, nextIdea } from "./ideas";

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
  /** Boots this desk's agent roster and returns the id map. */
  bootstrap: () => Promise<Record<string, string>>;
  /** Round-robins the desk universe, skipping/rotating past held names. */
  nextTicker: (held: readonly string[]) => Promise<string>;
  /** Resolves a ticker's sector for this desk. */
  sectorOf: (ticker: string) => Sector;
  /** Static universe: scanned for new filings, and where ideas come from. */
  universe?: readonly string[];
  /** Cheap latest-disclosure probe for the event scanner (EDGAR / NSE meta). */
  latestFilingKey?: LatestFilingKey;
  /** Default names probed per cycle for new filings (env can override). */
  eventScanBatch?: number;
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
  const SYNC_BASE = (process.env.MERIDIAN_SYNC_BASE || "http://localhost:3000").replace(/\/$/, "");
  // Filing updates: react to new filings on covered names instead of blindly
  // round-robining. Off when the desk has no universe wired, or when the
  // operator disables it. Ideas and round-robin run underneath as the
  // fallback, so a scan outage never stalls the loop.
  const EVENT_SCAN = process.env[`${envPrefix}_EVENT_SCAN`] !== "0" && !!config.universe;
  const EVENT_BATCH = Number(process.env[`${envPrefix}_EVENT_BATCH`] || config.eventScanBatch || 10);
  // Ideas: the sweep's strongest unheld longs, each researched once (ideas.ts).
  const IDEAS = process.env[`${envPrefix}_IDEAS`] !== "0" && !!config.universe;

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
      // The sync route is operator-gated; the loop authenticates with the
      // app's CRON_SECRET (same value as the deployment's env).
      const secret = process.env.CRON_SECRET;
      const res = await fetch(`${SYNC_BASE}${config.syncPath}`, {
        method: "POST",
        headers: secret ? { Authorization: `Bearer ${secret}` } : undefined,
      });
      if (!res.ok) console.warn(`[${key}] sync route ${res.status} (continuing)`);
    } catch (err) {
      console.warn(`[${key}] holdings sync skipped (${(err as Error).message})`);
    }
  }

  // The fund's NAV mark for the session (fund-nav.ts). Every cycle would be a
  // quote per name and a write; one mark per FUND_NAV_EVERY_MS is enough to end
  // the session near its close.
  const FUND_NAV_EVERY_MS = 15 * 60_000;
  let lastNavMark = 0;
  async function markNav(): Promise<void> {
    if (Date.now() - lastNavMark < FUND_NAV_EVERY_MS) return;
    lastNavMark = Date.now();
    try {
      const m = await markFundNav(market);
      if (m.status === "marked") console.log(`[${key}] fund NAV ${m.session}: ${m.nav} (day ${m.day_pnl >= 0 ? "+" : ""}${m.day_pnl}, book ${m.book_index})`);
    } catch (err) {
      console.warn(`[${key}] fund NAV mark failed (continuing): ${(err as Error).message}`);
    }
  }

  // The portfolio risk report for both books (portfolio-risk.ts). It runs on
  // daily history, so an hourly refresh only picks up new fills and marks.
  const RISK_EVERY_MS = 60 * 60_000;
  let lastRiskReport = 0;
  async function measureRisk(): Promise<void> {
    if (Date.now() - lastRiskReport < RISK_EVERY_MS) return;
    lastRiskReport = Date.now();
    for (const book of ["fund", "advisory"] as const) {
      try {
        const r = await reportRisk(market, book);
        if (r.status === "reported") console.log(`[${key}] ${book} risk ${r.session}: VaR95 ${(r.report.var95.parametric * 100).toFixed(2)}%, beta ${r.report.beta.toFixed(2)}, TE ${(r.report.tracking_error * 100).toFixed(1)}%`);
        else console.log(`[${key}] ${book} risk skipped (${r.reason})`);
      } catch (err) {
        console.warn(`[${key}] ${book} risk report failed (continuing): ${(err as Error).message}`);
      }
    }
  }

  /** Current held tickers for this desk's market, on the fund and advisory books. */
  async function heldTickers(): Promise<string[]> {
    try {
      return await heldOnBooks(market);
    } catch (err) {
      console.warn(`[${key}] could not read held book (${(err as Error).message})`);
      return [];
    }
  }

  // Event queue drained before round-robin. `queued` dedups within a session so
  // a still-pending event isn't re-enqueued on the next scan; across a restart
  // the watermark persists, so old events don't re-fire (and if one slips
  // through, the parser's findFiling dedup absorbs it harmlessly).
  const eventQueue: EventHit[] = [];
  const queued = new Set<string>();

  /** Refill the event queue from this cycle's scan. Best-effort. */
  async function scanEvents(held: readonly string[]): Promise<void> {
    if (!EVENT_SCAN) return;
    try {
      const hits = await collectEvents({
        market,
        held,
        universe: config.universe ?? [],
        batch: EVENT_BATCH,
        latestFilingKey: config.latestFilingKey,
      });
      let added = 0;
      for (const h of hits) {
        if (queued.has(h.ticker)) continue;
        // A filing updates a view the desk holds; an uncovered name waits for
        // the sweep to rank it as an idea.
        if (!h.held && !(await hasMemo(h.ticker))) {
          console.log(`[${key}] ${h.ticker}: ${h.detail}, not covered — left to the idea ranking`);
          continue;
        }
        queued.add(h.ticker);
        eventQueue.push(h);
        added++;
        console.log(`[${key}] event → ${h.ticker} (${h.kind}: ${h.detail})`);
      }
      if (added > 0) console.log(`[${key}] queued ${added} event(s); ${eventQueue.length} pending`);
    } catch (err) {
      console.warn(`[${key}] event scan failed (round-robin this cycle): ${(err as Error).message}`);
    }
  }

  type AgentIds = Awaited<ReturnType<typeof config.bootstrap>>;

  async function runCycle(agentIds: AgentIds): Promise<void> {
    await refreshHoldings();
    // Execute any trades the operator approved since the last cycle (no LLM —
    // uses the sizing persisted when the broker held the fill).
    const executed = await sweepApprovedMemos(market, agentIds);
    if (executed > 0) console.log(`[${key}] executed ${executed} operator-approved trade(s)`);
    await markNav();
    await measureRisk();
    const held = await heldTickers();

    // Update covered names on new filings first, then research the next idea;
    // fall back to round-robin to keep cold names covered and the loop warm.
    await scanEvents(held);
    const evt = eventQueue.shift();
    let ticker: string;
    let via: string;
    let research = false;
    if (evt) {
      queued.delete(evt.ticker);
      ticker = evt.ticker;
      via = `update · ${evt.kind} (${evt.label})`;
      // Surface the trigger on the live feed (best-effort) so the Swarm/Research
      // screens show WHY this name jumped the queue, not just that it ran.
      try {
        await emit(
          agentIds.parser,
          "thought",
          `Updating ${ticker} on a ${evt.kind} — ${evt.detail}`,
          { via: "update", kind: evt.kind, label: evt.label, ticker, held: evt.held },
        );
      } catch {
        /* feed emit is non-fatal — the cycle proceeds regardless */
      }
    } else {
      let pick: Awaited<ReturnType<typeof nextIdea>> = null;
      if (IDEAS) {
        try {
          pick = await nextIdea(market, config.universe ?? [], held);
        } catch (err) {
          console.warn(`[${key}] idea queue failed (falling back to round-robin): ${(err as Error).message}`);
        }
      }
      if (pick) {
        const { idea } = pick;
        ticker = idea.ticker;
        research = true;
        const why = `composite +${Math.round(idea.composite)} × confidence ${idea.confidence.toFixed(2)}, valuation upside +${idea.upsidePct.toFixed(1)}%`;
        via = `idea #${pick.rank} of ${pick.of} (${why}; ${pick.covered} above it already covered)`;
        try {
          await emit(agentIds.parser, "thought", `Researching idea ${ticker}: #${pick.rank} of ${pick.of} sweep longs, ${why}`, {
            via: "idea", ticker, rank: pick.rank, of: pick.of, composite: idea.composite, confidence: idea.confidence, upside_pct: idea.upsidePct,
          });
        } catch {
          /* feed emit is non-fatal */
        }
      } else {
        ticker = await config.nextTicker(held);
        via = "round-robin";
      }
    }
    const sector = config.sectorOf(ticker);
    console.log(`\n=== ${config.label} — ${ticker} (${sector}) · ${via} · book=${held.length} names ===\n`);

    let ctx: Ctx = { ticker, agentIds, market, research };
    ctx = await parser(ctx);
    if (!ctx.needsAnalysis) {
      console.log(`\n=== ${ticker}: no new disclosure — reused prior summary, skipping analysis ===`);
      return;
    }
    // Quant desk: one agent per method measures the name before the analyst
    // writes. A failed screen (red flags on most of the data) ends the cycle.
    ctx = await quantDesk(ctx);
    if (ctx.quant?.halted) {
      console.log(`\n=== ${ticker}: ${ctx.quant.halted} — skipping analysis ===`);
      return;
    }
    ctx = await analyst(ctx);
    if (!ctx.memo) {
      console.log(`\n=== ${ticker}: no readable memo — skipping analysis ===`);
      return;
    }
    ctx = await quant(ctx);
    ctx = await critic(ctx);
    ctx = await valuation(ctx);
    if (ctx.staged) {
      console.log(`\n=== ${ticker}: staged for review — ${ctx.staged} ===`);
      return;
    }
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

  // Appwrite Free plan guard (quota.ts): a single run skips, a loop waits.
  const QUOTA_POLL_MS = 30 * 60_000;
  if (RUN_ONCE) {
    const quota = await quotaCheck();
    if (!quota.ok) {
      console.log(`[quota] Appwrite usage limit reached (${quota.reason}): skipping this cycle`);
      return;
    }
  }

  const agentIds = await config.bootstrap();

  if (RUN_ONCE) {
    await runCycle(agentIds);
    await flushQuota();
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

    const quota = await quotaCheck();
    if (!quota.ok) {
      console.log(`[quota] Appwrite usage limit reached (${quota.reason}): re-checking in ${QUOTA_POLL_MS / 60_000}m`);
      await sleep(QUOTA_POLL_MS);
      continue;
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
