/**
 * Agent process supervisor.
 *
 * Spawns and tracks long-running agent worker scripts (responder, tech-loop)
 * as children of the Next.js server process. The user's `claude login`
 * session lives on this machine, so the workers must run here — not on a
 * serverless host.
 *
 * State is attached to `globalThis` so it survives Next's dev-mode module
 * reloads. The dev server quitting still kills children (default behavior
 * for spawn() — no `detached: true`).
 */
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

export type AgentName = "responder" | "tech";

export type AgentStatus = {
  name: AgentName;
  running: boolean;
  pid: number | null;
  startedAt: string | null;
  exitCode: number | null;
  lastLogs: string[];
};

type AgentRecord = {
  proc: ChildProcess | null;
  startedAt: string | null;
  exitCode: number | null;
  logs: string[]; // ring buffer of last N log lines
};

type SupervisorState = {
  agents: Record<AgentName, AgentRecord>;
};

const SCRIPTS: Record<AgentName, string> = {
  responder: "scripts/agents/responder.ts",
  tech: "scripts/agents/tech-loop.ts",
};

const MAX_LOG_LINES = 200;

function freshRecord(): AgentRecord {
  return { proc: null, startedAt: null, exitCode: null, logs: [] };
}

function getState(): SupervisorState {
  const g = globalThis as unknown as { __meridian_supervisor?: SupervisorState };
  if (!g.__meridian_supervisor) {
    g.__meridian_supervisor = {
      agents: {
        responder: freshRecord(),
        tech: freshRecord(),
      },
    };
  }
  return g.__meridian_supervisor;
}

function pushLog(rec: AgentRecord, chunk: Buffer | string) {
  const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
  for (const line of text.split("\n")) {
    const trimmed = line.replace(/\r$/, "");
    if (!trimmed) continue;
    rec.logs.push(trimmed);
    if (rec.logs.length > MAX_LOG_LINES) rec.logs.shift();
  }
}

export function isRunning(name: AgentName): boolean {
  const rec = getState().agents[name];
  return !!rec.proc && rec.proc.exitCode === null && !rec.proc.killed;
}

export function startAgent(name: AgentName): AgentStatus {
  const state = getState();
  const rec = state.agents[name];

  if (isRunning(name)) return getStatus(name);

  const cwd = process.cwd();
  // turbopackIgnore: these paths are resolved at runtime against the user's
  // working directory and must NOT be traced into the build's NFT.
  const script = path.join(/* turbopackIgnore: true */ cwd, SCRIPTS[name]);
  const tsxBin = path.join(/* turbopackIgnore: true */ cwd, "node_modules", ".bin", "tsx");

  const proc = spawn(tsxBin, [script], {
    cwd,
    env: { ...process.env, MERIDIAN_SUPERVISED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  rec.proc = proc;
  rec.startedAt = new Date().toISOString();
  rec.exitCode = null;
  rec.logs = [`[supervisor] spawned ${name} (pid ${proc.pid})`];

  proc.stdout?.on("data", (d) => pushLog(rec, d));
  proc.stderr?.on("data", (d) => pushLog(rec, d));
  proc.on("exit", (code, signal) => {
    rec.exitCode = code;
    pushLog(rec, `[supervisor] ${name} exited code=${code} signal=${signal}`);
  });
  proc.on("error", (err) => {
    pushLog(rec, `[supervisor] ${name} error: ${err.message}`);
  });

  return getStatus(name);
}

export function stopAgent(name: AgentName): AgentStatus {
  const rec = getState().agents[name];
  if (rec.proc && rec.proc.exitCode === null) {
    rec.proc.kill("SIGTERM");
    pushLog(rec, `[supervisor] ${name} stop requested (SIGTERM)`);
  }
  return getStatus(name);
}

export function getStatus(name: AgentName): AgentStatus {
  const rec = getState().agents[name];
  return {
    name,
    running: isRunning(name),
    pid: rec.proc?.pid ?? null,
    startedAt: rec.startedAt,
    exitCode: rec.exitCode,
    lastLogs: rec.logs.slice(-30),
  };
}

export function allStatuses(): AgentStatus[] {
  return (Object.keys(SCRIPTS) as AgentName[]).map(getStatus);
}

export const AGENT_NAMES: AgentName[] = Object.keys(SCRIPTS) as AgentName[];
