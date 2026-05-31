/**
 * Earnings-call transcript stub.
 *
 * We do not yet have a transcript provider wired (Motley Fool / Seeking Alpha /
 * SEC 8-K Exhibit 99 are all candidates). For now this returns a
 * deterministic "no transcript available" so the earnings-reviewer agent runs
 * end-to-end and returns its neutral shape. When a real source is added,
 * replace fetchTranscript() — the contract is `text | null`.
 *
 * Trust tier: pure HTTP / pure return. No LLM. No DB. Cannot be influenced
 * by transcript content beyond returning bytes.
 */
export type Transcript = {
  ticker: string;
  source_url: string | null;
  body: string | null; // null = unavailable; the reviewer agent handles this case
};

export async function fetchTranscript(ticker: string): Promise<Transcript> {
  // Placeholder. Until we wire a provider, every call returns "unavailable".
  return {
    ticker,
    source_url: null,
    body: null,
  };
}
