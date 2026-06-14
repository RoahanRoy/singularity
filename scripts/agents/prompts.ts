/**
 * Load agent system prompts from .md files with YAML-ish frontmatter.
 *
 * Pattern adapted from anthropics/financial-services — prompts live as
 * versioned, reviewable markdown rather than inline JS strings.
 */
import fs from "node:fs";
import path from "node:path";

/** A tier alias the SDK understands, or a full "claude-…" model id. */
export type ModelName = "haiku" | "sonnet" | "opus" | (string & {});

type PromptMeta = {
  name: string;
  description: string;
  /** Effective model after env overrides — see {@link resolveModel}. */
  model: ModelName;
  output?: string;
};

export type LoadedPrompt = {
  meta: PromptMeta;
  body: string;
};

const DIR = path.resolve(process.cwd(), "scripts/agents/prompts");

const TIERS = ["haiku", "sonnet", "opus"] as const;

/** Accept a tier alias or any explicit "claude-…" model id; reject the rest. */
function isValidModel(v: string): boolean {
  return (TIERS as readonly string[]).includes(v) || v.startsWith("claude-");
}

// Log each distinct (agent → model) override exactly once, so a long-running
// loop that re-reads prompts every cycle doesn't spam the console.
const _loggedOverrides = new Set<string>();

/**
 * Resolve the model an agent actually runs on. The `model:` in a prompt's
 * frontmatter is the DEFAULT; the operator can override it at runtime via
 * environment variables — no file edits, no rebuild. Precedence, most specific
 * wins:
 *
 *   1. MERIDIAN_MODEL__<SLUG>   one agent. SLUG = the prompt filename upper-cased
 *                               with non-alphanumerics → "_".
 *                               e.g. MERIDIAN_MODEL__RED_TEAM_CRITIC=opus
 *   2. MERIDIAN_MODEL_<TIER>    every agent whose prompt declares that tier.
 *                               e.g. MERIDIAN_MODEL_SONNET=opus
 *   3. MERIDIAN_MODEL           every agent (blunt global override).
 *   4. the frontmatter model    the default.
 *
 * A value must be a tier alias (haiku|sonnet|opus) or a full "claude-…" id;
 * anything else is warned about and ignored (so a typo fails safe to the
 * declared default rather than erroring the loop).
 */
export function resolveModel(slug: string, declared: string): ModelName {
  const envSlug = slug.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  const sources: Array<[string, string | undefined]> = [
    [`MERIDIAN_MODEL__${envSlug}`, process.env[`MERIDIAN_MODEL__${envSlug}`]],
    [`MERIDIAN_MODEL_${declared.toUpperCase()}`, process.env[`MERIDIAN_MODEL_${declared.toUpperCase()}`]],
    ["MERIDIAN_MODEL", process.env.MERIDIAN_MODEL],
  ];

  for (const [via, raw] of sources) {
    const val = raw?.trim();
    if (!val) continue;
    if (!isValidModel(val)) {
      console.warn(`[model] ignoring ${via}="${val}" — expected haiku|sonnet|opus or a claude-* id`);
      continue;
    }
    if (val !== declared) {
      const key = `${slug}:${val}:${via}`;
      if (!_loggedOverrides.has(key)) {
        _loggedOverrides.add(key);
        console.warn(`[model] ${slug}: ${declared} → ${val} (via ${via})`);
      }
    }
    return val;
  }
  return declared;
}

export function loadPrompt(slug: string): LoadedPrompt {
  const raw = fs.readFileSync(path.join(DIR, `${slug}.md`), "utf8");
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error(`Prompt ${slug} missing frontmatter`);

  const meta: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*(.+)$/);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  if (!meta.name || !meta.model) throw new Error(`Prompt ${slug} missing required frontmatter (name, model)`);

  // Frontmatter model is the default; env vars may override it per-agent / per-tier / globally.
  meta.model = resolveModel(slug, meta.model);

  return {
    meta: meta as unknown as PromptMeta,
    body: m[2].trim(),
  };
}
