import "server-only";
import { ID, Query } from "node-appwrite";
import { createAdminClient, DATABASE_ID } from "@/lib/appwrite/server";
import { COLLECTIONS, type Market, type Position } from "@/lib/appwrite/schema";
import { fetchHoldings, HorizonAuthError } from "./client";
import { foldHoldings } from "./book";
import { holdingsReturn, nextBookIndex, type PulledHolding } from "@/lib/fund/scorecard";
import { indexLevel } from "@/lib/market/indices";

export type HorizonSyncResult = {
  /** "fresh": the book was pulled within `maxAgeMs`, so nothing was re-pulled. */
  status: "synced" | "fresh" | "unauthorized" | "error";
  /** Rows written per desk. */
  holdings: Record<Market, number>;
  /** Direct IBKR rows removed because Horizon now carries those holdings. */
  superseded: number;
  /** Holdings that could not be placed on the book, and why. */
  skipped: { ticker: string; reason: string }[];
  generatedAt: string | null;
  error?: string;
};

const MARKETS: Market[] = ["IN", "US"];

/** How stale the book may be before a desk loop's per-cycle refresh re-pulls it. */
export const HORIZON_LOOP_MAX_AGE_MS = 15 * 60_000;

/**
 * Pull the operator's real book from Horizon onto Meridian's advisory book
 * (`advisory_positions`) — holdings the desk advises on but never trades; the
 * fund's own book is the paper positions (scripts/agents/fund-book.ts):
 *   - rupee holdings (Kite, Coin, Groww) become the India book (market="IN",
 *     in INR); everything held abroad (IBKR, Trading 212, Revolut) becomes the
 *     US book (market="US", converted to USD at Horizon's own rate),
 *   - the same instrument held by several members or brokers is one row,
 *   - every prior advisory row is replaced — Horizon's from the last pull and
 *     any direct IBKR rows, which Horizon supersedes (keeping both would count
 *     the same shares twice). Factor exposures carry forward,
 *   - `positions` (the fund book) is never touched,
 *   - one fund_snapshots row per desk that holds anything, carrying the
 *     flow-free book level and the index level beside the NAV (scorecard.ts).
 *
 * Nothing is written until Horizon has answered, so a failed pull leaves the
 * current book exactly as it was.
 */
export async function syncHorizon(opts: { maxAgeMs?: number } = {}): Promise<HorizonSyncResult> {
  // Both desk loops reach this every cycle through the delegating sync routes.
  // One pull at a time per server: concurrent replaces would race on the
  // unique market+ticker index.
  if (inflight) return inflight;
  inflight = (async () => {
    // Horizon's book moves when its own broker syncs do — hours, not seconds —
    // so a loop's per-cycle refresh only re-pulls once the last pull is stale.
    if (opts.maxAgeMs) {
      const status = await horizonBookStatus();
      if (status.lastSyncedAt && Date.now() - Date.parse(status.lastSyncedAt) < opts.maxAgeMs) {
        return { ...emptyResult(), status: "fresh" as const, holdings: status.holdings };
      }
    }
    return pull();
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

let inflight: Promise<HorizonSyncResult> | null = null;

function emptyResult(): HorizonSyncResult {
  return {
    status: "synced",
    holdings: { IN: 0, US: 0 },
    superseded: 0,
    skipped: [],
    generatedAt: null,
  };
}

async function pull(): Promise<HorizonSyncResult> {
  const result = emptyResult();

  let data;
  try {
    data = await fetchHoldings();
  } catch (err) {
    result.status = err instanceof HorizonAuthError ? "unauthorized" : "error";
    result.error = (err as Error).message;
    return result;
  }
  result.generatedAt = data.generatedAt || null;
  // Horizon's data-quality notes name family members and accounts; they go to
  // the server log, not into a response the sync routes hand back.
  for (const w of data.warnings) console.warn(`[horizon] ${w}`);

  // An empty answer is far likelier a Horizon-side fault than a sold-out book;
  // don't let it wipe the real holdings.
  if (data.holdings.length === 0) {
    result.status = "error";
    result.error = "Horizon returned no holdings — left the current book in place";
    return result;
  }

  const { rows, skipped } = foldHoldings(data);
  result.skipped.push(...skipped);

  // ── Replace the advisory rows ────────────────────────────────────────────
  const { databases } = createAdminClient();
  const existing = await databases.listDocuments(DATABASE_ID, COLLECTIONS.advisory_positions, [Query.limit(1000)]);
  const real = existing.documents as unknown as Position[];

  const hadHorizon = new Set(real.filter((p) => p.horizon_source).map((p) => p.market ?? "US"));
  const priorFactors = new Map<string, string>();
  for (const p of real) if (p.factor_exposures_json) priorFactors.set(`${p.market}:${p.ticker}`, p.factor_exposures_json);
  result.superseded = real.filter((p) => !p.horizon_source).length;

  await Promise.all(
    real.map((d) => databases.deleteDocument(DATABASE_ID, COLLECTIONS.advisory_positions, d.$id).catch(() => {})),
  );

  const total: Record<Market, number> = { IN: 0, US: 0 };
  for (const r of rows) total[r.market] += r.mv;

  const written: Record<Market, number> = { IN: 0, US: 0 };
  const pulled: Record<Market, PulledHolding[]> = { IN: [], US: [] };
  await Promise.all(
    rows.map(async (r) => {
      try {
        await databases.createDocument(DATABASE_ID, COLLECTIONS.advisory_positions, ID.unique(), {
          ticker: r.ticker,
          qty: r.qty,
          avg_cost: Number((r.qty > 0 ? r.cost / r.qty : 0).toFixed(4)),
          market_value: Number(r.mv.toFixed(2)),
          unrealized_pnl: Number(r.pnl.toFixed(2)),
          weight: Number((total[r.market] > 0 ? r.mv / total[r.market] : 0).toFixed(6)),
          factor_exposures_json: priorFactors.get(`${r.market}:${r.ticker}`) ?? null,
          market: r.market,
          horizon_source: [...r.brokers].join(" · ").slice(0, 64) || "Horizon",
          label: r.label ? r.label.slice(0, 128) : null,
        });
        result.holdings[r.market]++;
        written[r.market] += r.mv;
        pulled[r.market].push({ ticker: r.ticker, qty: r.qty, marketValue: r.mv });
      } catch (err) {
        result.skipped.push({ ticker: r.ticker, reason: (err as Error).message });
      }
    }),
  );

  // ── One NAV point per desk that holds anything ───────────────────────────
  const levels = Object.fromEntries(
    await Promise.all(MARKETS.map(async (m) => [m, result.holdings[m] ? await indexLevel(m) : null] as const)),
  ) as Record<Market, number | null>;
  for (const market of MARKETS) {
    if (result.holdings[market] === 0) continue;
    const nav = written[market];

    const lastSnap = await databases.listDocuments(DATABASE_ID, COLLECTIONS.fund_snapshots, [
      Query.equal("market", market),
      Query.orderDesc("captured_at"),
      Query.limit(1),
    ]);
    const prevNav = (lastSnap.documents[0] as { nav_usd?: number } | undefined)?.nav_usd;
    // The first pull from Horizon replaces whatever book was there before —
    // a change of source, not a session's P&L — so it books no day move.
    const dayPnl = hadHorizon.has(market) && typeof prevNav === "number" ? nav - prevNav : 0;
    const point = {
      nav_usd: Number(nav.toFixed(2)),
      pnl_daily: Number(dayPnl.toFixed(2)),
      captured_at: new Date().toISOString(),
      market,
    };
    const track = await scorecardPoint(databases, market, hadHorizon.has(market), real, pulled[market], levels[market]);
    await databases
      .createDocument(DATABASE_ID, COLLECTIONS.fund_snapshots, ID.unique(), { ...point, ...track })
      // Before the scorecard columns are migrated in, the NAV point still lands.
      .catch(() => (track ? databases.createDocument(DATABASE_ID, COLLECTIONS.fund_snapshots, ID.unique(), point) : null))
      .catch(() => {});
  }

  return result;
}

/**
 * The scorecard levels for this pull: the book level chained from the last
 * recorded one by the return of the holdings Horizon reported last time, and
 * the index level. A desk's first Horizon pull starts the book at the base.
 * The book level is written even when Yahoo doesn't answer, so the chain never
 * skips a pull's return; that day just has no index point to compare against.
 */
async function scorecardPoint(
  databases: ReturnType<typeof createAdminClient>["databases"],
  market: Market,
  continuing: boolean,
  prior: Position[],
  now: PulledHolding[],
  level: number | null,
): Promise<{ book_index: number; index_level: number | null } | null> {
  let prevIndex: number | null = null;
  if (continuing) {
    try {
      const last = await databases.listDocuments(DATABASE_ID, COLLECTIONS.fund_snapshots, [
        Query.equal("market", market),
        Query.isNotNull("book_index"),
        Query.orderDesc("captured_at"),
        Query.limit(1),
      ]);
      prevIndex = (last.documents[0] as { book_index?: number | null } | undefined)?.book_index ?? null;
    } catch {
      return null; // the column isn't there yet
    }
  }
  const before = prior
    .filter((p) => p.horizon_source && (p.market ?? "US") === market)
    .map((p) => ({ ticker: p.ticker, qty: Number(p.qty), marketValue: Number(p.market_value) }));
  const r = prevIndex == null ? null : holdingsReturn(before, now);
  return { book_index: Number(nextBookIndex(prevIndex, r).toFixed(6)), index_level: level == null ? null : Number(level.toFixed(4)) };
}

/** Advisory rows Horizon currently has on each desk, and when they landed. */
export async function horizonBookStatus(): Promise<{
  holdings: Record<Market, number>;
  lastSyncedAt: string | null;
}> {
  const { databases } = createAdminClient();
  const count = async (market: Market) =>
    (
      await databases.listDocuments(DATABASE_ID, COLLECTIONS.advisory_positions, [
        Query.isNotNull("horizon_source"),
        Query.equal("market", market),
        Query.limit(1),
      ])
    ).total;
  const [inCount, usCount, latest] = await Promise.all([
    count("IN"),
    count("US"),
    // Every sync recreates its rows, so the newest row's creation is the sync.
    databases.listDocuments(DATABASE_ID, COLLECTIONS.advisory_positions, [
      Query.isNotNull("horizon_source"),
      Query.orderDesc("$createdAt"),
      Query.limit(1),
    ]),
  ]);
  return {
    holdings: { IN: inCount, US: usCount },
    lastSyncedAt: latest.documents[0]?.$createdAt ?? null,
  };
}
