/**
 * The compliance restricted list — names the desk may not buy, per market.
 * An operator choice, stored with who added it and when; compliance blocks any
 * buy of a listed ticker (scripts/agents/nodes.ts).
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/restricted.ts list [US|IN]
 *   npx tsx --env-file=.env.local scripts/restricted.ts add <US|IN> <TICKER> <reason…>
 *   npx tsx --env-file=.env.local scripts/restricted.ts remove <US|IN> <TICKER>
 */
import os from "node:os";
import { db, DB, ID, Query } from "./agents/appwrite";

type Market = "US" | "IN";

function usage(msg: string): never {
  console.error(`Error: ${msg}\n`);
  console.error("Usage: restricted.ts list [US|IN] | add <US|IN> <TICKER> <reason…> | remove <US|IN> <TICKER>");
  process.exit(1);
}

const asMarket = (v: string | undefined): Market => {
  const m = (v ?? "").toUpperCase();
  if (m !== "US" && m !== "IN") usage(`market must be US or IN, got "${v}"`);
  return m;
};

async function find(market: Market, ticker: string) {
  const res = await db.listDocuments(DB, "restricted_list", [
    Query.equal("market", market),
    Query.equal("ticker", ticker),
    Query.limit(1),
  ]);
  return res.documents[0] ?? null;
}

async function main() {
  const [cmd, marketArg, tickerArg, ...reasonParts] = process.argv.slice(2);
  if (cmd === "list") {
    const q = [Query.orderAsc("ticker"), Query.limit(500)];
    if (marketArg) q.unshift(Query.equal("market", asMarket(marketArg)));
    const res = await db.listDocuments(DB, "restricted_list", q);
    if (res.total === 0) console.log("Restricted list is empty.");
    for (const d of res.documents) console.log(`${d.market}  ${String(d.ticker).padEnd(14)} ${d.added_at.slice(0, 10)}  ${d.added_by}  ${d.reason}`);
    return;
  }
  const market = asMarket(marketArg);
  const ticker = (tickerArg ?? "").trim().toUpperCase();
  if (!ticker) usage("ticker is required");

  if (cmd === "add") {
    const reason = reasonParts.join(" ").trim();
    if (!reason) usage("a reason is required");
    if (await find(market, ticker)) return console.log(`${market} ${ticker} is already restricted.`);
    await db.createDocument(DB, "restricted_list", ID.unique(), {
      ticker,
      market,
      reason: reason.slice(0, 512),
      added_by: (process.env.USER || os.userInfo().username || "operator").slice(0, 64),
      added_at: new Date().toISOString(),
    });
    console.log(`Restricted ${market} ${ticker}: ${reason}`);
  } else if (cmd === "remove") {
    const doc = await find(market, ticker);
    if (!doc) return console.log(`${market} ${ticker} is not on the list.`);
    await db.deleteDocument(DB, "restricted_list", doc.$id);
    console.log(`Removed ${market} ${ticker} from the restricted list.`);
  } else {
    usage(`unknown command "${cmd ?? ""}"`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
