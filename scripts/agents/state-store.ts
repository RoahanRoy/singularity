/**
 * Where the desk loops keep the little state they carry between runs: the
 * round-robin cursors and the event-scan watermarks.
 *
 * Default: dotfiles in the working directory, exactly as before.
 * MERIDIAN_STATE_STORE=appwrite keeps them in the `agent_state` collection
 * instead (document id = file name without the dot / .json, body in
 * `value_json`). Use it wherever the working tree is thrown away between runs,
 * e.g. the scheduled cloud routines. Create the collection once with
 * scripts/create-agent-state-collection.ts.
 */
import fs from "node:fs";
import path from "node:path";
import { db, DB } from "./appwrite";

const USE_APPWRITE = process.env.MERIDIAN_STATE_STORE === "appwrite";
const COLLECTION = "agent_state";

/** ".agents-events-US.json" → "agents-events-US" (a valid Appwrite id). */
function slotId(file: string): string {
  return path.basename(file).replace(/^\./, "").replace(/\.json$/, "");
}

/** Read a slot. null when it has never been written (or can't be read). */
export async function readState<T>(file: string): Promise<T | null> {
  if (!USE_APPWRITE) {
    try {
      return JSON.parse(fs.readFileSync(path.resolve(file), "utf8")) as T;
    } catch {
      return null;
    }
  }
  try {
    const doc = await db.getDocument(DB, COLLECTION, slotId(file));
    return JSON.parse(String(doc.value_json)) as T;
  } catch (err) {
    if ((err as { code?: number }).code !== 404) {
      console.warn(`[state] could not read ${slotId(file)}: ${(err as Error).message}`);
    }
    return null;
  }
}

/** Overwrite a slot. Throws on failure; callers decide whether that's fatal. */
export async function writeState(file: string, value: unknown): Promise<void> {
  const json = JSON.stringify(value);
  if (!USE_APPWRITE) {
    fs.writeFileSync(path.resolve(file), json);
    return;
  }
  await db.upsertDocument(DB, COLLECTION, slotId(file), { value_json: json });
}
