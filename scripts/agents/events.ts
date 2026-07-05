/**
 * MERIDIAN — event scanner (the "react to filings/news" backbone).
 *
 * The desk loop used to be pure round-robin: it walked its ~70-name universe on
 * a cursor, so a filing or headline that landed on a name near the back of the
 * rotation could wait an hour to be looked at, and most cycles were spent on
 * names with nothing new. This module turns the loop event-driven: each cycle it
 * cheaply detects which tickers just had a *genuinely new* disclosure and hands
 * the desk a priority queue, so fresh events jump the line while round-robin
 * still runs underneath to keep cold names covered.
 *
 * Two independent, already-supported signals feed one queue:
 *   1. NEWS   — rows the separate `agents:news` process writes to the `news`
 *               Appwrite collection. Pure Appwrite read; no extra external HTTP.
 *   2. FILING — a rolling slice of the universe probed against EDGAR (US) or NSE
 *               (IN) via the desk's `latestFilingKey`, meta only (no doc fetch).
 *
 * Watermarks live in a per-market state file (`.agents-events-<market>.json`):
 * a `newsSince` timestamp and a per-ticker `filingKeys` map. The FIRST time we
 * see a ticker or start a desk we seed the watermark SILENTLY — only a *change*
 * from a known baseline fires an event, so a fresh boot never stampedes the
 * whole universe into the queue.
 *
 * Correctness note: this is a *prioritization hint*, never a source of truth.
 * The parser still dedups every disclosure via findFiling(), so even a spurious
 * enqueue costs at most one cheap parser short-circuit — never a double analysis
 * or a double trade. That safety net is what lets this module stay best-effort:
 * every fetch is wrapped, and any failure degrades to round-robin.
 */
import fs from "node:fs";
import path from "node:path";
import { db, DB, Query, type Market } from "./appwrite";

export type EventKind = "filing" | "news";

export type EventHit = {
  ticker: string;
  kind: EventKind;
  /** Form type ("8-K"), announcement category, or "NEWS". */
  label: string;
  /** Short human detail for the log line (headline / form). */
  detail: string;
  /** ISO timestamp of the disclosure, for ordering. */
  at: string;
  /** True when the ticker is in the held book (ranks above universe names). */
  held: boolean;
};

/** Probe a ticker's newest disclosure. Returns null on any failure. */
export type LatestFilingKey = (
  ticker: string,
) => Promise<{ key: string; form: string; filedAt: string } | null>;

type EventState = {
  /** Only `news` rows created after this ISO instant fire. null → seed on first pass. */
  newsSince: string | null;
  /** ticker → last-seen disclosure key (accession / announcement datetime). */
  filingKeys: Record<string, string>;
  /** Rolling position into the scan pool, so each cycle probes a fresh slice. */
  scanCursor: number;
};

const stateFile = (market: Market) => path.resolve(`.agents-events-${market}.json`);

function loadState(market: Market): EventState {
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile(market), "utf8")) as Partial<EventState>;
    return {
      newsSince: raw.newsSince ?? null,
      filingKeys: raw.filingKeys ?? {},
      scanCursor: raw.scanCursor ?? 0,
    };
  } catch {
    return { newsSince: null, filingKeys: {}, scanCursor: 0 };
  }
}

function saveState(market: Market, state: EventState): void {
  try {
    fs.writeFileSync(stateFile(market), JSON.stringify(state));
  } catch (err) {
    console.warn(`[events] could not persist ${market} state: ${(err as Error).message}`);
  }
}

/**
 * News rows created since the watermark → hot tickers. Ordered by row-insertion
 * time ($createdAt), which is when the news agent *found* the item — a truer
 * "just arrived" signal than the article's own published_at. We over-fetch and
 * filter market in code so we don't depend on a custom index existing.
 */
async function collectNewsEvents(
  market: Market,
  state: EventState,
): Promise<EventHit[]> {
  // First pass on a fresh desk: baseline the watermark to now and fire nothing,
  // so we react to what lands NEXT rather than replaying the whole backlog.
  if (!state.newsSince) {
    state.newsSince = new Date().toISOString();
    return [];
  }
  try {
    const res = await db.listDocuments(DB, "news", [
      Query.greaterThan("$createdAt", state.newsSince),
      Query.orderDesc("$createdAt"),
      Query.limit(50),
    ]);
    const hits: EventHit[] = [];
    const seen = new Set<string>();
    let newest = state.newsSince;
    for (const d of res.documents) {
      const createdAt = String(d.$createdAt ?? "");
      if (createdAt > newest) newest = createdAt;
      if (String(d.market ?? "").toUpperCase() !== market) continue;
      const ticker = String(d.ticker ?? "").toUpperCase();
      if (!ticker || seen.has(ticker)) continue; // one hit per ticker per pass
      seen.add(ticker);
      hits.push({
        ticker,
        kind: "news",
        label: "NEWS",
        detail: String(d.title ?? "headline").slice(0, 100),
        at: String(d.published_at ?? d.$createdAt ?? new Date().toISOString()),
        held: false,
      });
    }
    state.newsSince = newest; // advance past everything we just saw
    return hits;
  } catch (err) {
    console.warn(`[events] news scan failed (continuing): ${(err as Error).message}`);
    return [];
  }
}

/**
 * Probe a rolling slice of the universe (held names first, then the static
 * universe) against the venue's latest-disclosure feed. A ticker whose key
 * differs from its stored watermark fired a new filing; a ticker we've never
 * seen is baselined silently. The slice rotates via scanCursor so a full sweep
 * completes over several cycles instead of hammering the venue every tick.
 */
async function collectFilingEvents(
  market: Market,
  pool: readonly string[],
  latestFilingKey: LatestFilingKey,
  batch: number,
  heldSet: ReadonlySet<string>,
  state: EventState,
): Promise<EventHit[]> {
  if (!pool.length) return [];
  const n = Math.min(batch, pool.length);
  const start = state.scanCursor % pool.length;
  const slice: string[] = [];
  for (let i = 0; i < n; i++) slice.push(pool[(start + i) % pool.length]);
  state.scanCursor = (start + n) % pool.length;

  const hits: EventHit[] = [];
  for (const ticker of slice) {
    const meta = await latestFilingKey(ticker); // best-effort; null on failure
    if (!meta) continue;
    const prev = state.filingKeys[ticker];
    state.filingKeys[ticker] = meta.key;
    if (prev === undefined) continue; // first sighting → baseline, don't fire
    if (prev === meta.key) continue; // unchanged
    hits.push({
      ticker,
      kind: "filing",
      label: meta.form,
      detail: `new ${meta.form} filed ${meta.filedAt}`,
      at: meta.filedAt,
      held: heldSet.has(ticker),
    });
  }
  return hits;
}

export type CollectEventsArgs = {
  market: Market;
  /** Held tickers (uppercased) — always scanned and ranked first. */
  held: readonly string[];
  /** Static desk universe for filing scanning. */
  universe: readonly string[];
  /** How many names to probe for new filings this cycle. */
  batch: number;
  /** Venue latest-disclosure probe, or undefined to skip filing scanning. */
  latestFilingKey?: LatestFilingKey;
};

/**
 * Detect this cycle's events across both signals and return them ranked
 * (held-book names first, then most-recent). Persists the advanced watermark.
 * Fully best-effort: on any internal failure it returns what it has (possibly
 * an empty list) so the desk falls back to round-robin.
 */
export async function collectEvents(args: CollectEventsArgs): Promise<EventHit[]> {
  const { market, held, universe, batch, latestFilingKey } = args;
  const state = loadState(market);
  const heldSet = new Set(held.map((t) => t.toUpperCase()));

  const news = await collectNewsEvents(market, state);

  let filings: EventHit[] = [];
  if (latestFilingKey) {
    // Held names first, then the rest of the universe — so what we own is always
    // in the scan rotation, not just the static roster.
    const pool = [...heldSet, ...universe.filter((t) => !heldSet.has(t.toUpperCase()))];
    filings = await collectFilingEvents(market, pool, latestFilingKey, batch, heldSet, state);
  }
  // Tag news hits with held-ness now that we know the book.
  for (const h of news) h.held = heldSet.has(h.ticker);

  saveState(market, state);

  const all = [...filings, ...news];
  // Held book first; within each tier, most recent disclosure first.
  all.sort((a, b) => Number(b.held) - Number(a.held) || b.at.localeCompare(a.at));
  return all;
}
