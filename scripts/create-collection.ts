/**
 * Safe, surgical creation of named collections from appwrite.json.
 *
 * The generic form of create-fund-mandate-collection.ts — we never run
 * `appwrite push tables` (it offers to DELETE drifted remote collections).
 * For each collection id given:
 *   1. Lists remote collections; if anything is remote-only (a deletion
 *      candidate under `push tables`), it PRINTS and EXITS without writing.
 *   2. If the collection exists, adds only its missing attrs/indexes.
 *   3. Otherwise creates it, then its attributes and indexes.
 * Idempotent: every step checks first. Never deletes or alters an existing
 * attribute, index or document.
 *
 * Run with: npx tsx --env-file=.env.local scripts/create-collection.ts <id> [id…]
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
  type: "string" | "double" | "integer" | "boolean" | "datetime";
  size?: number;
  required: boolean;
  array?: boolean;
  default?: string | number | boolean | null;
};
type IndexSpec = { key: string; type: "key" | "unique"; attributes: string[]; orders?: string[] };
type LocalCollection = {
  $id: string;
  name: string;
  documentSecurity: boolean;
  $permissions: string[];
  attributes: AttrSpec[];
  indexes: IndexSpec[];
};

function loadLocal(): LocalCollection[] {
  const j = JSON.parse(fs.readFileSync(path.join(process.cwd(), "appwrite.json"), "utf-8"));
  return j.collections as LocalCollection[];
}

async function listRemoteIds(): Promise<string[]> {
  const res = await db.listCollections(DB);
  return res.collections.map((c) => c.$id);
}

async function getShape(id: string): Promise<{ attrs: string[]; indexes: string[] } | null> {
  try {
    const col = (await db.getCollection(DB, id)) as unknown as { attributes: { key: string }[]; indexes: { key: string }[] };
    return { attrs: col.attributes.map((a) => a.key), indexes: col.indexes.map((i) => i.key) };
  } catch {
    return null;
  }
}

async function waitForAttribute(col: string, key: string): Promise<void> {
  for (let i = 0; i < 30; i++) {
    const c = (await db.getCollection(DB, col)) as unknown as { attributes: { key: string; status: string }[] };
    const a = c.attributes.find((x) => x.key === key);
    if (a && a.status === "available") return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`attribute ${col}.${key} never reached "available"`);
}

async function createAttr(col: string, a: AttrSpec): Promise<void> {
  // A required attribute can't carry a default in Appwrite.
  const def = a.required ? undefined : (a.default ?? undefined);
  const arr = a.array ?? false;
  console.log(`  + attr ${a.key}: ${a.type}${a.size ? ` size=${a.size}` : ""} required=${a.required}`);
  switch (a.type) {
    case "string":
      await db.createStringAttribute(DB, col, a.key, a.size ?? 256, a.required, def as string | undefined, arr);
      break;
    case "double":
      await db.createFloatAttribute(DB, col, a.key, a.required, undefined, undefined, def as number | undefined, arr);
      break;
    case "integer":
      await db.createIntegerAttribute(DB, col, a.key, a.required, undefined, undefined, def as number | undefined, arr);
      break;
    case "boolean":
      await db.createBooleanAttribute(DB, col, a.key, a.required, def as boolean | undefined, arr);
      break;
    case "datetime":
      await db.createDatetimeAttribute(DB, col, a.key, a.required, def as string | undefined, arr);
      break;
  }
  await waitForAttribute(col, a.key);
}

async function ensureCollection(spec: LocalCollection): Promise<void> {
  const col = spec.$id;
  if (!(await getShape(col))) {
    console.log(`→ Creating collection \`${col}\` …`);
    await db.createCollection(DB, col, spec.name, spec.$permissions, spec.documentSecurity);
  } else {
    console.log(`→ Collection \`${col}\` exists, adding only missing attrs/indexes`);
  }

  const shape = (await getShape(col))!;
  for (const a of spec.attributes) {
    if (shape.attrs.includes(a.key)) continue;
    await createAttr(col, a);
  }

  const after = (await getShape(col))!;
  for (const idx of spec.indexes) {
    if (after.indexes.includes(idx.key)) continue;
    console.log(`  + index ${idx.key}: ${idx.type} on ${idx.attributes.join(",")}`);
    await db.createIndex(DB, col, idx.key, idx.type as never, idx.attributes, idx.orders as never);
  }

  const final = (await getShape(col))!;
  console.log(`  attributes: ${final.attrs.join(", ")}`);
  console.log(`  indexes:    ${final.indexes.join(", ")}`);
}

(async () => {
  const ids = process.argv.slice(2);
  if (ids.length === 0) {
    console.error("Usage: create-collection.ts <collection-id> [collection-id…]");
    process.exit(1);
  }
  const local = loadLocal();
  const specs = ids.map((id) => {
    const spec = local.find((c) => c.$id === id);
    if (!spec) {
      console.error(`${id} is not in appwrite.json`);
      process.exit(1);
    }
    return spec;
  });

  console.log(`\nDatabase: ${DB}\n`);
  const remoteIds = await listRemoteIds();
  const localIds = new Set(local.map((c) => c.$id));
  const remoteOnly = remoteIds.filter((id) => !localIds.has(id));
  if (remoteOnly.length > 0) {
    console.error("ABORTING: remote has collections not in appwrite.json:");
    for (const id of remoteOnly) console.error(`  - ${id}`);
    console.error("Reconcile appwrite.json with these before re-running. No changes made.");
    process.exit(2);
  }

  for (const spec of specs) await ensureCollection(spec);
  console.log("\nDone.");
})().catch((err) => {
  console.error("\nFAILED:", err);
  process.exit(1);
});
