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
 * Env knobs:
 *   MERIDIAN_DISPATCH_POLL_MS   how often to drain commands / publish (default 2000)
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

/** Drain any pending commands, act on them, and mark them done/error. */
async function consumePending(): Promise<void> {
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
}

// Remember each worker's status doc id so we update one row instead of piling up.
const statusDocId = new Map<AgentName, string>();

/** Push current child-process status to Appwrite so the UI can render it live. */
async function publishStatus(): Promise<void> {
  for (const name of AGENT_NAMES) {
    const s = getStatus(name);
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
  console.log(`[dispatch] booted — draining ${CMD} every ${POLL_MS}ms (Ctrl-C to stop)`);
  if (AUTOSTART_RESPONDER) {
    startAgent("responder");
    console.log(`[dispatch] auto-started responder`);
  }

  while (!stopping) {
    try {
      await consumePending();
      await publishStatus();
    } catch (err) {
      console.warn(`[dispatch] tick error: ${(err as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
