import "server-only";
import { Index } from "@upstash/vector";

export const vector = new Index({
  url: process.env.UPSTASH_VECTOR_REST_URL!,
  token: process.env.UPSTASH_VECTOR_REST_TOKEN!,
});

export type VectorNamespace = "filings" | "memos";

export type VectorMetadata = {
  doc_id: string;
  ticker?: string;
  kind: VectorNamespace;
  chunk_idx?: number;
  text: string;
};
