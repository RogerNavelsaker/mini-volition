import { describe, expect, test } from "bun:test";
import { selectCompactionCandidates, type CompactionCandidate } from "./compaction";

describe("selectCompactionCandidates", () => {
  test("includes reinforced verbatim fragments in archival promotion selection", () => {
    const candidates: CompactionCandidate[] = [
      {
        id: 1,
        source_kind: "verbatim",
        content: "Direct quote from a debugging session with a stable implementation detail.",
        importance: "normal",
        strength: 1.5,
        recall_count: 1,
        decay_score: 1,
      },
      {
        id: 2,
        source_kind: "episodic",
        content: "Resolved an indexing issue by normalizing content before hashing.",
        importance: "high",
        strength: 1,
        recall_count: 0,
        decay_score: 1,
      },
      {
        id: 3,
        source_kind: "digest",
        content: "Team agreed to prefer durable summaries over transient chatter.",
        importance: "normal",
        strength: 2,
        recall_count: 0,
        decay_score: 1,
      },
    ];

    const selected = selectCompactionCandidates(candidates);
    expect(selected.map((row) => row.id)).toEqual([2, 1, 3]);
  });

  test("excludes weak verbatim fragments that have not been reinforced", () => {
    const selected = selectCompactionCandidates([
      {
        id: 1,
        source_kind: "verbatim",
        content: "One-off raw note.",
        importance: "normal",
        strength: 1,
        recall_count: 0,
        decay_score: 1,
      },
      {
        id: 2,
        source_kind: "digest",
        content: "Low-signal social chatter.",
        importance: "low",
        strength: 0.5,
        recall_count: 0,
        decay_score: 1,
      },
    ]);

    expect(selected).toHaveLength(0);
  });
});
