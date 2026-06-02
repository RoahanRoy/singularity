/**
 * Additive schema migration for the India desk.
 *
 * Idempotent — safe to run repeatedly. It ONLY creates:
 *   - a `market` string attribute (default "US") on the desk-scoped collections,
 *   - `kite_account_id` on positions,
 *   - the `kite_accounts` collection (+ attributes + indexes),
 *   - `by_market` key indexes.
 *
 * It never drops or overwrites existing attributes or data. Existing rows read
 * back as market="US", so the US desk is unchanged.
 *
 * Run with: tsx scripts/migrate-market.ts
 * (Equivalent to `appwrite push collections`, but non-interactive.)
 */
import { DatabasesIndexType } from "node-appwrite";
import { db, DB } from "./agents/appwrite";

type Existing = { attributes: { key: string; status?: string }[]; indexes: { key: string }[] };

async function getExisting(col: string): Promise<Existing | null> {
  try {
    const c = (await db.getCollection(DB, col)) as unknown as Existing;
    return { attributes: c.attributes ?? [], indexes: c.indexes ?? [] };
  } catch {
    return null;
  }
}

async function ensureMarketAttr(col: string) {
  const ex = await getExisting(col);
  if (!ex) { console.warn(`  ! collection ${col} not found — skipping`); return; }
  if (ex.attributes.some((a) => a.key === "market")) {
    console.log(`  = ${col}.market exists`);
    return;
  }
  await db.createStringAttribute(DB, col, "market", 4, false, "US");
  console.log(`  + ${col}.market`);
}

async function ensureStringAttr(col: string, key: string, size: number) {
  const ex = await getExisting(col);
  if (!ex) return;
  if (ex.attributes.some((a) => a.key === key)) { console.log(`  = ${col}.${key} exists`); return; }
  await db.createStringAttribute(DB, col, key, size, false);
  console.log(`  + ${col}.${key}`);
}

async function waitAttr(col: string, key: string, tries = 30) {
  for (let i = 0; i < tries; i++) {
    const ex = await getExisting(col);
    const a = ex?.attributes.find((x) => x.key === key);
    if (a && (a.status === "available" || a.status === undefined)) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function ensureIndex(col: string, key: string, attr: string) {
  const ex = await getExisting(col);
  if (!ex) return;
  if (ex.indexes.some((i) => i.key === key)) { console.log(`  = ${col}.${key} index exists`); return; }
  await waitAttr(col, attr);
  await db.createIndex(DB, col, key, DatabasesIndexType.Key, [attr]);
  console.log(`  + ${col}.${key} index`);
}

const MARKET_COLS = ["agents", "clusters", "filings", "memos", "positions", "trades", "scenarios", "fund_snapshots"];
const INDEXED = ["positions", "clusters", "agents", "fund_snapshots", "filings", "memos"];

async function ensureKiteAccounts() {
  let exists = true;
  try { await db.getCollection(DB, "kite_accounts"); } catch { exists = false; }
  if (!exists) {
    await db.createCollection(DB, "kite_accounts", "kite_accounts", [
      'read("users")', 'create("any")', 'update("any")', 'delete("any")',
    ]);
    console.log("  + collection kite_accounts");
  } else {
    console.log("  = collection kite_accounts exists");
  }
  const str = async (k: string, size: number, def?: string) => {
    const ex = await getExisting("kite_accounts");
    if (ex?.attributes.some((a) => a.key === k)) return;
    await db.createStringAttribute(DB, "kite_accounts", k, size, false, def);
    console.log(`  + kite_accounts.${k}`);
  };
  await str("operator_id", 64);
  await str("label", 128);
  await str("kite_user_id", 64);
  await str("api_key", 64);
  await str("access_token", 256);
  await str("public_token", 256);
  await str("status", 24, "connected");
  await str("last_synced_at", 32);
  const ex = await getExisting("kite_accounts");
  if (!ex?.attributes.some((a) => a.key === "equity_cash")) {
    await db.createFloatAttribute(DB, "kite_accounts", "equity_cash", false);
    console.log("  + kite_accounts.equity_cash");
  }
  if (!ex?.attributes.some((a) => a.key === "holdings_count")) {
    await db.createIntegerAttribute(DB, "kite_accounts", "holdings_count", false, 0, 100000);
    console.log("  + kite_accounts.holdings_count");
  }
}

async function main() {
  console.log(`Migrating database "${DB}" — additive market tagging + Kite accounts\n`);

  console.log("market attributes:");
  for (const c of MARKET_COLS) await ensureMarketAttr(c);

  console.log("positions.kite_account_id:");
  await ensureStringAttr("positions", "kite_account_id", 64);

  console.log("kite_accounts collection:");
  await ensureKiteAccounts();

  console.log("by_market indexes:");
  for (const c of INDEXED) await ensureIndex(c, "by_market", "market");

  console.log("\nDone. (Re-run any time; it only creates what's missing.)");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
