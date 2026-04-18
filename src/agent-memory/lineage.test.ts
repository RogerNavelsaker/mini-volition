import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { inheritLineageTags, listLineageTags, seedCompactionItemLineage, upsertLineageTag } from "./lineage";
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
});
