/**
 * Load agent system prompts from .md files with YAML-ish frontmatter.
 *
 * Pattern adapted from anthropics/financial-services — prompts live as
 * versioned, reviewable markdown rather than inline JS strings.
 */
import fs from "node:fs";
import path from "node:path";

type PromptMeta = {
  name: string;
  description: string;
  model: "haiku" | "sonnet" | "opus";
  output?: string;
};

export type LoadedPrompt = {
  meta: PromptMeta;
  body: string;
};

const DIR = path.resolve(process.cwd(), "scripts/agents/prompts");

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

  return {
    meta: meta as unknown as PromptMeta,
    body: m[2].trim(),
  };
}
