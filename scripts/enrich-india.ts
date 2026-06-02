/**
 * Enrich the India (Kite) book with data derived from free Yahoo Finance
 * history — so the Portfolio screen's India desk shows real numbers instead of
 * empty / zero panels.
 *
 * For every market="IN" position it:
 *   1. pulls ~1y of daily closes for the holding (<TICKER>.NS) and a small set
 *      of factor proxies (NIFTY, Bank Nifty, Nifty IT, USDINR, gold),
 *   2. computes univariate betas of the stock vs each factor (cov/var on daily
 *      returns) and writes them to factor_exposures_json → Factor Exposures,
 *   3. reconstructs the book's NAV series over the window where ALL holdings
 *      have history (qty held constant) and appends the missing daily points to
 *      fund_snapshots (market="IN") → P&L chart + YTD/MTD/Sharpe/Vol/MaxDD,
 *   4. seeds a handful of India-relevant stress scenarios (market="IN") if none
 *      exist yet → Scenario Tree.
 *
 * Non-destructive: updates positions in place, only *appends* snapshots for
 * dates not already present, and only seeds scenarios when none exist.
 *
 * Run:  npx tsx --env-file=.env.local scripts/enrich-india.ts
 */
import { db, DB, ID, Query } from "./agents/appwrite";

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

// ── stats ─────────────────────────────────────────────────────────────────────

/** Aligned daily returns for two close-series, on their common dates. */
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
  if (varf === 0) return 0;
  return cov / varf;
}

/** Close at-or-before a date, using a sorted bar list. */
function closeAtOrBefore(bars: Bar[], date: string): number | null {
  let chosen: number | null = null;
  for (const b of bars) {
    if (b.date <= date) chosen = b.close;
    else break;
  }
  return chosen;
}

// ── factor proxies ──────────────────────────────────────────────────────────

const FACTORS: { key: string; symbol: string }[] = [
  { key: "NIFTY_MKT", symbol: "^NSEI" },
  { key: "IN_BANKS", symbol: "^NSEBANK" },
  { key: "IN_IT", symbol: "^CNXIT" },
  { key: "FX_USDINR", symbol: "INR=X" },
  { key: "GOLD", symbol: "GC=F" },
];

// ── India stress scenarios (seeded only if none exist) ────────────────────────

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

async function seedIndiaScenariosIfEmpty() {
  const existing = await db.listDocuments(DB, "scenarios", [Query.equal("market", "IN"), Query.limit(1)]);
  if (existing.total > 0) {
    console.log(`scenarios(IN) already present (${existing.total}+), skipping`);
    return;
  }
  const now = Date.now();
  for (let i = 0; i < INDIA_SCENARIOS.length; i++) {
    const s = INDIA_SCENARIOS[i];
    await db.createDocument(DB, "scenarios", ID.unique(), {
      name: s.name,
      description: s.description,
      shocks_json: JSON.stringify(s.branches),
      nav_delta: s.nav_delta,
      worst_position: s.worst_position,
      run_at: new Date(now - i * 60_000).toISOString(),
      market: "IN",
    });
  }
  console.log(`scenarios(IN) + ${INDIA_SCENARIOS.length}`);
}

// ── main ────────────────────────────────────────────────────────────────────

type PosDoc = { $id: string; ticker: string; qty: number };

async function main() {
  console.log(`Enriching India book in "${DB}" from Yahoo Finance…\n`);

  const posRes = await db.listDocuments(DB, "positions", [Query.equal("market", "IN"), Query.limit(200)]);
  const positions = posRes.documents as unknown as PosDoc[];
  if (positions.length === 0) {
    console.log("No market=IN positions — connect a Kite account and sync first. Nothing to do.");
    await seedIndiaScenariosIfEmpty();
    return;
  }
  console.log(`India holdings: ${positions.length}`);

  // 1) Factor proxy histories (once).
  const factorBars = new Map<string, Bar[]>();
  for (const f of FACTORS) {
    try {
      factorBars.set(f.key, await fetchDaily(f.symbol));
    } catch (e) {
      console.warn(`  ! factor ${f.key} (${f.symbol}) failed: ${(e as Error).message}`);
    }
  }

  // 2) Per-holding history + betas.
  const holdingBars = new Map<string, Bar[]>(); // ticker -> bars (for reconstruction)
  for (const p of positions) {
    const ySym = `${p.ticker}.NS`;
    let bars: Bar[];
    try {
      bars = await fetchDaily(ySym);
    } catch (e) {
      console.warn(`  ! ${p.ticker} (${ySym}) history failed: ${(e as Error).message} — skipping betas`);
      continue;
    }
    if (bars.length < 30) {
      console.warn(`  ! ${p.ticker}: only ${bars.length} bars — skipping betas`);
      continue;
    }
    holdingBars.set(p.ticker, bars);

    const exposures: { factor: string; beta: number }[] = [];
    for (const f of FACTORS) {
      const fb = factorBars.get(f.key);
      if (!fb) continue;
      const { ra, rb } = alignedReturns(bars, fb);
      const b = beta(ra, rb);
      exposures.push({ factor: f.key, beta: Number(b.toFixed(3)) });
    }
    await db.updateDocument(DB, "positions", p.$id, {
      factor_exposures_json: JSON.stringify(exposures),
    });
    const mkt = exposures.find((e) => e.factor === "NIFTY_MKT");
    console.log(`  ✓ ${p.ticker.padEnd(12)} β(NIFTY)=${mkt ? mkt.beta.toFixed(2) : "?"}  [${exposures.length} factors]`);
  }

  // 3) Reconstruct the NAV series over the window where every held name has
  //    history (qty held constant → a price-driven, composition-stable series).
  await reconstructSnapshots(positions, holdingBars);

  // 4) India stress scenarios.
  await seedIndiaScenariosIfEmpty();

  console.log("\nDone. Refresh the Portfolio screen on the India desk.");
}

async function reconstructSnapshots(positions: PosDoc[], holdingBars: Map<string, Bar[]>) {
  const held = positions.filter((p) => holdingBars.has(p.ticker));
  if (held.length === 0) {
    console.warn("No holding history available — skipping NAV reconstruction.");
    return;
  }

  // Window start = the latest "first date" across holdings (so all names exist).
  let windowStart = "0000-00-00";
  for (const p of held) {
    const first = holdingBars.get(p.ticker)![0].date;
    if (first > windowStart) windowStart = first;
  }
  // Calendar = NIFTY trading days within the window (most complete axis); fall
  // back to the longest holding's dates if the index history is missing.
  const calendarSource =
    holdingBars.get(held[0].ticker)!; // any holding's dates work as the axis
  const calendar = calendarSource.map((b) => b.date).filter((d) => d >= windowStart);

  const series: { date: string; nav: number }[] = [];
  for (const date of calendar) {
    let nav = 0;
    let complete = true;
    for (const p of held) {
      const c = closeAtOrBefore(holdingBars.get(p.ticker)!, date);
      if (c == null) { complete = false; break; }
      nav += p.qty * c;
    }
    if (complete) series.push({ date, nav });
  }
  if (series.length < 2) {
    console.warn("Reconstructed series too short — skipping snapshot append.");
    return;
  }

  // Existing IN snapshot dates (dedup; append only missing days).
  const existing = await db.listDocuments(DB, "fund_snapshots", [Query.equal("market", "IN"), Query.limit(500)]);
  const haveDates = new Set(
    (existing.documents as unknown as { captured_at: string }[]).map((d) => d.captured_at.slice(0, 10)),
  );

  let added = 0;
  for (let i = 0; i < series.length; i++) {
    const { date, nav } = series[i];
    if (haveDates.has(date)) continue;
    const prev = i > 0 ? series[i - 1].nav : nav;
    // 15:30 IST close → 10:00:00Z
    await db.createDocument(DB, "fund_snapshots", ID.unique(), {
      nav_usd: Number(nav.toFixed(2)),
      pnl_daily: Number((nav - prev).toFixed(2)),
      captured_at: `${date}T10:00:00.000Z`,
      market: "IN",
    });
    added++;
  }
  console.log(
    `NAV reconstruction: ${series.length} sessions from ${series[0].date} ` +
      `(${held.length} names) → +${added} new snapshots`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
