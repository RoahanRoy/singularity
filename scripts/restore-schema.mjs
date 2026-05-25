/**
 * One-shot restore of Appwrite schema from appwrite.json.
 *
 * Recreates database + collections + attributes + indexes after they were
 * wiped by `appwrite push tables` (which misread our collections-format
 * config as "no tables defined" and deleted the database).
 *
 * Idempotent enough: skips entities that already exist. Document data is NOT
 * restored — re-run the agent loop to repopulate.
 */
import fs from "node:fs";
import dotenv from "dotenv";
import { Client, Databases } from "node-appwrite";

dotenv.config({ path: ".env.local" });
dotenv.config();

const endpoint = process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT;
const projectId = process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID;
const apiKey = process.env.APPWRITE_API_KEY;
if (!endpoint || !projectId || !apiKey) throw new Error("Missing Appwrite env");

const client = new Client().setEndpoint(endpoint).setProject(projectId).setKey(apiKey);
const db = new Databases(client);

const cfg = JSON.parse(fs.readFileSync("appwrite.json", "utf8"));
const DB_ID = cfg.databases[0].$id;

async function ensureDb() {
  try {
    await db.get(DB_ID);
    console.log(`db ${DB_ID} exists`);
  } catch {
    await db.create(DB_ID, cfg.databases[0].name, true);
    console.log(`db ${DB_ID} created`);
  }
}

async function ensureCollection(c) {
  try {
    await db.getCollection(DB_ID, c.$id);
    console.log(`  coll ${c.$id} exists, skipping create`);
    return;
  } catch {}
  await db.createCollection(DB_ID, c.$id, c.name, c.$permissions, c.documentSecurity ?? false, c.enabled ?? true);
  console.log(`  coll ${c.$id} created`);
}

async function ensureAttribute(collId, a) {
  // Map appwrite.json attr types to API calls.
  const opts = {
    key: a.key,
    required: a.required ?? false,
    array: a.array ?? false,
    default: a.default ?? null,
  };
  try {
    switch (a.type) {
      case "string":
        if (a.format === "email") {
          await db.createEmailAttribute(DB_ID, collId, opts.key, opts.required, opts.default, opts.array);
        } else if (a.format === "url") {
          await db.createUrlAttribute(DB_ID, collId, opts.key, opts.required, opts.default, opts.array);
        } else if (a.format === "enum") {
          await db.createEnumAttribute(DB_ID, collId, opts.key, a.elements ?? [], opts.required, opts.default, opts.array);
        } else if (a.format === "ip") {
          await db.createIpAttribute(DB_ID, collId, opts.key, opts.required, opts.default, opts.array);
        } else {
          await db.createStringAttribute(DB_ID, collId, opts.key, a.size ?? 255, opts.required, opts.default, opts.array, a.encrypt ?? false);
        }
        break;
      case "integer":
        await db.createIntegerAttribute(DB_ID, collId, opts.key, opts.required, a.min ?? null, a.max ?? null, opts.default, opts.array);
        break;
      case "double":
        await db.createFloatAttribute(DB_ID, collId, opts.key, opts.required, a.min ?? null, a.max ?? null, opts.default, opts.array);
        break;
      case "boolean":
        await db.createBooleanAttribute(DB_ID, collId, opts.key, opts.required, opts.default, opts.array);
        break;
      case "datetime":
        await db.createDatetimeAttribute(DB_ID, collId, opts.key, opts.required, opts.default, opts.array);
        break;
      case "relationship":
        // skip — restore separately if needed
        console.log(`    skip relationship attr ${a.key}`);
        return;
      default:
        console.log(`    ?? unknown type ${a.type} for ${a.key}`);
        return;
    }
    console.log(`    attr ${a.key} (${a.type}) created`);
  } catch (e) {
    const msg = e?.response?.message || e?.message || String(e);
    if (/already exists/i.test(msg)) console.log(`    attr ${a.key} exists`);
    else console.log(`    attr ${a.key} ERR: ${msg}`);
  }
}

async function ensureIndex(collId, ix) {
  try {
    await db.createIndex(DB_ID, collId, ix.key, ix.type, ix.attributes, ix.orders ?? []);
    console.log(`    idx ${ix.key} created`);
  } catch (e) {
    const msg = e?.response?.message || e?.message || String(e);
    if (/already exists/i.test(msg)) console.log(`    idx ${ix.key} exists`);
    else console.log(`    idx ${ix.key} ERR: ${msg}`);
  }
}

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async () => {
  await ensureDb();
  for (const c of cfg.collections) {
    console.log(`collection: ${c.$id}`);
    await ensureCollection(c);
    for (const a of c.attributes ?? []) {
      await ensureAttribute(c.$id, a);
    }
    // attributes need a moment to become available before indexes
    await sleep(4000);
    for (const ix of c.indexes ?? []) {
      await ensureIndex(c.$id, ix);
    }
  }
  console.log("done.");
})().catch((e) => { console.error(e); process.exit(1); });
