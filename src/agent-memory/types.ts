export type MemoryKind = "digest" | "episodic" | "archival" | "verbatim";

export type EmbedResponse = {
  embeddings: number[][];
  source: string;
};

export type CompactResponse = {
  summary: string;
  lessons: string[];
  facts: string[];
  decisions: string[];
  patterns: string[];
  open_risks: string[];
  source: string;
};

export type ArtifactRow = {
  id: number;
  record_kind?: string;
  source_kind: MemoryKind;
  content: string;
  embedding_json?: string | null;
  importance?: string;
  strength?: number;
  recall_count?: number;
  last_recalled_at?: string | null;
  decay_score?: number;
  status?: string;
  score?: number;
  lexical_score?: number;
  fused_score?: number;
  top_bonus?: number;
  link_boost?: number;
  centrality_boost?: number;
};

export type RefreshStateRow = {
  agent_name: string;
  last_refresh_at: string | null;
  last_status: string | null;
  last_error: string | null;
  artifact_count: number;
  source: string | null;
  updated_at: string;
};

export type LinkedLookupRow = {
  id: number;
  relation: string;
  weight: number;
  reflection: string;
};

export type CurrentFactRow = {
  id: number;
  subject: string;
  predicate: string;
  object: string;
  valid_from: string | null;
};

export type RecentInvalidationRow = {
  kind: "link" | "fact";
  relation?: string;
  subject?: string;
  predicate?: string;
  object?: string;
  from_content?: string;
  to_content?: string;
  valid_to: string | null;
};

export type TraceRow = {
  id: number;
  record_kind: string;
  source_kind: string;
  score: number;
  fused_score: number;
  top_bonus: number;
  lexical_score: number;
  link_boost: number;
  centrality_boost: number;
  strength: number;
  decay_score: number;
};

export type ExtractEntitiesResponse = {
  entities: Array<{ subject: string; predicate: string; object: string; description: string }>;
  source: string;
};

export type HydeResponse = {
  hypothesis: string;
  source: string;
};

export type DecomposeKeywordsResponse = {
  high_level: string[];
  low_level: string[];
  source: string;
};

export type RerankResult = { index: number; text: string; score: number };

export type RetrievalMode = "local" | "global" | "mix";

export type TimelineEvent = {
  id: number;
  relation: string;
  weight: number;
  evidence: string | null;
  valid_from: string | null;
  valid_to: string | null;
  from: { id: number; kind: string; content: string };
  to: { id: number; kind: string; content: string };
};
