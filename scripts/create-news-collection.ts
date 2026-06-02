/**
 * Safe, surgical creation of the `news` collection.
 *
 * Why not `appwrite push tables`?
 *   - `push tables` is interactive and offers to DELETE remote collections,
 *     attributes, or indexes that drift from local. We don't want that risk
 *     touching memos/positions/governance_events/etc.
 *
 * What this script does:
 *   1. Lists every collection that exists remotely.
 *   2. Compares to local appwrite.json. If anything is remote-only (i.e. would
 *      be a deletion candidate under `push tables`), it PRINTS the list and
 *      EXITS without writing — operator decides what to do.
 *   3. If `news` already exists remotely, prints its shape and exits.
 *   4. Otherwise creates ONLY the `news` collection + 9 attributes + 4 indexes
 *      from appwrite.json. Idempotent on re-run: each step checks first.
 *
 * No deletes. No updates to existing collections. No surprises.
 *
 * Run with: npx tsx scripts/create-news-collection.ts
 */
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { Client, Databases } from "node-appwrite";

dotenv.config({ path: ".env.local" });
dotenv.config();

const endpoint = process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT!;
const projectId = process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID!;
const apiKey = process.env.APPWRITE_API_KEY!;
const DB = process.env.NEXT_PUBLIC_APPWRITE_DATABASE_ID || "meridian";

if (!endpoint || !projectId || !apiKey) {
  console.error("Missing env: NEXT_PUBLIC_APPWRITE_ENDPOINT / _PROJECT_ID / APPWRITE_API_KEY");
  process.exit(1);
}

const client = new Client().setEndpoint(endpoint).setProject(projectId).setKey(apiKey);
const db = new Databases(client);

type AttrSpec = {
  key: string;
  type: "string";
  size: number;
  required: boolean;
  array?: boolean;
};
type IndexSpec = { key: string; type: "key" | "unique"; attributes: string[] };
type LocalCollection = {
  $id: string;
  name: string;
  documentSecurity: boolean;
  $permissions: string[];
  attributes: AttrSpec[];
  indexes: IndexSpec[];
};

function loadLocal(): { all: LocalCollection[]; news: LocalCollection } {
  const raw = fs.readFileSync(
    path.join(process.cwd(), "appwrite.json"),
    "utf-8",
  );
  const j = JSON.parse(raw);
  const all = j.collections as LocalCollection[];
  const news = all.find((c) => c.$id === "news");
  if (!news) throw new Error("news collection missing from appwrite.json");
  return { all, news };
}

async function listRemoteIds(): Promise<string[]> {
  // Appwrite SDK exposes listCollections in older versions; in 25.x it's
  // listTables on the Tables service. We try both via the REST API directly
  // by listing all collections through Databases.listCollections if present.
  // node-appwrite 25 still ships Databases.listCollections.
  const out: string[] = [];
  let offset = 0;
  while (true) {
    const res = await (db as unknown as {
      listCollections: (
        databaseId: string,
        queries?: string[],
      ) => Promise<{ total: number; collections: { $id: string }[] }>;
    }).listCollections(DB);
    for (const c of res.collections) out.push(c.$id);
    offset += res.collections.length;
    if (offset >= res.total || res.collections.length === 0) break;
  }
  return out;
}

async function getCollectionShape(id: string): Promise<{
  attrs: string[];
  indexes: string[];
} | null> {
  try {
    const col = await (db as unknown as {
      getCollection: (
        databaseId: string,
        collectionId: string,
      ) => Promise<{ attributes: { key: string }[]; indexes: { key: string }[] }>;
    }).getCollection(DB, id);
    return {
      attrs: col.attributes.map((a) => a.key),
      indexes: col.indexes.map((i) => i.key),
    };
  } catch {
    return null;
  }
}

async function waitForAttribute(colId: string, key: string): Promise<void> {
  // Attribute creation is async on Appwrite; poll status until "available".
  for (let i = 0; i < 30; i++) {
    const col = await (db as unknown as {
      getCollection: (
        databaseId: string,
        collectionId: string,
      ) => Promise<{ attributes: { key: string; status: string }[] }>;
    }).getCollection(DB, colId);
    const a = col.attributes.find((x) => x.key === key);
    if (a && a.status === "available") return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`attribute ${colId}.${key} never reached "available"`);
}

async function ensureNews(news: LocalCollection): Promise<void> {
  const remote = await getCollectionShape("news");
  if (!remote) {
    console.log("→ Creating collection `news` …");
    await (db as unknown as {
      createCollection: (
        databaseId: string,
        collectionId: string,
        name: string,
        permissions?: string[],
        documentSecurity?: boolean,
      ) => Promise<unknown>;
    }).createCollection(
      DB,
      news.$id,
      news.name,
      news.$permissions,
      news.documentSecurity,
    );
  } else {
    console.log("→ Collection `news` already exists, will only add missing attrs/indexes");
  }

  // Attributes — additive only.
  const remoteShape = (await getCollectionShape("news"))!;
  for (const a of news.attributes) {
    if (remoteShape.attrs.includes(a.key)) {
      console.log(`  · attr ${a.key}: present, skipping`);
      continue;
    }
    console.log(`  · attr ${a.key}: creating (string size=${a.size} required=${a.required})`);
    await (db as unknown as {
      createStringAttribute: (
        databaseId: string,
        collectionId: string,
        key: string,
        size: number,
        required: boolean,
        xdefault?: string | null,
        array?: boolean,
      ) => Promise<unknown>;
    }).createStringAttribute(
      DB,
      "news",
      a.key,
      a.size,
      a.required,
      undefined,
      a.array ?? false,
    );
    await waitForAttribute("news", a.key);
  }

  // Indexes — additive only.
  const shapeAfterAttrs = (await getCollectionShape("news"))!;
  for (const idx of news.indexes) {
    if (shapeAfterAttrs.indexes.includes(idx.key)) {
      console.log(`  · index ${idx.key}: present, skipping`);
      continue;
    }
    console.log(`  · index ${idx.key}: creating (${idx.type} on ${idx.attributes.join(",")})`);
    await (db as unknown as {
      createIndex: (
        databaseId: string,
        collectionId: string,
        key: string,
        type: string,
        attributes: string[],
      ) => Promise<unknown>;
    }).createIndex(DB, "news", idx.key, idx.type, idx.attributes);
  }
}

(async () => {
  const { all: local, news } = loadLocal();
  const localIds = new Set(local.map((c) => c.$id));

  console.log(`\nEndpoint:  ${endpoint}`);
  console.log(`Project:   ${projectId}`);
  console.log(`Database:  ${DB}\n`);

  console.log("Listing remote collections …");
  const remoteIds = await listRemoteIds();
  console.log(`Remote has ${remoteIds.length} collections.\n`);

  const remoteOnly = remoteIds.filter((id) => !localIds.has(id));
  const localOnly = [...localIds].filter((id) => !remoteIds.includes(id));

  console.log("Remote-only collections (these would be DELETE candidates under `push tables`):");
  if (remoteOnly.length === 0) console.log("  (none — safe)");
  else for (const id of remoteOnly) console.log(`  - ${id}`);
  console.log("");

  console.log("Local-only collections (these will be CREATED if we proceed):");
  if (localOnly.length === 0) console.log("  (none)");
  else for (const id of localOnly) console.log(`  + ${id}`);
  console.log("");

  // Sanity gates.
  if (remoteOnly.length > 0) {
    console.error("ABORTING: remote has collections that aren't in appwrite.json.");
    console.error("We won't proceed because we can't promise we won't surprise you later.");
    console.error("Tell the operator about the list above and decide before re-running.");
    process.exit(2);
  }
  const expectNewOnly = localOnly.length === 1 && localOnly[0] === "news";
  const expectNoNew = localOnly.length === 0;
  if (!expectNewOnly && !expectNoNew) {
    console.error("ABORTING: unexpected local-only collections. Expected only `news` or nothing.");
    process.exit(3);
  }

  await ensureNews(news);

  console.log("\nDone. Final `news` shape:");
  const final = await getCollectionShape("news");
  console.log(`  attributes: ${final?.attrs.join(", ")}`);
  console.log(`  indexes:    ${final?.indexes.join(", ")}`);
})().catch((err) => {
  console.error("\nFAILED:", err);
  process.exit(1);
});
