import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { ensureSchema } from "./schema";
import { atomicPromote, promotionStatus } from "./promote";
import type { PromotionInput } from "./promote";

function makeDb(): Database {
  const db = new Database(":memory:");
  ensureSchema(db);
  return db;
}

function seedArtifact(db: Database, id: number, agent: string, sourceKind = "episodic") {
  db.run(
    `INSERT INTO agent_memory_artifacts
     (id, agent_name, source_kind, source_table, source_id, content, content_hash, status)
     VALUES (?, ?, ?, 'tier2_episodic', ?, 'content', 'hash${id}', 'active')`,
    [id, agent, sourceKind, id],
  );
}

function baseInput(overrides: Partial<PromotionInput> = {}): PromotionInput {
  return {
    agentName: "agent-test",
    taskId: "memory-compact:sig1",
    signature: "sig1",
    summary: "Test summary",
    structuredJson: JSON.stringify({ summary: "Test", lessons: [], facts: [], decisions: [], patterns: [], open_risks: [] }),
    source: "test",
    sourceArtifactIds: [],
    items: [],
    linkEmbeddings: [],
    ...overrides,
  };
}

// ── atomicPromote ──────────────────────────────────────────────────────────

describe("atomicPromote", () => {
  test("inserts archival record", () => {
    const db = makeDb();
    atomicPromote(db, baseInput());
    const row = db.prepare("SELECT * FROM tier3_archival WHERE task_id = 'memory-compact:sig1'").get() as any;
    expect(row).toBeTruthy();
    expect(row.agent_name).toBe("agent-test");
    expect(row.reflection).toBe("Test summary");
  });

  test("inserts compaction record", () => {
    const db = makeDb();
    atomicPromote(db, baseInput());
    const row = db.prepare("SELECT * FROM agent_memory_compactions WHERE signature = 'sig1'").get() as any;
    expect(row).toBeTruthy();
    expect(row.agent_name).toBe("agent-test");
  });

  test("returns correct archivalId and compactionId", () => {
    const db = makeDb();
    const result = atomicPromote(db, baseInput());
    expect(result.archivalId).toBeGreaterThan(0);
    expect(result.compactionId).toBeGreaterThan(0);
    expect(result.itemIds).toEqual([]);
  });

  test("inserts compaction items", () => {
    const db = makeDb();
    const items = [
      { kind: "lesson", content: "Do X", embedding: [] },
      { kind: "fact", content: "Y is true", embedding: [] },
    ];
    const result = atomicPromote(db, baseInput({ items }));
    expect(result.itemIds).toHaveLength(2);
    const rows = db.prepare("SELECT item_kind, content FROM agent_memory_compaction_items ORDER BY id ASC").all() as any[];
    expect(rows[0].item_kind).toBe("lesson");
    expect(rows[1].item_kind).toBe("fact");
  });

  test("creates cross-item links", () => {
    const db = makeDb();
    const items = [
      { kind: "fact", content: "X is true", embedding: [] },
      { kind: "decision", content: "Use X", embedding: [] },
    ];
    atomicPromote(db, baseInput({ items }));
    const links = db.prepare("SELECT * FROM agent_memory_links").all() as any[];
    expect(links.length).toBeGreaterThan(0);
  });

  test("marks source artifacts with promoted_compaction_id", () => {
    const db = makeDb();
    seedArtifact(db, 1, "agent-test");
    seedArtifact(db, 2, "agent-test");
    const result = atomicPromote(db, baseInput({ sourceArtifactIds: [1, 2] }));
    expect(result.markedSourceCount).toBe(2);
    const rows = db.prepare("SELECT promoted_compaction_id FROM agent_memory_artifacts ORDER BY id ASC").all() as any[];
    expect(rows[0].promoted_compaction_id).toBe(result.compactionId);
    expect(rows[1].promoted_compaction_id).toBe(result.compactionId);
  });

  test("does not double-mark already-promoted artifacts", () => {
    const db = makeDb();
    seedArtifact(db, 1, "agent-test");
    const r1 = atomicPromote(db, baseInput({ signature: "sig1", taskId: "memory-compact:sig1", sourceArtifactIds: [1] }));
    const r2 = atomicPromote(db, baseInput({ signature: "sig2", taskId: "memory-compact:sig2", sourceArtifactIds: [1] }));
    expect(r1.markedSourceCount).toBe(1);
    expect(r2.markedSourceCount).toBe(0);
    const row = db.prepare("SELECT promoted_compaction_id FROM agent_memory_artifacts WHERE id = 1").get() as any;
    expect(row.promoted_compaction_id).toBe(r1.compactionId);
  });

  test("is atomic — rolls back on error", () => {
    const db = makeDb();
    // Force an error by passing duplicate signature after first insert
    atomicPromote(db, baseInput({ signature: "dup" }));
    // Second call with same signature should throw (UNIQUE constraint on compactions)
    expect(() => atomicPromote(db, baseInput({ signature: "dup" }))).toThrow();
    // archival table should not have a second row
    const count = (db.prepare("SELECT COUNT(*) as cnt FROM tier3_archival").get() as any).cnt;
    expect(count).toBe(1);
  });

  test("upserts search index entries for items with embeddings", () => {
    const db = makeDb();
    const items = [{ kind: "lesson", content: "Learn this", embedding: [0.1, 0.2, 0.3] }];
    atomicPromote(db, baseInput({ items }));
    const row = db.prepare("SELECT * FROM agent_memory_search_index WHERE record_kind = 'compaction_item'").get() as any;
    expect(row).toBeTruthy();
    expect(JSON.parse(row.embedding_json)).toEqual([0.1, 0.2, 0.3]);
  });

  test("skips search index for items with empty embeddings", () => {
    const db = makeDb();
    const items = [{ kind: "lesson", content: "Learn this", embedding: [] }];
    atomicPromote(db, baseInput({ items }));
    const row = db.prepare("SELECT * FROM agent_memory_search_index WHERE record_kind = 'compaction_item'").get();
    expect(row).toBeNull();
  });
});

// ── promotionStatus ────────────────────────────────────────────────────────

describe("promotionStatus", () => {
  test("returns zeros for agent with no artifacts", () => {
    const db = makeDb();
    const s = promotionStatus(db, "nobody");
    expect(s.totalArtifacts).toBe(0);
    expect(s.promotedArtifacts).toBe(0);
    expect(s.pendingArtifacts).toBe(0);
    expect(s.compactions).toBe(0);
  });

  test("counts total and pending correctly", () => {
    const db = makeDb();
    seedArtifact(db, 1, "agent-a");
    seedArtifact(db, 2, "agent-a");
    const s = promotionStatus(db, "agent-a");
    expect(s.totalArtifacts).toBe(2);
    expect(s.pendingArtifacts).toBe(2);
    expect(s.promotedArtifacts).toBe(0);
  });

  test("counts promoted correctly after atomicPromote", () => {
    const db = makeDb();
    seedArtifact(db, 1, "agent-a");
    seedArtifact(db, 2, "agent-a");
    atomicPromote(db, baseInput({ agentName: "agent-a", signature: "s1", taskId: "memory-compact:s1", sourceArtifactIds: [1] }));
    const s = promotionStatus(db, "agent-a");
    expect(s.totalArtifacts).toBe(2);
    expect(s.promotedArtifacts).toBe(1);
    expect(s.pendingArtifacts).toBe(1);
    expect(s.compactions).toBe(1);
  });
});
