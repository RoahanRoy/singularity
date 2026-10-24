/**
 * MERIDIAN — event scanner: the filings that update a covered name.
 *
 * Each cycle probes a rolling slice of the desk's names (held first, then the
 * universe) against EDGAR (US) or NSE (IN) via the desk's `latestFilingKey`,
 * meta only, and returns the names whose newest disclosure changed. The desk
 * acts on a hit only for a name it covers — held on a book, or researched
 * (ideas.ts) — so a filing updates the view the desk already holds. Material
 * events reach the venue as filings (US 8-K, Indian LODR announcements);
 * headlines reach the desk through the daily quant sweep, whose news agent
 * reads them for every name and votes in the verdict the ideas rank by.
 *
 * Watermarks live in a per-market state slot (`.agents-events-<market>.json`,
 * or Appwrite `agent_state` — see state-store.ts): a per-ticker `filingKeys`
 * map. The FIRST time we see a ticker we seed its watermark SILENTLY — only a
 * *change* from a known baseline fires, so a fresh boot never stampedes the
 * whole universe into the queue.
 *
 * Correctness note: this is a *prioritization hint*, never a source of truth.
 * The parser still dedups every disclosure via findFiling(), so even a spurious
 * enqueue costs at most one cheap parser short-circuit — never a double analysis
 * or a double trade. That safety net is what lets this module stay best-effort:
 * every fetch is wrapped, and any failure degrades to the next pick.
 */
import type { Market } from "./appwrite";
import { readState, writeState } from "./state-store";

export type EventKind = "filing";

export type EventHit = {
  ticker: string;
  kind: EventKind;
  /** Form type ("8-K") or announcement category. */
  label: string;
  /** Short human detail for the log line. */
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
  /** ticker → last-seen disclosure key (accession / announcement datetime). */
  filingKeys: Record<string, string>;
  /** Rolling position into the scan pool, so each cycle probes a fresh slice. */
  scanCursor: number;
};

const stateFile = (market: Market) => `.agents-events-${market}.json`;

async function loadState(market: Market): Promise<EventState> {
  const raw = (await readState<Partial<EventState>>(stateFile(market))) ?? {};
  return {
    filingKeys: raw.filingKeys ?? {},
    scanCursor: raw.scanCursor ?? 0,
  };
}

async function saveState(market: Market, state: EventState): Promise<void> {
  try {
    await writeState(stateFile(market), state);
  } catch (err) {
    console.warn(`[events] could not persist ${market} state: ${(err as Error).message}`);
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
 * Detect this cycle's new filings and return them ranked (held-book names
 * first, then most recent). Persists the advanced watermark. Fully
 * best-effort: on any internal failure it returns what it has (possibly an
 * empty list).
 */
export async function collectEvents(args: CollectEventsArgs): Promise<EventHit[]> {
  const { market, held, universe, batch, latestFilingKey } = args;
  if (!latestFilingKey) return [];
  const state = await loadState(market);
  const heldSet = new Set(held.map((t) => t.toUpperCase()));
  // Held names first, then the rest of the universe — so what we own is always
  // in the scan rotation, not just the static roster.
  const pool = [...heldSet, ...universe.filter((t) => !heldSet.has(t.toUpperCase()))];
  const hits = await collectFilingEvents(market, pool, latestFilingKey, batch, heldSet, state);
  await saveState(market, state);
  return hits.sort((a, b) => Number(b.held) - Number(a.held) || b.at.localeCompare(a.at));
}
