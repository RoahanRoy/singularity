/**
 * One-off: rewrite governance_events.actor from "K. Park" to the live operator.
 * Run with: npx tsx scripts/swap-operator.ts
 */
import dotenv from "dotenv";
import { Client, Databases, Query } from "node-appwrite";

dotenv.config({ path: ".env.local" });
dotenv.config();

const endpoint = process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT!;
const projectId = process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID!;
const apiKey = process.env.APPWRITE_API_KEY!;
const DB = process.env.NEXT_PUBLIC_APPWRITE_DATABASE_ID || "meridian";

const NEW_NAME = process.env.MERIDIAN_OPERATOR_NAME || "Roahan Roy";

const client = new Client().setEndpoint(endpoint).setProject(projectId).setKey(apiKey);
const db = new Databases(client);

(async () => {
  const res = await db.listDocuments(DB, "governance_events", [
    Query.equal("actor", "K. Park"),
    Query.limit(100),
  ]);
  console.log(`found ${res.total} governance_events with actor="K. Park"`);
  for (const row of res.documents) {
    await db.updateDocument(DB, "governance_events", row.$id, { actor: NEW_NAME });
    console.log(`  → ${row.$id} (${row.target}) → ${NEW_NAME}`);
  }
  console.log(`done. ${res.documents.length} row(s) updated.`);
})().catch((e) => { console.error(e); process.exit(1); });
