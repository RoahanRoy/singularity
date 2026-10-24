/**
 * Shared book-enrichment engine for both desks (US and India).
 *
 * Framework-free (no `server-only`, no `next/*`, no `@/` alias) so it runs from
 * both the Vercel cron routes and the one-shot CLIs. Callers pass a node-appwrite
 * `Databases` instance + database id and a per-market EnrichConfig; the generic
 * machinery (Yahoo history, univariate betas, pnl fix) is identical across
 * markets.
 *
 * For each position in the config's market — on the advisory book
 * (`advisory_positions`) and the fund's own book (fund rows of `positions`) — it:
 *   1. pulls ~1y of daily closes for the holding + factor proxies,
 *   2. computes univariate betas (cov/var on daily returns) → factor_exposures_json,
 *   3. corrects the latest snapshot's pnl_daily to a real day-over-day delta.
 *
 * It never writes NAV snapshots: a mark is only what the book was worth when it
 * was taken. Replaying today's quantities over past closes would invent a
 * history the book never had. Writes are idempotent: betas update in place.
 */
import { type Databases, Query } from "node-appwrite";

/** The advisory book's snapshots: tagged, or from before the books were split. */
const ADVISORY_SNAPSHOT = Query.or([Query.equal("book", "advisory"), Query.isNull("book")]);

// ── config ──────────────────────────────────────────────────────────────────

export type FactorProxy = { key: string; symbol: string };

export type EnrichConfig = {
  market: "US" | "IN";
  factors: FactorProxy[];
  /** Map a bare desk ticker to its Yahoo symbol (e.g. `${t}.NS` for NSE). */
  yahooSymbol: (ticker: string) => string;
  /** Logged when the market has no positions yet. */
  emptyBookHint: string;
};

export type EnrichSummary = {
  holdings: number;
  betasWritten: number;
  pnlCorrected: boolean;
};

// ── Yahoo daily history ───────────────────────────────────────────────────────

type Bar = { date: string; close: number };

const YF = "https://query1.finance.yahoo.com/v8/finance/chart/";

/** Daily closes (oldest→newest), keyed by YYYY-MM-DD. Nulls dropped. */
async function fetchDaily(symbol: string, range = "1y"): Promise<Bar[]> {
  const url = `${YF}${encodeURIComponent(symbol)}?interval=1d&range=${range}`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`${symbol}: HTTP ${res.status}`);
  const json = await res.json();
  const r = json?.chart?.result?.[0];
  const ts: number[] = r?.timestamp ?? [];
  const closes: (number | null)[] = r?.indicators?.quote?.[0]?.close ?? [];
  const out: Bar[] = [];
  for (let i = 0; i < ts.length; i++) {
    const c = closes[i];
    if (typeof c === "number") out.push({ date: new Date(ts[i] * 1000).toISOString().slice(0, 10), close: c });
  }
  return out;
}

/** Resolve promises with bounded concurrency (gentle on Yahoo's free endpoint). */
async function mapPool<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

// ── stats ─────────────────────────────────────────────────────────────────────

function alignedReturns(a: Bar[], b: Bar[]): { ra: number[]; rb: number[] } {
  const mb = new Map(b.map((x) => [x.date, x.close]));
  const pairs = a.filter((x) => mb.has(x.date)).map((x) => [x.close, mb.get(x.date)!] as const);
  const ra: number[] = [], rb: number[] = [];
  for (let i = 1; i < pairs.length; i++) {
    ra.push(pairs[i][0] / pairs[i - 1][0] - 1);
    rb.push(pairs[i][1] / pairs[i - 1][1] - 1);
  }
  return { ra, rb };
}

function beta(stock: number[], factor: number[]): number {
  const n = Math.min(stock.length, factor.length);
  if (n < 20) return 0;
  let ms = 0, mf = 0;
  for (let i = 0; i < n; i++) { ms += stock[i]; mf += factor[i]; }
  ms /= n; mf /= n;
  let cov = 0, varf = 0;
  for (let i = 0; i < n; i++) {
    cov += (stock[i] - ms) * (factor[i] - mf);
    varf += (factor[i] - mf) ** 2;
  }
  return varf === 0 ? 0 : cov / varf;
}

// ── runner ────────────────────────────────────────────────────────────────────

type PosDoc = { $id: string; ticker: string; col: "advisory_positions" | "positions" };

export async function runEnrichment(
  databases: Databases,
  dbId: string,
  cfg: EnrichConfig,
  log: (msg: string) => void = () => {},
): Promise<EnrichSummary> {
  const summary: EnrichSummary = {
    holdings: 0, betasWritten: 0, pnlCorrected: false,
  };

  const [advRes, fundRes] = await Promise.all([
    databases.listDocuments(dbId, "advisory_positions", [Query.equal("market", cfg.market), Query.limit(200)]),
    databases.listDocuments(dbId, "positions", [
      Query.equal("market", cfg.market),
      // Fund rows only: legacy advisory rows left in `positions` carry one of these.
      Query.isNull("horizon_source"),
      Query.isNull("ibkr_account_id"),
      Query.isNull("kite_account_id"),
      Query.limit(200),
    ]),
  ]);
  const positions: PosDoc[] = [
    ...(advRes.documents as unknown as PosDoc[]).map((p) => ({ ...p, col: "advisory_positions" as const })),
    ...(fundRes.documents as unknown as PosDoc[]).map((p) => ({ ...p, col: "positions" as const })),
  ];
  summary.holdings = positions.length;

  if (positions.length === 0) {
    log(cfg.emptyBookHint);
    return summary;
  }
  log(`${cfg.market} holdings: ${positions.length}`);

  // 1) Factor proxy histories (once, in parallel).
  const factorBars = new Map<string, Bar[]>();
  await mapPool(cfg.factors, 5, async (f) => {
    try {
      factorBars.set(f.key, await fetchDaily(f.symbol));
    } catch (e) {
      log(`  ! factor ${f.key} (${f.symbol}) failed: ${(e as Error).message}`);
    }
  });

  // 2) Per-holding history + betas (bounded concurrency).
  await mapPool(positions, 6, async (p) => {
    const ySym = cfg.yahooSymbol(p.ticker);
    let bars: Bar[];
    try {
      bars = await fetchDaily(ySym);
    } catch (e) {
      log(`  ! ${p.ticker} (${ySym}) failed: ${(e as Error).message}`);
      return;
    }
    if (bars.length < 30) { log(`  ! ${p.ticker}: only ${bars.length} bars`); return; }

    const exposures = cfg.factors.flatMap((f) => {
      const fb = factorBars.get(f.key);
      if (!fb) return [];
      const { ra, rb } = alignedReturns(bars, fb);
      return [{ factor: f.key, beta: Number(beta(ra, rb).toFixed(3)) }];
    });
    await databases.updateDocument(dbId, p.col, p.$id, {
      factor_exposures_json: JSON.stringify(exposures),
    });
    summary.betasWritten++;
  });
  log(`betas written: ${summary.betasWritten}`);

  // 3) Correct the latest snapshot's pnl_daily to a real session delta.
  summary.pnlCorrected = await correctLatestPnl(databases, dbId, cfg, log);

  return summary;
}

/** If the latest snapshot still carries a lifetime P&L figure, fix it. */
async function correctLatestPnl(databases: Databases, dbId: string, cfg: EnrichConfig, log: (msg: string) => void): Promise<boolean> {
  const top = await databases.listDocuments(dbId, "fund_snapshots", [
    Query.equal("market", cfg.market), ADVISORY_SNAPSHOT, Query.orderDesc("captured_at"), Query.limit(2),
  ]);
  const [latest, prev] = top.documents as unknown as { $id: string; nav_usd: number; pnl_daily: number }[];
  if (!latest || !prev) return false;
  // A genuine daily move is small relative to NAV; a lifetime figure is not.
  if (Math.abs(latest.pnl_daily) <= Math.abs(latest.nav_usd) * 0.03) return false;
  const realDaily = Number((latest.nav_usd - prev.nav_usd).toFixed(2));
  await databases.updateDocument(dbId, "fund_snapshots", latest.$id, { pnl_daily: realDaily });
  log(`corrected latest pnl_daily: ${latest.pnl_daily} → ${realDaily}`);
  return true;
}
