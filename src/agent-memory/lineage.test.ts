import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { computeLineageBoosts, inheritLineageTags, listLineageTags, seedCompactionItemLineage, upsertLineageTag } from "./lineage";
import { ensureSchema } from "./schema";

describe("memory lineage tags", () => {
  test("seeds compaction items with stable lineage tags", () => {
    const db = new Database(":memory:");
    ensureSchema(db);

    const tags = seedCompactionItemLineage(db, "codex", 7, 21, "decision");

    expect(tags.map((row) => row.tag)).toEqual(["compaction:7", "kind:decision"]);
    expect(tags.every((row) => row.depth === 0)).toBe(true);
  });

  test("inherits source tags onto derived facts", () => {
    const db = new Database(":memory:");
    ensureSchema(db);

    upsertLineageTag(db, "codex", "compaction_item", 11, "compaction:4", "seed", null, null, 0);
    upsertLineageTag(db, "codex", "compaction_item", 11, "kind:fact", "seed", null, null, 0);

    const inherited = inheritLineageTags(db, "codex", "compaction_item", 11, "fact", 44, "derive_fact");

    expect(inherited).toHaveLength(2);
    expect(inherited.every((row) => row.depth === 1)).toBe(true);
    expect(listLineageTags(db, "codex", "fact", 44).map((row) => row.tag)).toEqual(["compaction:4", "kind:fact"]);
  });

  test("deduplicates inherited tags while preserving the shallowest depth", () => {
    const db = new Database(":memory:");
    ensureSchema(db);

    upsertLineageTag(db, "codex", "compaction_item", 11, "compaction:4", "seed", null, null, 0);
    inheritLineageTags(db, "codex", "compaction_item", 11, "fact", 44, "derive_fact");
    inheritLineageTags(db, "codex", "compaction_item", 11, "fact", 44, "extract_entities");

    const rows = listLineageTags(db, "codex", "fact", 44);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.depth).toBe(1);
  });

  test("boosts nearby records that share lineage with seeded matches", () => {
    const boosts = computeLineageBoosts(
      [
        { searchId: 1, recordKind: "compaction_item", recordId: 11 },
        { searchId: 2, recordKind: "fact", recordId: 44 },
        { searchId: 3, recordKind: "fact", recordId: 45 },
      ],
      [1],
      [
        { record_kind: "compaction_item", record_id: 11, tag: "compaction:4", depth: 0 },
        { record_kind: "fact", record_id: 44, tag: "compaction:4", depth: 1 },
        { record_kind: "fact", record_id: 44, tag: "kind:fact", depth: 1 },
        { record_kind: "fact", record_id: 45, tag: "kind:fact", depth: 1 },
      ],
    );

    expect(boosts.get(1)).toBeUndefined();
    expect(boosts.get(2)).toBeCloseTo(0.09, 5);
    expect(boosts.get(3)).toBeUndefined();
  });
});
