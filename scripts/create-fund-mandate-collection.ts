/**
 * Safe, surgical creation of the `fund_mandate` collection.
 *
 * Same guarantees as create-news-collection.ts — we never run `appwrite push
 * tables` (it offers to DELETE drifted remote collections). This script:
 *   1. Lists remote collections; if anything is remote-only (a deletion
 *      candidate under `push tables`), it PRINTS and EXITS without writing.
 *   2. If `fund_mandate` already exists, adds only missing attrs/indexes.
 *   3. Otherwise creates ONLY `fund_mandate` + its attributes + index from
 *      appwrite.json. Idempotent: every step checks first. No deletes.
 *
 * Run with: npx tsx --env-file=.env.local scripts/create-fund-mandate-collection.ts
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
const COL = "fund_mandate";

if (!endpoint || !projectId || !apiKey) {
  console.error("Missing env: NEXT_PUBLIC_APPWRITE_ENDPOINT / _PROJECT_ID / APPWRITE_API_KEY");
  process.exit(1);
}

const client = new Client().setEndpoint(endpoint).setProject(projectId).setKey(apiKey);
const db = new Databases(client);

type AttrSpec = { key: string; type: "string" | "double" | "integer"; size?: number; required: boolean; array?: boolean };
type IndexSpec = { key: string; type: "key" | "unique"; attributes: string[]; orders?: string[] };
type LocalCollection = {
  $id: string;
  name: string;
  documentSecurity: boolean;
  $permissions: string[];
  attributes: AttrSpec[];
  indexes: IndexSpec[];
};

function loadLocal(): { all: LocalCollection[]; mandate: LocalCollection } {
  const j = JSON.parse(fs.readFileSync(path.join(process.cwd(), "appwrite.json"), "utf-8"));
  const all = j.collections as LocalCollection[];
  const mandate = all.find((c) => c.$id === COL);
  if (!mandate) throw new Error(`${COL} collection missing from appwrite.json`);
  return { all, mandate };
}

async function listRemoteIds(): Promise<string[]> {
  const res = await (db as unknown as {
    listCollections: (databaseId: string) => Promise<{ total: number; collections: { $id: string }[] }>;
  }).listCollections(DB);
  return res.collections.map((c) => c.$id);
}

async function getShape(id: string): Promise<{ attrs: string[]; indexes: string[] } | null> {
  try {
    const col = await (db as unknown as {
      getCollection: (d: string, c: string) => Promise<{ attributes: { key: string }[]; indexes: { key: string }[] }>;
    }).getCollection(DB, id);
    return { attrs: col.attributes.map((a) => a.key), indexes: col.indexes.map((i) => i.key) };
  } catch {
    return null;
  }
}

async function waitForAttribute(key: string): Promise<void> {
  for (let i = 0; i < 30; i++) {
    const col = await (db as unknown as {
      getCollection: (d: string, c: string) => Promise<{ attributes: { key: string; status: string }[] }>;
    }).getCollection(DB, COL);
    const a = col.attributes.find((x) => x.key === key);
    if (a && a.status === "available") return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`attribute ${COL}.${key} never reached "available"`);
}

async function createAttr(a: AttrSpec): Promise<void> {
  const d = db as unknown as {
    createStringAttribute: (db: string, c: string, k: string, size: number, req: boolean, def?: string | null, arr?: boolean) => Promise<unknown>;
    createFloatAttribute: (db: string, c: string, k: string, req: boolean, min?: number, max?: number, def?: number | null, arr?: boolean) => Promise<unknown>;
    createIntegerAttribute: (db: string, c: string, k: string, req: boolean, min?: number, max?: number, def?: number | null, arr?: boolean) => Promise<unknown>;
  };
  if (a.type === "string") {
    console.log(`  · attr ${a.key}: string size=${a.size} required=${a.required}`);
    await d.createStringAttribute(DB, COL, a.key, a.size ?? 256, a.required, undefined, a.array ?? false);
  } else if (a.type === "double") {
    console.log(`  · attr ${a.key}: double required=${a.required}`);
    await d.createFloatAttribute(DB, COL, a.key, a.required, undefined, undefined, undefined, a.array ?? false);
  } else {
    console.log(`  · attr ${a.key}: integer required=${a.required}`);
    await d.createIntegerAttribute(DB, COL, a.key, a.required, undefined, undefined, undefined, a.array ?? false);
  }
  await waitForAttribute(a.key);
}

async function ensureCollection(mandate: LocalCollection): Promise<void> {
  if (!(await getShape(COL))) {
    console.log(`→ Creating collection \`${COL}\` …`);
    await (db as unknown as {
      createCollection: (d: string, c: string, n: string, p?: string[], ds?: boolean) => Promise<unknown>;
    }).createCollection(DB, mandate.$id, mandate.name, mandate.$permissions, mandate.documentSecurity);
  } else {
    console.log(`→ Collection \`${COL}\` already exists, adding only missing attrs/indexes`);
  }

  const shape = (await getShape(COL))!;
  for (const a of mandate.attributes) {
    if (shape.attrs.includes(a.key)) { console.log(`  · attr ${a.key}: present, skipping`); continue; }
    await createAttr(a);
  }

  const afterAttrs = (await getShape(COL))!;
  for (const idx of mandate.indexes) {
    if (afterAttrs.indexes.includes(idx.key)) { console.log(`  · index ${idx.key}: present, skipping`); continue; }
    console.log(`  · index ${idx.key}: ${idx.type} on ${idx.attributes.join(",")}`);
    await (db as unknown as {
      createIndex: (d: string, c: string, k: string, t: string, a: string[], o?: string[]) => Promise<unknown>;
    }).createIndex(DB, COL, idx.key, idx.type, idx.attributes, idx.orders);
  }
}

(async () => {
  const { all: local, mandate } = loadLocal();
  const localIds = new Set(local.map((c) => c.$id));

  console.log(`\nEndpoint:  ${endpoint}`);
  console.log(`Project:   ${projectId}`);
  console.log(`Database:  ${DB}\n`);

  console.log("Listing remote collections …");
  const remoteIds = await listRemoteIds();
  console.log(`Remote has ${remoteIds.length} collections.\n`);

  const remoteOnly = remoteIds.filter((id) => !localIds.has(id));
  if (remoteOnly.length > 0) {
    console.error("ABORTING: remote has collections not in appwrite.json (would be delete candidates under `push tables`):");
    for (const id of remoteOnly) console.error(`  - ${id}`);
    console.error("Reconcile appwrite.json with these before re-running. No changes made.");
    process.exit(2);
  }

  const localOnly = [...localIds].filter((id) => !remoteIds.includes(id));
  if (!(localOnly.length === 0 || (localOnly.length === 1 && localOnly[0] === COL))) {
    console.error(`ABORTING: unexpected local-only collections ${JSON.stringify(localOnly)}. Expected only \`${COL}\` or nothing.`);
    process.exit(3);
  }

  await ensureCollection(mandate);

  const final = await getShape(COL);
  console.log(`\nDone. Final \`${COL}\` shape:`);
  console.log(`  attributes: ${final?.attrs.join(", ")}`);
  console.log(`  indexes:    ${final?.indexes.join(", ")}`);
})().catch((err) => {
  console.error("\nFAILED:", err);
  process.exit(1);
});
