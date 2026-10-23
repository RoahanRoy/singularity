/**
 * MERIDIAN — Remote agent dispatcher.
 *
 * The bridge that lets the *Vercel-hosted* Operator Console drive agents that
 * must run on THIS machine — the one where `claude login` lives. A serverless
 * UI can't spawn long-lived processes, so the console writes command rows to
 * Appwrite (`agent_commands`) and this dispatcher, kept running on your laptop,
 * consumes them, manages the child agent processes via the shared supervisor,
 * and republishes their live status to Appwrite (`agent_status`) for the UI.
 *
 * Run with: npm run agents:dispatch   (keep it running; keep the laptop on)
 *
 * It OWNS the child processes. If you also run `npm run dev` on this machine,
 * start it with MERIDIAN_AUTOSTART=0 so the Next server doesn't spawn a second
 * responder.
 *
 * Auth: the child agents use your `claude login` (Pro/Max) session — no API
 * key needed. The dispatcher itself talks to Appwrite with the server API key
 * from .env.local.
 *
 * Every poll and status write is an Appwrite read or write against the Free
 * plan, so it polls fast only for a while after a command and then backs off,
 * and writes a status row only when the process behind it changes (its last
 * log line at most every LOG_EVERY_MS), plus one heartbeat row every
 * HEARTBEAT_MS so the console can tell the dispatcher is alive.
 *
 * Env knobs:
 *   MERIDIAN_DISPATCH_POLL_MS   command poll after a command (default 2000)
 *   MERIDIAN_DISPATCH_IDLE_MS   slowest poll once idle (default 60000)
 *   MERIDIAN_AUTOSTART=0        don't auto-start the responder on boot
 */
import {
  startAgent,
  stopAgent,
  getStatus,
  isRunning,
  AGENT_NAMES,
  type AgentName,
} from "../../src/lib/agents/supervisor";
import { db, DB, ID, Query } from "./appwrite";

const POLL_MS = Number(process.env.MERIDIAN_DISPATCH_POLL_MS || 2000);
const IDLE_MS = Number(process.env.MERIDIAN_DISPATCH_IDLE_MS || 60_000);
const ACTIVE_MS = 2 * 60_000;
const LOG_EVERY_MS = 5 * 60_000;
// Console.tsx DISPATCHER_STALE_MS must stay comfortably above this.
const HEARTBEAT_MS = 5 * 60_000;
const AUTOSTART_RESPONDER = process.env.MERIDIAN_AUTOSTART !== "0";
const CMD = "agent_commands";
const STATUS = "agent_status";

type CommandDoc = {
  $id: string;
  target: string;
  action: string;
  status: string;
};

function isAgentName(s: string): s is AgentName {
  return (AGENT_NAMES as string[]).includes(s);
}

/** Drain any pending commands, act on them, and mark them done/error. True if there were any. */
async function consumePending(): Promise<boolean> {
  const res = await db.listDocuments(DB, CMD, [
    Query.equal("status", "pending"),
    Query.orderAsc("occurred_at"),
    Query.limit(10),
  ]);

  for (const cmd of res.documents as unknown as CommandDoc[]) {
    let result: "done" | "error" = "done";
    let note = "";
    try {
      if (!isAgentName(cmd.target)) {
        result = "error";
        note = `unknown target ${cmd.target}`;
      } else if (cmd.action === "start") {
        startAgent(cmd.target);
      } else if (cmd.action === "stop") {
        stopAgent(cmd.target);
      } else if (cmd.action === "restart") {
        stopAgent(cmd.target);
        await new Promise((r) => setTimeout(r, 250));
        startAgent(cmd.target);
      } else {
        result = "error";
        note = `unknown action ${cmd.action}`;
      }
    } catch (err) {
      result = "error";
      note = (err as Error).message;
    }

    console.log(`[dispatch] ${cmd.action} ${cmd.target} → ${result}${note ? ` (${note})` : ""}`);
    try {
      await db.updateDocument(DB, CMD, cmd.$id, {
        status: result,
        consumed_at: new Date().toISOString(),
      });
    } catch (err) {
      console.warn(`[dispatch] could not mark command ${cmd.$id}: ${(err as Error).message}`);
    }
  }
  return res.documents.length > 0;
}

// Remember each worker's status doc id so we update one row instead of piling up.
const statusDocId = new Map<AgentName, string>();
// What each row last said, and when it was written.
const published = new Map<AgentName, { state: string; log: string; at: number }>();

/** Push changed child-process status to Appwrite so the UI can render it live. */
async function publishStatus(): Promise<void> {
  for (const name of AGENT_NAMES) {
    const s = getStatus(name);
    const state = JSON.stringify([s.running, s.pid, s.startedAt, s.exitCode]);
    const log = s.lastLogs[s.lastLogs.length - 1] ?? "";
    const prev = published.get(name);
    const age = prev ? Date.now() - prev.at : Infinity;
    const due =
      !prev ||
      prev.state !== state ||
      (prev.log !== log && age >= LOG_EVERY_MS) ||
      (name === AGENT_NAMES[0] && age >= HEARTBEAT_MS);
    if (!due) continue;
    const fields = {
      name,
      running: s.running,
      pid: s.pid,
      started_at: s.startedAt,
      exit_code: s.exitCode,
      last_log: (s.lastLogs[s.lastLogs.length - 1] ?? "").slice(0, 1024) || null,
      updated_at: new Date().toISOString(),
    };
    try {
      let id = statusDocId.get(name);
      if (!id) {
        const existing = await db.listDocuments(DB, STATUS, [Query.equal("name", name), Query.limit(1)]);
        id = existing.documents[0]?.$id;
      }
      if (id) {
        await db.updateDocument(DB, STATUS, id, fields);
      } else {
        const created = await db.createDocument(DB, STATUS, ID.unique(), fields);
        id = created.$id;
      }
      statusDocId.set(name, id);
      published.set(name, { state, log, at: Date.now() });
    } catch (err) {
      console.warn(`[dispatch] status publish for ${name} failed: ${(err as Error).message}`);
    }
  }
}

let stopping = false;
function shutdown(sig: string) {
  if (stopping) process.exit(0); // second signal → exit now
  stopping = true;
  console.log(`\n[dispatch] ${sig} received — stopping child agents…`);
  for (const name of AGENT_NAMES) {
    if (isRunning(name)) stopAgent(name);
  }
  setTimeout(() => process.exit(0), 1000);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

async function main() {
  console.log(`[dispatch] booted — draining ${CMD} every ${POLL_MS}ms, ${IDLE_MS}ms when idle (Ctrl-C to stop)`);
  if (AUTOSTART_RESPONDER) {
    startAgent("responder");
    console.log(`[dispatch] auto-started responder`);
  }

  let lastActive = Date.now();
  let delay = POLL_MS;
  while (!stopping) {
    try {
      if (await consumePending()) lastActive = Date.now();
      await publishStatus();
    } catch (err) {
      console.warn(`[dispatch] tick error: ${(err as Error).message}`);
    }
    delay = Date.now() - lastActive < ACTIVE_MS ? POLL_MS : Math.min(IDLE_MS, delay * 2);
    await new Promise((r) => setTimeout(r, delay));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
