import "server-only";
import { createHash } from "node:crypto";
import { Query } from "node-appwrite";
import { createAdminClient, DATABASE_ID } from "@/lib/appwrite/server";
import { COLLECTIONS } from "@/lib/appwrite/schema";
import { fetchTrades, HorizonAuthError, HorizonMissingFeedError, type HorizonTrade } from "./client";
import { marketOf, tickerOf } from "./book";

export type HorizonTradesResult = {
  /** "missing": the Horizon deploy predates its trades feed. */
  status: "synced" | "unauthorized" | "missing" | "error";
  /** Trades new since the last pull, and trades Horizon no longer has. */
  added: number;
  removed: number;
  /** Trades on record after the pull. */
  total: number;
  error?: string;
};

const CHUNK = 100;

/**
 * The document id for a Horizon trade: its own id, digested to fit Appwrite's
 * 36-character ids. Stable across pulls, so a pull only writes what changed.
 */
const docId = (t: HorizonTrade) => createHash("sha256").update(t.id).digest("hex").slice(0, 32);

function toDoc(t: HorizonTrade) {
  const market = marketOf(t);
  const ticker = tickerOf({ symbol: t.symbol, schemeCode: null, name: t.name ?? "" }, market);
  return {
    $id: docId(t),
    ticker,
    // A fund's scheme name is all that names it; a share's, where the broker gave one.
    label: t.name?.slice(0, 128) || null,
    market,
    kind: t.kind === "fund" ? "fund" : "stock",
    side: t.side,
    qty: t.quantity,
    price: t.price,
    amount: Number(t.amount.toFixed(2)),
    currency: t.currency.slice(0, 3) || "INR",
    broker: t.broker.slice(0, 32) || "Horizon",
    estimated: t.estimated,
    executed_at: t.executedAt,
  };
}

/**
 * Mirror Horizon's trade log onto `advisory_trades`, the real book's
 * counterpart to the fund's paper `trades`, which it never touches:
 *   - a trade Horizon has that isn't stored yet is written,
 *   - a stored trade Horizon no longer has is removed (Horizon replaces a
 *     SIP's estimated instalments with the real orders when they're imported),
 *   - a trade already stored is left as it is; Horizon's trade rows are a log
 *     and aren't edited in place.
 *
 * Only the "Sync now" button pulls trades, not the desk loops' per-cycle
 * refresh: listing what is stored costs one Appwrite read per trade, and
 * nothing a loop decides reads the trade log.
 */
export async function syncHorizonTrades(): Promise<HorizonTradesResult> {
  if (inflight) return inflight;
  inflight = pull().finally(() => {
    inflight = null;
  });
  return inflight;
}

let inflight: Promise<HorizonTradesResult> | null = null;

async function pull(): Promise<HorizonTradesResult> {
  const result: HorizonTradesResult = { status: "synced", added: 0, removed: 0, total: 0 };

  let trades: HorizonTrade[];
  try {
    trades = (await fetchTrades()).trades;
  } catch (err) {
    result.status =
      err instanceof HorizonAuthError ? "unauthorized" : err instanceof HorizonMissingFeedError ? "missing" : "error";
    result.error = (err as Error).message;
    return result;
  }

  const { databases } = createAdminClient();
  const stored = new Set<string>();
  let cursor: string | null = null;
  for (;;) {
    const page: { documents: { $id: string }[] } = await databases.listDocuments(DATABASE_ID, COLLECTIONS.advisory_trades, [
      Query.select(["$id"]),
      Query.limit(1000),
      ...(cursor ? [Query.cursorAfter(cursor)] : []),
    ]);
    for (const d of page.documents) stored.add(d.$id);
    if (page.documents.length < 1000) break;
    cursor = page.documents[page.documents.length - 1].$id;
  }

  // An empty log is far likelier a Horizon-side fault than every trade
  // undone; don't let it wipe the record.
  if (trades.length === 0 && stored.size > 0) {
    result.status = "error";
    result.error = "Horizon returned no trades — left the stored trades in place";
    result.total = stored.size;
    return result;
  }

  const docs = new Map(trades.map((t) => [docId(t), toDoc(t)]));
  const fresh = [...docs.values()].filter((d) => !stored.has(d.$id));
  const gone = [...stored].filter((id) => !docs.has(id));

  try {
    for (let i = 0; i < fresh.length; i += CHUNK) {
      await databases.createDocuments(DATABASE_ID, COLLECTIONS.advisory_trades, fresh.slice(i, i + CHUNK));
      result.added += Math.min(CHUNK, fresh.length - i);
    }
    for (const id of gone) {
      await databases.deleteDocument(DATABASE_ID, COLLECTIONS.advisory_trades, id);
      result.removed++;
    }
  } catch (err) {
    result.status = "error";
    result.error = (err as Error).message;
  }
  result.total = stored.size + result.added - result.removed;
  return result;
}
