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
 *
 * Every call writes a budget_ledger row using the `total_cost_usd` reported
 * by the SDK so the Operator Console reflects real spend.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { recordSpend } from "./appwrite";

/** Token counts reported by the SDK `result` message. */
type TokenUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};

/**
 * Total tokens actually consumed on the subscription for this call — the honest
 * "real usage" figure the budget gate counts (vs the SDK's API-equivalent $,
 * which you don't pay on a Pro/Max plan). Sums every token class the model
 * processed: fresh input, output, and cache read/write.
 */
function totalTokens(u: TokenUsage | null): number {
  if (!u) return 0;
  return (
    (u.input_tokens || 0) +
    (u.output_tokens || 0) +
    (u.cache_creation_input_tokens || 0) +
    (u.cache_read_input_tokens || 0)
  );
}

type AskOpts = {
  system: string;
  user: string;
  /** Tier alias (haiku|sonnet|opus) or a full "claude-…" id. Resolved upstream by loadPrompt/resolveModel. */
  model?: string;
  /** Optional tag attached to the budget_ledger row for traceability. */
  label?: string;
};

export async function ask({ system, user, model = "sonnet", label }: AskOpts): Promise<string> {
  const out: string[] = [];
  let costUsd = 0;
  let usage: TokenUsage | null = null;
  let modelUsage: unknown = null;

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
    } else if (msg.type === "result") {
      costUsd = msg.total_cost_usd || 0;
      usage = (msg.usage as TokenUsage) ?? null;
      modelUsage = msg.modelUsage;
    }
  }

  void recordSpend("llm", `anthropic/${model}`, costUsd, {
    label: label ?? null,
    usage,
    modelUsage,
  }, totalTokens(usage));

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
