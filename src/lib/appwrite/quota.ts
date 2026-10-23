/**
 * Appwrite Free plan guard: 500K database reads and 250K writes a billing
 * period. Over the limit the project is blocked rather than billed, so every
 * server-side client (the agents, the Vercel routes) is metered here and
 * backs off well before that.
 *
 * Counting follows Appwrite's billing: a list costs one read per document
 * returned (an empty list still costs one), a get one read, and a create,
 * update, upsert or delete one write (a bulk call one per document).
 *
 * Every process adds its counts to one shared tally, kept per UTC day in the
 * agent_state document "quota" and summed over a rolling 31 days (at least as
 * strict as any billing period). Counts are flushed every few minutes and
 * before a process exits.
 *
 *   quotaCheck()   loops call it before a unit of work; "pause" past
 *                  MERIDIAN_QUOTA_SHARE of a limit (default 0.8), or once a
 *                  single day has used an eighth of that
 *   hard fence     past 95% of a limit, every metered request throws
 *
 * Browser reads (the dashboard) aren't metered; the remaining 20% covers them.
 * MERIDIAN_QUOTA_GUARD=0 keeps counting but never blocks (a deliberate backfill).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { Databases, type Client } from "node-appwrite";

export const FREE_LIMITS = { reads: 500_000, writes: 250_000 } as const;

type Kind = "reads" | "writes";
type Days = Record<string, [number, number]>; // UTC day → [reads, writes]

const SHARE = Number(process.env.MERIDIAN_QUOTA_SHARE || 0.8);
const ENFORCE = process.env.MERIDIAN_QUOTA_GUARD !== "0";
const FENCE = 0.95;
const WINDOW_DAYS = 31;
/** One day may use at most this fraction of the period budget. */
const DAY_FRACTION = 1 / 8;
const COLLECTION = "agent_state";
const SLOT = "quota";
const FLUSH_OPS = 300;
const FLUSH_MS = 5 * 60_000;
const STALE_MS = 10 * 60_000;

export class QuotaError extends Error {
  code = 429;
}

let db: Databases | null = null;
let dbId = "";
let stored: Days = {}; // the shared tally as last read
let pending: Days = {}; // counted here since the last flush
let pendingOps = 0;
let loadedAt = 0;
let flushedAt = Date.now();
let inflight: Promise<void> | null = null;
let exitHook = false;
/** Set while the guard makes its own requests, which skip the fence. */
const own = new AsyncLocalStorage<true>();

const today = () => new Date().toISOString().slice(0, 10);

function kindOf(method: string, url: URL): Kind | null {
  if (!/\/(databases|tablesdb)(\/|$)/.test(url.pathname)) return null;
  return method.toUpperCase() === "GET" ? "reads" : "writes";
}

function opsIn(data: unknown): number {
  const d = data as { documents?: unknown[]; rows?: unknown[] } | null;
  return Math.max(1, d?.documents?.length ?? d?.rows?.length ?? 1);
}

function add(days: Days, day: string, kind: Kind, n: number) {
  const row = (days[day] ??= [0, 0]);
  row[kind === "reads" ? 0 : 1] += n;
}

/** Rolling-window and today's totals, stored plus not yet flushed. */
export function quotaUsage() {
  const since = new Date(Date.now() - (WINDOW_DAYS - 1) * 86_400_000).toISOString().slice(0, 10);
  const day = today();
  const out = { reads: 0, writes: 0, todayReads: 0, todayWrites: 0 };
  for (const days of [stored, pending]) {
    for (const [d, [r, w]] of Object.entries(days)) {
      if (d < since) continue;
      out.reads += r;
      out.writes += w;
      if (d === day) { out.todayReads += r; out.todayWrites += w; }
    }
  }
  return out;
}

/**
 * Merge this process's counts into the shared tally (and pick up everyone
 * else's). Reads only when there is nothing to add, and skips that too while
 * the tally is fresh. One at a time.
 */
export function flushQuota(): Promise<void> {
  if (!db || (!pendingOps && Date.now() - loadedAt < STALE_MS)) return inflight ?? Promise.resolve();
  inflight ??= own.run(true, async () => {
    const mine = pending;
    const ops = pendingOps;
    pending = {};
    pendingOps = 0;
    try {
      let days: Days = {};
      try {
        const doc = await db!.getDocument(dbId, COLLECTION, SLOT);
        days = (JSON.parse(String(doc.value_json)).days ?? {}) as Days;
      } catch (err) {
        if ((err as { code?: number }).code !== 404) throw err;
      }
      for (const [d, [r, w]] of Object.entries(mine)) {
        add(days, d, "reads", r);
        add(days, d, "writes", w);
      }
      const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
      for (const d of Object.keys(days)) if (d < since) delete days[d];
      if (ops) await db!.upsertDocument(dbId, COLLECTION, SLOT, { value_json: JSON.stringify({ days }) });
      stored = days;
      loadedAt = flushedAt = Date.now();
    } catch (err) {
      // Keep the counts for the next attempt.
      for (const [d, [r, w]] of Object.entries(mine)) {
        add(pending, d, "reads", r);
        add(pending, d, "writes", w);
      }
      pendingOps += ops;
      loadedAt = flushedAt = Date.now(); // retry on the normal schedule, not every request
      console.warn(`[quota] could not save Appwrite usage: ${(err as Error).message}`);
    }
  }).finally(() => { inflight = null; });
  return inflight;
}

function fence(kind: Kind) {
  const used = quotaUsage()[kind];
  const limit = FREE_LIMITS[kind];
  if (used >= FENCE * limit) {
    throw new QuotaError(
      `[quota] Appwrite ${kind} at ${used.toLocaleString("en-US")} of ${limit.toLocaleString("en-US")} in the last ${WINDOW_DAYS} days: request refused`,
    );
  }
}

/**
 * Wrap a client so its database requests are counted (and fenced). Every
 * client made with the server API key should go through this.
 */
export function meterAppwrite(client: Client, databaseId: string): Client {
  db ??= new Databases(client);
  dbId ||= databaseId;
  const call = client.call.bind(client);
  client.call = async (method, url, headers, params, responseType) => {
    const kind = kindOf(method, url);
    if (!kind) return call(method, url, headers, params, responseType);
    const mine = own.getStore();
    if (!mine && Date.now() - loadedAt > STALE_MS) await flushQuota();
    if (ENFORCE && !mine) fence(kind);
    let n = 1;
    try {
      const data = await call(method, url, headers, params, responseType);
      n = opsIn(data);
      return data;
    } finally {
      add(pending, today(), kind, n);
      pendingOps += n;
      if (!mine && (pendingOps >= FLUSH_OPS || Date.now() - flushedAt > FLUSH_MS)) void flushQuota();
    }
  };
  if (!exitHook && typeof process.once === "function") {
    exitHook = true;
    process.once("beforeExit", () => { if (pendingOps) void flushQuota(); });
  }
  return client;
}

/**
 * Whether a loop should start its next unit of work. Re-reads the shared
 * tally when it is older than a few minutes, so other processes count too.
 */
export async function quotaCheck(): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (Date.now() - loadedAt > STALE_MS) await flushQuota();
  if (!ENFORCE) return { ok: true };
  const u = quotaUsage();
  for (const kind of ["reads", "writes"] as const) {
    const budget = SHARE * FREE_LIMITS[kind];
    const day = kind === "reads" ? u.todayReads : u.todayWrites;
    if (u[kind] >= budget) {
      return { ok: false, reason: `Appwrite ${kind} ${u[kind].toLocaleString("en-US")} in the last ${WINDOW_DAYS} days, past the ${budget.toLocaleString("en-US")} budget` };
    }
    if (day >= budget * DAY_FRACTION) {
      return { ok: false, reason: `Appwrite ${kind} ${day.toLocaleString("en-US")} today, past the daily ${(budget * DAY_FRACTION).toLocaleString("en-US")}` };
    }
  }
  return { ok: true };
}
