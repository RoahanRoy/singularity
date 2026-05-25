/**
 * Thin wrapper around the Claude Agent SDK.
 *
 * Auth: picks up your existing `claude login` session (Pro/Max subscription)
 * or ANTHROPIC_API_KEY if set. Run `claude login` once in this machine before
 * invoking the tech loop.
 *
 * Each call here is ONE turn — no tool use, no multi-step. The orchestrator
 * is the "agent loop"; individual nodes just ask Claude to reason once and
 * return JSON.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";

type AskOpts = {
  system: string;
  user: string;
  model?: "sonnet" | "haiku" | "opus";
};

export async function ask({ system, user, model = "sonnet" }: AskOpts): Promise<string> {
  const out: string[] = [];
  const iter = query({
    prompt: user,
    options: {
      model,
      systemPrompt: system,
      permissionMode: "bypassPermissions",
      allowedTools: [],
    },
  });
  for await (const msg of iter) {
    if (msg.type === "assistant") {
      for (const block of msg.message.content) {
        if (block.type === "text") out.push(block.text);
      }
    }
  }
  return out.join("").trim();
}

/** Parse a fenced JSON block out of an LLM response. Falls back to {} if missing. */
export function extractJson<T = unknown>(text: string): T {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = (fence ? fence[1] : text).trim();
  try {
    return JSON.parse(raw) as T;
  } catch {
    const obj = raw.match(/\{[\s\S]*\}/);
    if (obj) {
      try { return JSON.parse(obj[0]) as T; } catch {}
    }
    return {} as T;
  }
}
