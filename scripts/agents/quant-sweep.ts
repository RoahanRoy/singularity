/**
 * MERIDIAN — daily quant sweep.
 *
 * Desk cycles only run the quant desk for a name with a fresh disclosure, so
 * most of the book and universe never got measured. This runs the full quant
 * stage (quant-nodes.ts) for every covered name — the held book plus the
 * sector universe (coverage.ts) — on today's data, independent of filings.
 *
 * Resumable: a name whose quant cycle finished within MAX_AGE is skipped, and
 * stale names go oldest-first, so repeated short runs (the cloud routine's
 * per-command limit) walk the whole list once a day. Each of the seven LLM
 * agents reuses its last report for a name while it is under a week old
 * (MERIDIAN_QUANT_LLM_MAX_AGE_H), so a daily sweep refreshes every number
 * without ~1,000 subscription calls a day.
 *
 * Run: npm run agents:quant
 *
 * Exit codes: 0 every name fresh · 4 subscription usage limit hit ·
 *             5 time budget used up with names still stale (run again)
 *
 * Env knobs:
 *   MERIDIAN_QUANT_SWEEP_MARKETS     "US,IN" (default) or one market
 *   MERIDIAN_QUANT_SWEEP_MAX_AGE_H   a name is fresh this long after its last cycle (default 24)
 *   MERIDIAN_QUANT_SWEEP_BUDGET_MS   stop starting names after this long (default: no limit)
 *   MERIDIAN_QUANT_SWEEP_LIMIT       at most this many names per run
 *   MERIDIAN_QUANT_LLM_MAX_AGE_H     LLM report reuse window (default here 168)
 */
import { db, DB, Query, recountClusters } from "./appwrite";
import { coverageTickers, type Market } from "./coverage";
import { bootstrapQuant, quantDesk, quantUsageLimitHit } from "./quant-nodes";
import { sectorOf, indiaSectorOf } from "./universe";
import type { Ctx } from "./nodes";

process.env.MERIDIAN_QUANT_LLM_MAX_AGE_H ||= "168";

const MARKETS = (process.env.MERIDIAN_QUANT_SWEEP_MARKETS || "US,IN")
  .split(",").map((m) => m.trim().toUpperCase()).filter((m): m is Market => m === "US" || m === "IN");
const MAX_AGE_MS = Number(process.env.MERIDIAN_QUANT_SWEEP_MAX_AGE_H || 24) * 3_600_000;
const BUDGET_MS = Number(process.env.MERIDIAN_QUANT_SWEEP_BUDGET_MS || 0);
const LIMIT = Number(process.env.MERIDIAN_QUANT_SWEEP_LIMIT || 0);

let stopping = false;
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    if (stopping) process.exit(130);
    stopping = true;
    console.log(`\n[sweep] ${sig}: finishing the current name, then stopping`);
  });
}

/**
 * When each name's last quant cycle ended (ensemble written, or the screen
 * stopped it), newest per ticker, over the last week.
 */
async function lastRuns(market: Market): Promise<Map<string, number>> {
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const out = new Map<string, number>();
  let cursor: string | undefined;
  while (true) {
    const q = [
      Query.equal("market", market), Query.equal("agent", ["ensemble-combiner", "fundamentals-screener"]),
      Query.greaterThan("run_at", since), Query.orderDesc("run_at"), Query.limit(500),
    ];
    if (cursor) q.push(Query.cursorAfter(cursor));
    const page = await db.listDocuments(DB, "quant_reports", q);
    for (const d of page.documents) {
      // A passing screen alone means the cycle may not have finished.
      if (d.agent === "fundamentals-screener" && !String(d.summary ?? "").startsWith("FAIL")) continue;
      const t = String(d.ticker).toUpperCase(), at = Date.parse(String(d.run_at));
      if (!(out.get(t)! >= at)) out.set(t, at);
    }
    if (page.documents.length < 500) break;
    cursor = page.documents[page.documents.length - 1].$id;
  }
  return out;
}

type Job = { market: Market; ticker: string; held: boolean; last: number };

async function plan(): Promise<{ jobs: Job[]; fresh: number }> {
  const jobs: Job[] = [];
  let fresh = 0;
  for (const market of MARKETS) {
    const [{ all, held }, runs] = await Promise.all([coverageTickers(market), lastRuns(market)]);
    for (const ticker of all) {
      const last = runs.get(ticker) ?? 0;
      if (Date.now() - last < MAX_AGE_MS) fresh++;
      else jobs.push({ market, ticker, held: held.has(ticker), last });
    }
  }
  // Never-run and oldest first; held names break ties.
  jobs.sort((a, b) => a.last - b.last || Number(b.held) - Number(a.held));
  return { jobs, fresh };
}

async function main(): Promise<number> {
  if (process.env.MERIDIAN_QUANT === "0") {
    console.error("[sweep] MERIDIAN_QUANT=0: the quant desk is off, nothing to do");
    return 0;
  }
  const t0 = Date.now();
  const { jobs, fresh } = await plan();
  console.log(`[sweep] ${MARKETS.join("+")}: ${jobs.length} stale · ${fresh} fresh (< ${MAX_AGE_MS / 3_600_000}h)`);
  if (!jobs.length) return 0;

  const ids: Partial<Record<Market, Record<string, string>>> = {};
  for (const m of new Set(jobs.map((j) => j.market))) ids[m] = await bootstrapQuant(m, m === "IN" ? "· IN" : "");
  await recountClusters();

  let done = 0, stopped = 0, failed = 0;
  const durations: number[] = [];
  for (const job of jobs) {
    if (stopping || (LIMIT && done + stopped + failed >= LIMIT)) break;
    const avg = durations.length ? durations.reduce((s, x) => s + x, 0) / durations.length : 0;
    if (BUDGET_MS && Date.now() - t0 + avg > BUDGET_MS) break;
    if (quantUsageLimitHit()) break;

    const s = Date.now();
    const sector = job.market === "IN" ? indiaSectorOf(job.ticker) : sectorOf(job.ticker);
    console.log(`\n=== quant sweep — ${job.market} ${job.ticker} (${sector})${job.held ? " · held" : ""} ===`);
    const ctx: Ctx = { ticker: job.ticker, market: job.market, sector, agentIds: ids[job.market] ?? {} };
    const out = await quantDesk(ctx);
    durations.push(Date.now() - s);
    if (out.quant?.halted) stopped++;
    else if (out.quant) done++;
    else failed++;
  }

  const left = jobs.length - done - stopped - failed;
  console.log(`\n[sweep] done=${done} screen-stopped=${stopped} failed=${failed} remaining=${left} in ${Math.round((Date.now() - t0) / 1000)}s`);
  if (quantUsageLimitHit()) {
    console.log("[sweep] subscription usage limit reached: stop for today");
    return 4;
  }
  return left > 0 ? 5 : 0;
}

main().then((code) => process.exit(code), (e) => {
  console.error(e);
  process.exit(1);
});
