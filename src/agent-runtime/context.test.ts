import { describe, expect, test } from "bun:test";
import { buildProactiveQueries, mergePreparedMemories } from "./context";

describe("buildProactiveQueries", () => {
  test("includes full burst context, primary context, and unique body variants", () => {
    const queries = buildProactiveQueries([
      { sender: "alice", layer: "private", body: "Need the bun release artifact details." },
      { sender: "bob", layer: "public", body: "What about Nix packaging?" },
    ]);

    expect(queries.length).toBeGreaterThan(1);
    expect(queries[0]).toContain("alice private Need the bun release artifact details.");
    expect(queries.some((entry) => entry.includes("What about Nix packaging?"))).toBe(true);
  });
});

describe("mergePreparedMemories", () => {
  test("dedupes and merges memory sections across proactive lookups", () => {
    const merged = mergePreparedMemories([
      {
        recentDigests: [{ id: 1, summary: "bun builds releases" }],
        episodic: [{ id: 2, summary: "looked at release workflow" }],
        archival: [{ id: 3, reflection: "GitHub Actions builds standalone binaries" }],
        currentFacts: [{ id: 4, subject: "GitHub Actions", predicate: "uses", object: "bun", valid_from: null }],
        linkedArchival: [{ id: 5, relation: "related_context", weight: 0.5, reflection: "Nix builds from source" }],
        hierarchicalContexts: [{ seed: { id: 6, record_kind: "compaction_item", record_id: 6, source_kind: "archival", content: "bun releases" }, related: [{ tag: "compaction:1", record_kind: "fact", record_id: 4, depth: 1, content: "GitHub Actions uses bun" }] }],
        traces: [{ id: 6, record_kind: "artifact", source_kind: "digest", score: 1, fused_score: 1, top_bonus: 0, lexical_score: 0.2, link_boost: 0, strength: 1, decay_score: 1 }],
        retrievalMode: "mix",
        memorySelection: "initial",
        freshness: { stale: false, stale_after_seconds: 900, last_refresh_at: "2026-04-18T00:00:00Z", last_status: "ready", last_error: null, artifact_count: 10, source: "cache" },
        budget: { token_budget: 1200, tokens_used: 100, dropped_results: 1 },
        cache: { hit: false },
      },
      {
        recentDigests: [{ id: 1, summary: "bun builds releases" }],
        episodic: [{ id: 7, summary: "looked at release workflow" }],
        archival: [{ id: 8, reflection: "Nix builds from source" }],
        currentFacts: [{ id: 4, subject: "GitHub Actions", predicate: "uses", object: "bun", valid_from: null }],
        linkedArchival: [{ id: 5, relation: "related_context", weight: 0.5, reflection: "Nix builds from source" }],
        hierarchicalContexts: [{ seed: { id: 6, record_kind: "compaction_item", record_id: 6, source_kind: "archival", content: "bun releases" }, related: [{ tag: "compaction:1", record_kind: "fact", record_id: 4, depth: 1, content: "GitHub Actions uses bun" }] }],
        traces: [{ id: 9, record_kind: "compaction_item", source_kind: "archival", score: 0.8, fused_score: 0.7, top_bonus: 0, lexical_score: 0.1, link_boost: 0.1, strength: 1, decay_score: 1 }],
        retrievalMode: "mix",
        memorySelection: "secondary",
        freshness: { stale: true, stale_after_seconds: 900, last_refresh_at: "2026-04-17T00:00:00Z", last_status: "ready", last_error: null, artifact_count: 10, source: "cache" },
        budget: { token_budget: 1200, tokens_used: 120, dropped_results: 2 },
        cache: { hit: true },
      },
    ], "mix");

    expect(merged).not.toBeNull();
    expect(merged?.recentDigests).toHaveLength(1);
    expect(merged?.episodic).toHaveLength(2);
    expect(merged?.currentFacts).toHaveLength(1);
    expect(merged?.linkedArchival).toHaveLength(1);
    expect(merged?.hierarchicalContexts).toHaveLength(1);
    expect(merged?.traces).toHaveLength(2);
    expect(merged?.budget?.tokens_used).toBe(220);
    expect(merged?.cache?.hit).toBe(true);
    expect(merged?.memorySelection).toContain("proactive_queries=2");
    expect(merged?.freshness?.stale).toBe(false);
  });
});
