/**
 * India (Kite) book enrichment from free Yahoo Finance history.
 *
 * Pure of any framework imports (no `server-only`, no `next/*`, no `@/` alias)
 * so the same implementation runs from both:
 *   - the weekly Vercel cron route (`/api/cron/enrich-india`), and
 *   - the one-shot CLI (`scripts/enrich-india.ts`).
 *
 * Both pass a node-appwrite `Databases` instance + database id. The work is
 * strictly additive: positions are updated in place, snapshots are only
 * appended for dates not already present, scenarios are seeded only when none
 * exist for the India desk.
 *
 * For each market="IN" position it:
 *   1. pulls ~1y of daily closes for the holding (<TICKER>.NS) and factor proxies,
 *   2. computes univariate betas (cov/var on daily returns) → factor_exposures_json,
 *   3. reconstructs the book's NAV series over the window where ALL holdings have
 *      history (qty held constant) and appends the missing daily snapshots,
 *   4. corrects the latest snapshot's pnl_daily to a real day-over-day delta,
 *   5. seeds India-relevant stress scenarios if none exist.
 */
import { type Databases, Query, ID } from "node-appwrite";

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

function closeAtOrBefore(bars: Bar[], date: string): number | null {
  let chosen: number | null = null;
  for (const b of bars) {
    if (b.date <= date) chosen = b.close;
    else break;
  }
  return chosen;
}

// ── factor proxies ────────────────────────────────────────────────────────────

const FACTORS: { key: string; symbol: string }[] = [
  { key: "NIFTY_MKT", symbol: "^NSEI" },
  { key: "IN_BANKS", symbol: "^NSEBANK" },
  { key: "IN_IT", symbol: "^CNXIT" },
  { key: "FX_USDINR", symbol: "INR=X" },
  { key: "GOLD", symbol: "GC=F" },
];

// ── India stress scenarios (seeded only if none exist for market="IN") ────────

const INDIA_SCENARIOS = [
  {
    name: "RBI +50bp surprise",
    description: "Unscheduled 50bp repo-rate hike; rate-sensitives and NBFCs re-rate lower.",
    nav_delta: -0.031,
    worst_position: "BAJFINANCE",
    branches: [
      { label: "priced in", prob: 0.55, delta: -0.012, hedged_delta: -0.004 },
      { label: "risk-off bleed", prob: 0.33, delta: -0.041, hedged_delta: -0.016 },
      { label: "credit shock", prob: 0.12, delta: -0.078, hedged_delta: -0.031 },
    ],
  },
  {
    name: "INR -3% vs USD",
    description: "Rupee depreciation on oil + outflows; IT exporters cushion, importers hit.",
    nav_delta: -0.018,
    worst_position: "RELIANCE",
    branches: [
      { label: "orderly", prob: 0.6, delta: -0.009, hedged_delta: -0.002 },
      { label: "outflow spiral", prob: 0.4, delta: -0.034, hedged_delta: -0.013 },
    ],
  },
  {
    name: "Global risk-off (VIX>30)",
    description: "US-led drawdown; high-beta EM equities and recent IPOs lead the fall.",
    nav_delta: -0.057,
    worst_position: "PAYTM",
    branches: [
      { label: "shallow", prob: 0.5, delta: -0.028, hedged_delta: -0.011 },
      { label: "EM contagion", prob: 0.37, delta: -0.066, hedged_delta: -0.027 },
      { label: "liquidity crunch", prob: 0.13, delta: -0.114, hedged_delta: -0.049 },
    ],
  },
  {
    name: "Crude +15% spike",
    description: "Brent shock widens the import bill; OMCs and consumer margins compress.",
    nav_delta: -0.022,
    worst_position: "ASIANPAINT",
    branches: [
      { label: "transient", prob: 0.62, delta: -0.011, hedged_delta: -0.004 },
      { label: "sustained", prob: 0.38, delta: -0.039, hedged_delta: -0.018 },
    ],
  },
];

// ── runner ────────────────────────────────────────────────────────────────────

type PosDoc = { $id: string; ticker: string; qty: number };

export type EnrichSummary = {
  holdings: number;
  betasWritten: number;
  snapshotsAdded: number;
  sessions: number;
  windowStart: string | null;
  scenariosSeeded: number;
  pnlCorrected: boolean;
};

/**
 * Run the full India enrichment against the given Appwrite database.
 * `log` defaults to a no-op so the cron route stays quiet; the CLI passes
 * console.log for a progress trace.
 */
export async function runIndiaEnrichment(
  databases: Databases,
  dbId: string,
  log: (msg: string) => void = () => {},
): Promise<EnrichSummary> {
  const summary: EnrichSummary = {
    holdings: 0, betasWritten: 0, snapshotsAdded: 0, sessions: 0,
    windowStart: null, scenariosSeeded: 0, pnlCorrected: false,
  };

  const posRes = await databases.listDocuments(dbId, "positions", [Query.equal("market", "IN"), Query.limit(200)]);
  const positions = posRes.documents as unknown as PosDoc[];
  summary.holdings = positions.length;

  if (positions.length === 0) {
    log("No market=IN positions — connect a Kite account and sync first.");
    summary.scenariosSeeded = await seedScenariosIfEmpty(databases, dbId, log);
    return summary;
  }
  log(`India holdings: ${positions.length}`);

  // 1) Factor proxy histories (once, in parallel).
  const factorBars = new Map<string, Bar[]>();
  await mapPool(FACTORS, 5, async (f) => {
    try {
      factorBars.set(f.key, await fetchDaily(f.symbol));
    } catch (e) {
      log(`  ! factor ${f.key} (${f.symbol}) failed: ${(e as Error).message}`);
    }
  });

  // 2) Per-holding history + betas (bounded concurrency).
  const holdingBars = new Map<string, Bar[]>();
  await mapPool(positions, 6, async (p) => {
    const ySym = `${p.ticker}.NS`;
    let bars: Bar[];
    try {
      bars = await fetchDaily(ySym);
    } catch (e) {
      log(`  ! ${p.ticker} (${ySym}) failed: ${(e as Error).message}`);
      return;
    }
    if (bars.length < 30) { log(`  ! ${p.ticker}: only ${bars.length} bars`); return; }
    holdingBars.set(p.ticker, bars);

    const exposures = FACTORS.flatMap((f) => {
      const fb = factorBars.get(f.key);
      if (!fb) return [];
      const { ra, rb } = alignedReturns(bars, fb);
      return [{ factor: f.key, beta: Number(beta(ra, rb).toFixed(3)) }];
    });
    await databases.updateDocument(dbId, "positions", p.$id, {
      factor_exposures_json: JSON.stringify(exposures),
    });
    summary.betasWritten++;
  });
  log(`betas written: ${summary.betasWritten}`);

  // 3) Reconstruct + append NAV snapshots.
  await reconstructSnapshots(databases, dbId, positions, holdingBars, summary, log);

  // 4) Correct the latest snapshot's pnl_daily to a real session delta.
  summary.pnlCorrected = await correctLatestPnl(databases, dbId, log);

  // 5) India stress scenarios.
  summary.scenariosSeeded = await seedScenariosIfEmpty(databases, dbId, log);

  return summary;
}

async function reconstructSnapshots(
  databases: Databases,
  dbId: string,
  positions: PosDoc[],
  holdingBars: Map<string, Bar[]>,
  summary: EnrichSummary,
  log: (msg: string) => void,
) {
  const held = positions.filter((p) => holdingBars.has(p.ticker));
  if (held.length === 0) { log("No holding history — skipping reconstruction."); return; }

  // Window start = the latest "first date" across holdings (so all names exist).
  let windowStart = "0000-00-00";
  for (const p of held) {
    const first = holdingBars.get(p.ticker)![0].date;
    if (first > windowStart) windowStart = first;
  }
  const calendar = holdingBars.get(held[0].ticker)!.map((b) => b.date).filter((d) => d >= windowStart);

  const series: { date: string; nav: number }[] = [];
  for (const date of calendar) {
    let nav = 0, complete = true;
    for (const p of held) {
      const c = closeAtOrBefore(holdingBars.get(p.ticker)!, date);
      if (c == null) { complete = false; break; }
      nav += p.qty * c;
    }
    if (complete) series.push({ date, nav });
  }
  if (series.length < 2) { log("Reconstructed series too short."); return; }

  summary.sessions = series.length;
  summary.windowStart = series[0].date;

  const existing = await databases.listDocuments(dbId, "fund_snapshots", [Query.equal("market", "IN"), Query.limit(500)]);
  const haveDates = new Set(
    (existing.documents as unknown as { captured_at: string }[]).map((d) => d.captured_at.slice(0, 10)),
  );

  for (let i = 0; i < series.length; i++) {
    const { date, nav } = series[i];
    if (haveDates.has(date)) continue;
    const prev = i > 0 ? series[i - 1].nav : nav;
    await databases.createDocument(dbId, "fund_snapshots", ID.unique(), {
      nav_usd: Number(nav.toFixed(2)),
      pnl_daily: Number((nav - prev).toFixed(2)),
      captured_at: `${date}T10:00:00.000Z`, // ~15:30 IST close
      market: "IN",
    });
    summary.snapshotsAdded++;
  }
  log(`reconstruction: ${series.length} sessions from ${series[0].date} → +${summary.snapshotsAdded} snapshots`);
}

/** If the latest IN snapshot still carries a lifetime P&L figure, fix it. */
async function correctLatestPnl(databases: Databases, dbId: string, log: (msg: string) => void): Promise<boolean> {
  const top = await databases.listDocuments(dbId, "fund_snapshots", [
    Query.equal("market", "IN"), Query.orderDesc("captured_at"), Query.limit(2),
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

async function seedScenariosIfEmpty(databases: Databases, dbId: string, log: (msg: string) => void): Promise<number> {
  const existing = await databases.listDocuments(dbId, "scenarios", [Query.equal("market", "IN"), Query.limit(1)]);
  if (existing.total > 0) { log(`scenarios(IN) already present (${existing.total}+)`); return 0; }
  const now = Date.now();
  for (let i = 0; i < INDIA_SCENARIOS.length; i++) {
    const s = INDIA_SCENARIOS[i];
    await databases.createDocument(dbId, "scenarios", ID.unique(), {
      name: s.name,
      description: s.description,
      shocks_json: JSON.stringify(s.branches),
      nav_delta: s.nav_delta,
      worst_position: s.worst_position,
      run_at: new Date(now - i * 60_000).toISOString(),
      market: "IN",
    });
  }
  log(`scenarios(IN) + ${INDIA_SCENARIOS.length}`);
  return INDIA_SCENARIOS.length;
}
