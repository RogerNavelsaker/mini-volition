import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { ensureSchema } from "./schema";
import { findConflictingFacts, proposeConflictResolutions, applyConflictResolutions } from "./conflicts";

function makeDb(): Database {
  const db = new Database(":memory:");
  ensureSchema(db);
  return db;
}

function insertCompaction(db: Database, agentName: string): number {
  const result = db.prepare(
    `INSERT INTO agent_memory_compactions (agent_name, source_artifact_ids, signature, summary)
     VALUES (?, '[]', 'sig-' || RANDOM(), 'test')`,
  ).run(agentName);
  return Number(result.lastInsertRowid);
}

function insertItem(db: Database, compactionId: number, agentName: string): number {
  const result = db.prepare(
    `INSERT INTO agent_memory_compaction_items (compaction_id, agent_name, item_kind, content)
     VALUES (?, ?, 'fact', 'test item')`,
  ).run(compactionId, agentName);
  return Number(result.lastInsertRowid);
}

function insertFact(
  db: Database,
  agentName: string,
  itemId: number,
  subject: string,
  predicate: string,
  object: string,
  validTo: string | null = null,
  evidence: string | null = null,
): number {
  const result = db.prepare(
    `INSERT INTO agent_memory_facts (agent_name, source_item_id, subject, predicate, object, evidence, valid_to)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(agentName, itemId, subject, predicate, object, evidence, validTo);
  return Number(result.lastInsertRowid);
}

describe("findConflictingFacts", () => {
  let db: Database;
  let itemId: number;

  beforeEach(() => {
    db = makeDb();
    const cid = insertCompaction(db, "claude");
    itemId = insertItem(db, cid, "claude");
  });

  it("returns empty when no facts exist", () => {
    expect(findConflictingFacts(db, "claude")).toEqual([]);
  });

  it("returns empty when all facts have the same object", () => {
    insertFact(db, "claude", itemId, "auth", "uses", "JWT");
    expect(findConflictingFacts(db, "claude")).toEqual([]);
  });

  it("detects conflict when same subject+predicate has two different objects", () => {
    insertFact(db, "claude", itemId, "auth", "uses", "JWT");
    insertFact(db, "claude", itemId, "auth", "uses", "sessions");
    const groups = findConflictingFacts(db, "claude");
    expect(groups).toHaveLength(1);
    expect(groups[0].subject).toBe("auth");
    expect(groups[0].predicate).toBe("uses");
    expect(groups[0].facts).toHaveLength(2);
  });

  it("detects multiple independent conflicts", () => {
    insertFact(db, "claude", itemId, "auth", "uses", "JWT");
    insertFact(db, "claude", itemId, "auth", "uses", "sessions");
    insertFact(db, "claude", itemId, "db", "is", "postgres");
    insertFact(db, "claude", itemId, "db", "is", "sqlite");
    const groups = findConflictingFacts(db, "claude");
    expect(groups).toHaveLength(2);
  });

  it("ignores invalidated facts when counting conflicts", () => {
    insertFact(db, "claude", itemId, "auth", "uses", "JWT");
    insertFact(db, "claude", itemId, "auth", "uses", "sessions", "2020-01-01 00:00:00");
    const groups = findConflictingFacts(db, "claude");
    expect(groups).toHaveLength(0);
  });

  it("does not include facts from other agents", () => {
    const cid2 = insertCompaction(db, "gemini");
    const item2 = insertItem(db, cid2, "gemini");
    insertFact(db, "gemini", item2, "auth", "uses", "JWT");
    insertFact(db, "gemini", item2, "auth", "uses", "sessions");
    const groups = findConflictingFacts(db, "claude");
    expect(groups).toHaveLength(0);
  });

  it("returns all conflicting objects in the facts list", () => {
    insertFact(db, "claude", itemId, "auth", "uses", "JWT");
    insertFact(db, "claude", itemId, "auth", "uses", "sessions");
    insertFact(db, "claude", itemId, "auth", "uses", "cookies");
    const groups = findConflictingFacts(db, "claude");
    expect(groups[0].facts).toHaveLength(3);
  });
});

describe("proposeConflictResolutions", () => {
  it("returns empty array for empty groups", () => {
    expect(proposeConflictResolutions([])).toEqual([]);
  });

  it("proposes one resolution per group", () => {
    const groups = [
      {
        subject: "auth",
        predicate: "uses",
        facts: [
          { id: 1, source_item_id: 10, object: "JWT", evidence: null, updated_at: "2026-01-01 00:00:00" },
          { id: 2, source_item_id: 11, object: "sessions", evidence: null, updated_at: "2026-01-02 00:00:00" },
        ],
      },
    ];
    const proposals = proposeConflictResolutions(groups);
    expect(proposals).toHaveLength(1);
  });

  it("keeps the more recently updated fact", () => {
    const groups = [
      {
        subject: "auth",
        predicate: "uses",
        facts: [
          { id: 1, source_item_id: 10, object: "JWT", evidence: null, updated_at: "2026-01-01 00:00:00" },
          { id: 2, source_item_id: 11, object: "sessions", evidence: null, updated_at: "2026-01-02 00:00:00" },
        ],
      },
    ];
    const proposals = proposeConflictResolutions(groups);
    expect(proposals[0].keep_id).toBe(2);
    expect(proposals[0].invalidate_ids).toContain(1);
  });

  it("invalidates all facts except the winner", () => {
    const groups = [
      {
        subject: "db",
        predicate: "is",
        facts: [
          { id: 1, source_item_id: 10, object: "postgres", evidence: null, updated_at: "2026-01-01 00:00:00" },
          { id: 2, source_item_id: 11, object: "sqlite", evidence: null, updated_at: "2026-01-02 00:00:00" },
          { id: 3, source_item_id: 12, object: "mysql", evidence: null, updated_at: "2026-01-01 12:00:00" },
        ],
      },
    ];
    const proposals = proposeConflictResolutions(groups);
    expect(proposals[0].invalidate_ids).toHaveLength(2);
    expect(proposals[0].invalidate_ids).not.toContain(proposals[0].keep_id);
  });

  it("includes subject and predicate in proposal", () => {
    const groups = [
      {
        subject: "auth",
        predicate: "uses",
        facts: [
          { id: 1, source_item_id: 10, object: "JWT", evidence: null, updated_at: "2026-01-01 00:00:00" },
          { id: 2, source_item_id: 11, object: "sessions", evidence: null, updated_at: "2026-01-02 00:00:00" },
        ],
      },
    ];
    const proposals = proposeConflictResolutions(groups);
    expect(proposals[0].subject).toBe("auth");
    expect(proposals[0].predicate).toBe("uses");
  });

  it("includes a reason string", () => {
    const groups = [
      {
        subject: "auth",
        predicate: "uses",
        facts: [
          { id: 1, source_item_id: 10, object: "JWT", evidence: null, updated_at: "2026-01-01 00:00:00" },
          { id: 2, source_item_id: 11, object: "sessions", evidence: null, updated_at: "2026-01-02 00:00:00" },
        ],
      },
    ];
    const proposals = proposeConflictResolutions(groups);
    expect(typeof proposals[0].reason).toBe("string");
    expect(proposals[0].reason.length).toBeGreaterThan(0);
  });

  it("prefers more specific (longer) object when timestamps are equal", () => {
    const ts = "2026-01-01 00:00:00";
    const groups = [
      {
        subject: "auth",
        predicate: "uses",
        facts: [
          { id: 1, source_item_id: 10, object: "JWT with RS256 signing", evidence: null, updated_at: ts },
          { id: 2, source_item_id: 11, object: "JWT", evidence: null, updated_at: ts },
        ],
      },
    ];
    const proposals = proposeConflictResolutions(groups);
    expect(proposals[0].keep_id).toBe(1);
  });
});

describe("applyConflictResolutions", () => {
  let db: Database;
  let itemId: number;

  beforeEach(() => {
    db = makeDb();
    const cid = insertCompaction(db, "claude");
    itemId = insertItem(db, cid, "claude");
  });

  it("returns 0 when proposals list is empty", () => {
    expect(applyConflictResolutions(db, "claude", [])).toBe(0);
  });

  it("invalidates the loser facts", () => {
    const id1 = insertFact(db, "claude", itemId, "auth", "uses", "JWT");
    const id2 = insertFact(db, "claude", itemId, "auth", "uses", "sessions");
    const proposals = [{ subject: "auth", predicate: "uses", keep_id: id2, invalidate_ids: [id1], reason: "test" }];
    applyConflictResolutions(db, "claude", proposals);
    const row = db.prepare("SELECT valid_to FROM agent_memory_facts WHERE id = ?").get(id1) as any;
    expect(row.valid_to).not.toBeNull();
  });

  it("does not invalidate the kept fact", () => {
    const id1 = insertFact(db, "claude", itemId, "auth", "uses", "JWT");
    const id2 = insertFact(db, "claude", itemId, "auth", "uses", "sessions");
    const proposals = [{ subject: "auth", predicate: "uses", keep_id: id2, invalidate_ids: [id1], reason: "test" }];
    applyConflictResolutions(db, "claude", proposals);
    const row = db.prepare("SELECT valid_to FROM agent_memory_facts WHERE id = ?").get(id2) as any;
    expect(row.valid_to).toBeNull();
  });

  it("returns count of invalidated facts", () => {
    const id1 = insertFact(db, "claude", itemId, "auth", "uses", "JWT");
    const id2 = insertFact(db, "claude", itemId, "auth", "uses", "sessions");
    const id3 = insertFact(db, "claude", itemId, "auth", "uses", "cookies");
    const proposals = [{ subject: "auth", predicate: "uses", keep_id: id3, invalidate_ids: [id1, id2], reason: "test" }];
    const count = applyConflictResolutions(db, "claude", proposals);
    expect(count).toBe(2);
  });

  it("does not touch facts from other agents", () => {
    const cid2 = insertCompaction(db, "gemini");
    const item2 = insertItem(db, cid2, "gemini");
    const geminiId = insertFact(db, "gemini", item2, "auth", "uses", "JWT");
    const proposals = [{ subject: "auth", predicate: "uses", keep_id: 99999, invalidate_ids: [geminiId], reason: "test" }];
    applyConflictResolutions(db, "claude", proposals);
    const row = db.prepare("SELECT valid_to FROM agent_memory_facts WHERE id = ?").get(geminiId) as any;
    expect(row.valid_to).toBeNull();
  });

  it("skips already-invalidated facts without error", () => {
    const id1 = insertFact(db, "claude", itemId, "auth", "uses", "JWT", "2020-01-01 00:00:00");
    const proposals = [{ subject: "auth", predicate: "uses", keep_id: 99999, invalidate_ids: [id1], reason: "test" }];
    const count = applyConflictResolutions(db, "claude", proposals);
    expect(count).toBe(0);
  });
});
