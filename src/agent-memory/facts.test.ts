import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { consolidateExtractedFacts, matchEntityToItem, upsertMemoryFact } from "./facts";

describe("matchEntityToItem", () => {
  const items = [
    { id: 1, item_kind: "decision", content: "Use bun standalone executables for release artifacts in GitHub Actions." },
    { id: 2, item_kind: "fact", content: "flake.nix provides reproducible source builds for Nix users." },
    { id: 3, item_kind: "pattern", content: "Local inference workers expose unix sockets in runtime/ for orchestration." },
  ];

  test("prefers the item containing both subject and object phrases", () => {
    const match = matchEntityToItem(items, {
      subject: "flake.nix",
      predicate: "provides",
      object: "reproducible source builds",
      description: "flake.nix provides reproducible source builds for Nix users",
    });

    expect(match?.id).toBe(2);
  });

  test("uses token overlap when the extracted tuple paraphrases the source line", () => {
    const match = matchEntityToItem(items, {
      subject: "GitHub Actions",
      predicate: "uses",
      object: "bun standalone executables",
      description: "release artifacts should be built with bun standalone executables in GitHub Actions",
    });

    expect(match?.id).toBe(1);
  });

  test("returns null when no item is a credible match", () => {
    const match = matchEntityToItem(items, {
      subject: "SQLite WAL mode",
      predicate: "improves",
      object: "write concurrency",
      description: "sqlite write concurrency configuration",
    });

    expect(match).toBeNull();
  });
});

describe("consolidateExtractedFacts", () => {
  const items = [
    { id: 10, item_kind: "fact", content: "GitHub Actions uses bun standalone executables for release artifacts." },
    { id: 11, item_kind: "fact", content: "Release artifacts are produced by GitHub Actions with bun standalone executables." },
    { id: 12, item_kind: "decision", content: "Use nix flake builds for reproducible source builds." },
  ];

  test("collapses duplicate tuples that only differ by casing or phrasing", () => {
    const facts = consolidateExtractedFacts(items, [
      {
        subject: "GitHub Actions",
        predicate: "uses",
        object: "bun standalone executables",
        description: "GitHub Actions uses bun standalone executables for release artifacts",
      },
      {
        subject: "github actions",
        predicate: "USES",
        object: "bun standalone executables",
        description: "release artifacts are produced by GitHub Actions with bun standalone executables",
      },
    ]);

    expect(facts).toHaveLength(1);
    expect(facts[0]?.sourceItemId).toBe(10);
    expect(facts[0]?.entityCount).toBe(2);
    expect(facts[0]?.fact.evidence).toContain("GitHub Actions uses bun standalone executables for release artifacts");
    expect(facts[0]?.fact.evidence).toContain("release artifacts are produced by GitHub Actions with bun standalone executables");
  });

  test("keeps distinct tuples separate", () => {
    const facts = consolidateExtractedFacts(items, [
      {
        subject: "GitHub Actions",
        predicate: "uses",
        object: "bun standalone executables",
        description: "GitHub Actions uses bun standalone executables for release artifacts",
      },
      {
        subject: "nix flake builds",
        predicate: "provide",
        object: "reproducible source builds",
        description: "Use nix flake builds for reproducible source builds",
      },
    ]);

    expect(facts).toHaveLength(2);
    expect(facts.map((entry) => entry.sourceItemId).sort((a, b) => a - b)).toEqual([10, 12]);
  });
});

describe("upsertMemoryFact", () => {
  test("merges descriptions across active facts with the same tuple", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE agent_memory_facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_name TEXT NOT NULL,
      source_item_id INTEGER NOT NULL,
      subject TEXT NOT NULL,
      predicate TEXT NOT NULL,
      object TEXT NOT NULL,
      evidence TEXT,
      valid_from DATETIME DEFAULT CURRENT_TIMESTAMP,
      valid_to DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(agent_name, source_item_id, subject, predicate, object)
    );`);

    upsertMemoryFact(db, "codex", 10, {
      subject: "GitHub Actions",
      predicate: "uses",
      object: "bun standalone executables",
      evidence: "GitHub Actions uses bun standalone executables for release artifacts",
    });
    upsertMemoryFact(db, "codex", 11, {
      subject: "GitHub Actions",
      predicate: "uses",
      object: "bun standalone executables",
      evidence: "Release artifacts are produced by GitHub Actions with bun standalone executables",
    });

    const rows = db.prepare(
      `SELECT source_item_id, evidence
       FROM agent_memory_facts
       WHERE agent_name = 'codex'
       ORDER BY source_item_id ASC`,
    ).all() as Array<{ source_item_id: number; evidence: string }>;

    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.evidence).toContain("GitHub Actions uses bun standalone executables for release artifacts");
      expect(row.evidence).toContain("Release artifacts are produced by GitHub Actions with bun standalone executables");
    }
  });
});
