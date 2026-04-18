import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { ensureSchema } from "../agent-memory/schema";
import { cleanOrphanedIndex, countOrphanedIndex } from "./maintenance";

function makeMemoryDb(): Database {
  const db = new Database(":memory:");
  ensureSchema(db);
  return db;
}

function makeLibrarianDb(): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE IF NOT EXISTS fleet_maintenance_journal (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_name TEXT NOT NULL,
    task TEXT NOT NULL,
    phase TEXT NOT NULL,
    detail TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`);
  return db;
}

function insertCompaction(db: Database, agentName: string): number {
  const result = db.prepare(
    `INSERT INTO agent_memory_compactions (agent_name, source_artifact_ids, signature, summary) VALUES (?, '[]', 'sig-' || RANDOM(), 'test compaction')`,
  ).run(agentName);
  return Number(result.lastInsertRowid);
}

function insertCompactionItem(db: Database, compactionId: number, agentName: string): number {
  const result = db.prepare(
    `INSERT INTO agent_memory_compaction_items (compaction_id, agent_name, item_kind, content) VALUES (?, ?, 'note', 'test item')`,
  ).run(compactionId, agentName);
  return Number(result.lastInsertRowid);
}

function insertSearchIndex(db: Database, itemId: number, agentName: string): number {
  const result = db.prepare(
    `INSERT INTO agent_memory_search_index (record_kind, record_id, agent_name, source_kind, content) VALUES ('compaction_item', ?, ?, 'compaction', 'test')`,
  ).run(itemId, agentName);
  return Number(result.lastInsertRowid);
}

function insertFact(db: Database, itemId: number, agentName: string): number {
  const result = db.prepare(
    `INSERT INTO agent_memory_facts (agent_name, source_item_id, subject, predicate, object) VALUES (?, ?, 'thing', 'is', 'true')`,
  ).run(agentName, itemId);
  return Number(result.lastInsertRowid);
}

function insertLink(db: Database, fromId: number, toId: number, agentName: string): number {
  const result = db.prepare(
    `INSERT INTO agent_memory_links (agent_name, from_item_id, to_item_id, relation, weight) VALUES (?, ?, ?, 'related', 1.0)`,
  ).run(agentName, fromId, toId);
  return Number(result.lastInsertRowid);
}

function rowExists(db: Database, table: string, id: number): boolean {
  return !!db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id);
}

describe("countOrphanedIndex", () => {
  let memDb: Database;
  beforeEach(() => { memDb = makeMemoryDb(); });

  it("returns zeros when no orphans exist", () => {
    const result = countOrphanedIndex(memDb, "claude");
    expect(result.orphaned_search_index).toBe(0);
    expect(result.orphaned_facts).toBe(0);
    expect(result.orphaned_links).toBe(0);
  });

  it("counts orphaned search_index entries", () => {
    insertSearchIndex(memDb, 99999, "claude");
    const result = countOrphanedIndex(memDb, "claude");
    expect(result.orphaned_search_index).toBe(1);
  });

  it("does not count valid search_index entries", () => {
    const cid = insertCompaction(memDb, "claude");
    const itemId = insertCompactionItem(memDb, cid, "claude");
    insertSearchIndex(memDb, itemId, "claude");
    const result = countOrphanedIndex(memDb, "claude");
    expect(result.orphaned_search_index).toBe(0);
  });

  it("counts orphaned facts", () => {
    insertFact(memDb, 99999, "claude");
    const result = countOrphanedIndex(memDb, "claude");
    expect(result.orphaned_facts).toBe(1);
  });

  it("does not count valid facts", () => {
    const cid = insertCompaction(memDb, "claude");
    const itemId = insertCompactionItem(memDb, cid, "claude");
    insertFact(memDb, itemId, "claude");
    const result = countOrphanedIndex(memDb, "claude");
    expect(result.orphaned_facts).toBe(0);
  });

  it("counts orphaned links (missing from_item)", () => {
    const cid = insertCompaction(memDb, "claude");
    const toId = insertCompactionItem(memDb, cid, "claude");
    insertLink(memDb, 99999, toId, "claude");
    const result = countOrphanedIndex(memDb, "claude");
    expect(result.orphaned_links).toBe(1);
  });

  it("counts orphaned links (missing to_item)", () => {
    const cid = insertCompaction(memDb, "claude");
    const fromId = insertCompactionItem(memDb, cid, "claude");
    insertLink(memDb, fromId, 99999, "claude");
    const result = countOrphanedIndex(memDb, "claude");
    expect(result.orphaned_links).toBe(1);
  });

  it("does not count valid links", () => {
    const cid = insertCompaction(memDb, "claude");
    const from = insertCompactionItem(memDb, cid, "claude");
    const to = insertCompactionItem(memDb, cid, "claude");
    insertLink(memDb, from, to, "claude");
    const result = countOrphanedIndex(memDb, "claude");
    expect(result.orphaned_links).toBe(0);
  });

  it("does not count orphans from other agents", () => {
    insertFact(memDb, 99999, "gemini");
    const result = countOrphanedIndex(memDb, "claude");
    expect(result.orphaned_facts).toBe(0);
  });
});

describe("cleanOrphanedIndex", () => {
  let memDb: Database;
  let libDb: Database;
  beforeEach(() => {
    memDb = makeMemoryDb();
    libDb = makeLibrarianDb();
  });

  it("returns zero counts when nothing to clean", () => {
    const result = cleanOrphanedIndex(memDb, libDb, "claude");
    expect(result.orphaned_search_index).toBe(0);
    expect(result.orphaned_facts).toBe(0);
    expect(result.orphaned_links).toBe(0);
  });

  it("removes orphaned search_index entry", () => {
    const siId = insertSearchIndex(memDb, 99999, "claude");
    cleanOrphanedIndex(memDb, libDb, "claude");
    expect(rowExists(memDb, "agent_memory_search_index", siId)).toBe(false);
  });

  it("removes orphaned fact", () => {
    const fId = insertFact(memDb, 99999, "claude");
    cleanOrphanedIndex(memDb, libDb, "claude");
    expect(rowExists(memDb, "agent_memory_facts", fId)).toBe(false);
  });

  it("removes orphaned link", () => {
    const cid = insertCompaction(memDb, "claude");
    const validId = insertCompactionItem(memDb, cid, "claude");
    const lId = insertLink(memDb, 99999, validId, "claude");
    cleanOrphanedIndex(memDb, libDb, "claude");
    expect(rowExists(memDb, "agent_memory_links", lId)).toBe(false);
  });

  it("preserves valid search_index entries", () => {
    const cid = insertCompaction(memDb, "claude");
    const itemId = insertCompactionItem(memDb, cid, "claude");
    const siId = insertSearchIndex(memDb, itemId, "claude");
    cleanOrphanedIndex(memDb, libDb, "claude");
    expect(rowExists(memDb, "agent_memory_search_index", siId)).toBe(true);
  });

  it("preserves valid facts", () => {
    const cid = insertCompaction(memDb, "claude");
    const itemId = insertCompactionItem(memDb, cid, "claude");
    const fId = insertFact(memDb, itemId, "claude");
    cleanOrphanedIndex(memDb, libDb, "claude");
    expect(rowExists(memDb, "agent_memory_facts", fId)).toBe(true);
  });

  it("preserves valid links", () => {
    const cid = insertCompaction(memDb, "claude");
    const from = insertCompactionItem(memDb, cid, "claude");
    const to = insertCompactionItem(memDb, cid, "claude");
    const lId = insertLink(memDb, from, to, "claude");
    cleanOrphanedIndex(memDb, libDb, "claude");
    expect(rowExists(memDb, "agent_memory_links", lId)).toBe(true);
  });

  it("does not remove entries from other agents", () => {
    const fId = insertFact(memDb, 99999, "gemini");
    cleanOrphanedIndex(memDb, libDb, "claude");
    expect(rowExists(memDb, "agent_memory_facts", fId)).toBe(true);
  });

  it("records maintenance journal entry when orphans found", () => {
    insertFact(memDb, 99999, "claude");
    cleanOrphanedIndex(memDb, libDb, "claude");
    const journal = libDb.prepare("SELECT * FROM fleet_maintenance_journal WHERE agent_name = 'claude'").all() as any[];
    expect(journal.length).toBeGreaterThan(0);
    expect(journal[0].task).toBe("clean-index");
    expect(journal[0].phase).toBe("completed");
  });

  it("returns counts of what was found before deletion", () => {
    insertSearchIndex(memDb, 99999, "claude");
    insertFact(memDb, 99999, "claude");
    const result = cleanOrphanedIndex(memDb, libDb, "claude");
    expect(result.orphaned_search_index).toBe(1);
    expect(result.orphaned_facts).toBe(1);
  });
});
