import type { RetrievalMode } from "./policy";

export type PreparedMemory = {
  recentDigests: Array<{ id?: number; summary: string }>;
  episodic: Array<{ id?: number; summary: string }>;
  archival: Array<{ id?: number; reflection: string }>;
  currentFacts?: Array<{ id?: number; subject: string; predicate: string; object: string; valid_from: string | null }>;
  recentInvalidations?: Array<{
    kind: "link" | "fact";
    relation?: string;
    subject?: string;
    predicate?: string;
    object?: string;
    from_content?: string;
    to_content?: string;
    valid_to: string | null;
  }>;
  linkedArchival?: Array<{ id?: number; relation: string; weight: number; reflection: string }>;
  hierarchicalContexts?: Array<{
    seed: { id?: number; record_kind: string; record_id?: number | null; source_kind: string; content: string };
    related: Array<{ tag: string; record_kind: string; record_id: number; depth: number; content: string }>;
  }>;
  timelineEvents?: Array<{
    id: number;
    relation: string;
    weight: number;
    evidence: string | null;
    valid_from: string | null;
    valid_to: string | null;
    from: { id: number; kind: string; content: string };
    to: { id: number; kind: string; content: string };
  }>;
  traces?: Array<{
    id?: number;
    record_kind: string;
    source_kind: string;
    score: number;
    fused_score: number;
    top_bonus: number;
    lexical_score: number;
    link_boost: number;
    strength: number;
    decay_score: number;
  }>;
  retrievalMode?: RetrievalMode;
  memorySelection: string;
  freshness?: {
    stale: boolean;
    stale_after_seconds: number;
    last_refresh_at: string | null;
    last_status: string | null;
    last_error: string | null;
    artifact_count: number;
    source: string | null;
  };
  budget?: {
    token_budget: number;
    tokens_used: number;
    dropped_results: number;
  };
  cache?: {
    hit: boolean;
  };
};

export type BurstMessage = {
  sender: string;
  layer: string;
  body: string;
};

function normalizeQuery(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function buildProactiveQueries(messages: BurstMessage[], maxQueries = 3): string[] {
  const full = normalizeQuery(messages.map((entry) => `${entry.sender} ${entry.layer} ${entry.body}`).join(" ").slice(0, 2400));
  const primary = messages[0] ? normalizeQuery(`${messages[0].sender} ${messages[0].layer} ${messages[0].body}`.slice(0, 1200)) : "";
  const bodies = messages
    .map((entry) => normalizeQuery(entry.body.slice(0, 400)))
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);

  return [...new Set([full, primary, ...bodies])].filter(Boolean).slice(0, Math.max(1, maxQueries));
}

function dedupeByKey<T>(items: T[], keyOf: (item: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const key = keyOf(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

export function mergePreparedMemories(
  lookups: Array<PreparedMemory | null | undefined>,
  mode: RetrievalMode,
): PreparedMemory | null {
  const available = lookups.filter((entry): entry is PreparedMemory => Boolean(entry));
  if (available.length === 0) return null;

  const freshest = available.find((entry) => !entry.freshness?.stale && entry.freshness?.last_status !== "error") ?? available[0]!;
  const recentDigests = dedupeByKey(
    available.flatMap((entry) => entry.recentDigests ?? []),
    (row) => `${row.id ?? "digest"}:${row.summary}`,
  ).slice(0, 6);
  const episodic = dedupeByKey(
    available.flatMap((entry) => entry.episodic ?? []),
    (row) => `${row.id ?? "episodic"}:${row.summary}`,
  ).slice(0, 6);
  const archival = dedupeByKey(
    available.flatMap((entry) => entry.archival ?? []),
    (row) => `${row.id ?? "archival"}:${row.reflection}`,
  ).slice(0, 6);
  const currentFacts = dedupeByKey(
    available.flatMap((entry) => entry.currentFacts ?? []),
    (row) => `${row.id ?? "fact"}:${row.subject}|${row.predicate}|${row.object}`,
  ).slice(0, 8);
  const recentInvalidations = dedupeByKey(
    available.flatMap((entry) => entry.recentInvalidations ?? []),
    (row) => `${row.kind}:${row.relation ?? ""}:${row.subject ?? ""}:${row.object ?? ""}:${row.valid_to ?? ""}`,
  ).slice(0, 8);
  const linkedArchival = dedupeByKey(
    available.flatMap((entry) => entry.linkedArchival ?? []),
    (row) => `${row.id ?? "linked"}:${row.relation}:${row.reflection}`,
  ).slice(0, 8);
  const traces = dedupeByKey(
    available.flatMap((entry) => entry.traces ?? []),
    (row) => `${row.id ?? "trace"}:${row.record_kind}:${row.source_kind}`,
  ).slice(0, 12);
  const hierarchicalContexts = dedupeByKey(
    available.flatMap((entry) => entry.hierarchicalContexts ?? []),
    (row) => `${row.seed.record_kind}:${row.seed.record_id ?? row.seed.id ?? row.seed.content}`,
  ).slice(0, 6);

  const budgets = available.map((entry) => entry.budget).filter(Boolean) as NonNullable<PreparedMemory["budget"]>[];
  const cacheHits = available.some((entry) => Boolean(entry.cache?.hit));
  return {
    recentDigests,
    episodic,
    archival,
    currentFacts,
    recentInvalidations,
    linkedArchival,
    hierarchicalContexts,
    traces,
    retrievalMode: mode,
    memorySelection: `${freshest.memorySelection}; proactive_queries=${available.length}`,
    freshness: freshest.freshness,
    budget: budgets.length > 0
      ? {
          token_budget: Math.max(...budgets.map((entry) => entry.token_budget)),
          tokens_used: budgets.reduce((sum, entry) => sum + entry.tokens_used, 0),
          dropped_results: budgets.reduce((sum, entry) => sum + entry.dropped_results, 0),
        }
      : undefined,
    cache: {
      hit: cacheHits,
    },
  };
}
