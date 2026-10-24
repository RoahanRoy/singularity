/**
 * Fill the fund's index-core rebalance to this session's stored plan
 * (scripts/agents/core.ts). Running it is the operator's approval: the desk
 * loop fills the core on its own only with MERIDIAN_AUTO_APPROVE=1, and holds
 * it otherwise. The circuit breaker still applies.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/core-rebalance.ts [US|IN] [--dry]
 * With no market, both. --dry prints the trade without filling it.
 */
import { db, DB, Query, type Market } from "./agents/appwrite";
import { rebalanceCore } from "./agents/core";

const BROKER: Record<Market, string> = { US: "Paper Broker", IN: "Paper Broker · IN" };

async function main() {
  const args = process.argv.slice(2).map((a) => a.toLowerCase());
  const dry = args.includes("--dry");
  const markets = (["US", "IN"] as const).filter((m) => !args.some((a) => a === "us" || a === "in") || args.includes(m.toLowerCase()));
  for (const market of markets) {
    const agent = await db.listDocuments(DB, "agents", [Query.equal("name", BROKER[market]), Query.limit(1)]);
    const agentId = agent.documents[0]?.$id;
    if (!agentId) {
      console.log(`${market}: no "${BROKER[market]}" agent yet — start the ${market} desk once to create it`);
      continue;
    }
    const r = await rebalanceCore(market, agentId, { execute: true, dry });
    console.log(`${market}: ${r.status === "skipped" ? `skipped (${r.reason})` : r.detail}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
