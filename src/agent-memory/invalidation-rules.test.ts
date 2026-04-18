import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { ensureSchema } from "./schema";
import {
  applyTtlRule,
  applySupersedRule,
  applyObjectPatternRule,
  applyInvalidationRules,
} from "./invalidation-rules";

function makeDb(): Database {
  const db = new Database(":memory:");
  ensureSchema(db);
  return db;
}

function insertCompactionItem(db: Database, agentName: string): number {
  const cid = Number(db.prepare(
    `INSERT INTO agent_memory_compactions (agent_name, source_artifact_ids, signature, summary)
     VALUES (?, '[]', 'sig-' || RANDOM(), 'test')`,
  ).run(agentName).lastInsertRowid);
  return Number(db.prepare(
    `INSERT INTO agent_memory_compaction_items (compaction_id, agent_name, item_kind, content)
     VALUES (?, ?, 'fact', 'test')`,
  ).run(cid, agentName).lastInsertRowid);
}

function insertFact(
  db: Database,
  agentName: string,
  itemId: number,
  subject: string,
  predicate: string,
  object: string,
  updatedAt: string | null = null,
): number {
  if (updatedAt) {
    return Number(db.prepare(
      `INSERT INTO agent_memory_facts (agent_name, source_item_id, subject, predicate, object, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(agentName, itemId, subject, predicate, object, updatedAt).lastInsertRowid);
  }
  return Number(db.prepare(
    `INSERT INTO agent_memory_facts (agent_name, source_item_id, subject, predicate, object)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(agentName, itemId, subject, predicate, object).lastInsertRowid);
}

function isInvalidated(db: Database, id: number): boolean {
  const row = db.prepare("SELECT valid_to FROM agent_memory_facts WHERE id = ?").get(id) as any;
  return row?.valid_to != null;
}

describe("applyTtlRule", () => {
  let db: Database;
  let itemId: number;

  beforeEach(() => {
    db = makeDb();
    itemId = insertCompactionItem(db, "claude");
  });

  it("invalidates a fact older than max_age_days", () => {
    const id = insertFact(db, "claude", itemId, "host", "uptime", "30d", "2020-01-01 00:00:00");
    const count = applyTtlRule(db, "claude", { kind: "ttl", predicate: "uptime", max_age_days: 1 });
    expect(count).toBe(1);
    expect(isInvalidated(db, id)).toBe(true);
  });

  it("does not invalidate a fact newer than max_age_days", () => {
    const id = insertFact(db, "claude", itemId, "host", "uptime", "5m");
    const count = applyTtlRule(db, "claude", { kind: "ttl", predicate: "uptime", max_age_days: 30 });
    expect(count).toBe(0);
    expect(isInvalidated(db, id)).toBe(false);
  });

  it("only invalidates facts matching the predicate", () => {
    const id1 = insertFact(db, "claude", itemId, "host", "uptime", "30d", "2020-01-01 00:00:00");
    const id2 = insertFact(db, "claude", itemId, "host", "status", "ok", "2020-01-01 00:00:00");
    applyTtlRule(db, "claude", { kind: "ttl", predicate: "uptime", max_age_days: 1 });
    expect(isInvalidated(db, id1)).toBe(true);
    expect(isInvalidated(db, id2)).toBe(false);
  });

  it("does not invalidate already-invalid facts (idempotent)", () => {
    const id = insertFact(db, "claude", itemId, "host", "uptime", "30d", "2020-01-01 00:00:00");
    db.prepare("UPDATE agent_memory_facts SET valid_to = CURRENT_TIMESTAMP WHERE id = ?").run(id);
    const count = applyTtlRule(db, "claude", { kind: "ttl", predicate: "uptime", max_age_days: 1 });
    expect(count).toBe(0);
  });

  it("does not touch other agents' facts", () => {
    const itemId2 = insertCompactionItem(db, "gemini");
    const id = insertFact(db, "gemini", itemId2, "host", "uptime", "30d", "2020-01-01 00:00:00");
    applyTtlRule(db, "claude", { kind: "ttl", predicate: "uptime", max_age_days: 1 });
    expect(isInvalidated(db, id)).toBe(false);
  });
});

describe("applySupersedRule", () => {
  let db: Database;
  let itemId: number;

  beforeEach(() => {
    db = makeDb();
    itemId = insertCompactionItem(db, "claude");
  });

  it("keeps the most recent fact and invalidates older ones", () => {
    const old = insertFact(db, "claude", itemId, "auth", "uses", "JWT", "2026-01-01 00:00:00");
    const recent = insertFact(db, "claude", itemId, "auth", "uses", "sessions", "2026-01-02 00:00:00");
    applySupersedRule(db, "claude", { kind: "supersede", predicate: "uses" });
    expect(isInvalidated(db, old)).toBe(true);
    expect(isInvalidated(db, recent)).toBe(false);
  });

  it("returns count of invalidated facts", () => {
    insertFact(db, "claude", itemId, "auth", "uses", "JWT", "2026-01-01 00:00:00");
    insertFact(db, "claude", itemId, "auth", "uses", "sessions", "2026-01-02 00:00:00");
    insertFact(db, "claude", itemId, "auth", "uses", "cookies", "2026-01-01 12:00:00");
    const count = applySupersedRule(db, "claude", { kind: "supersede", predicate: "uses" });
    expect(count).toBe(2);
  });

  it("does nothing when only one fact exists per (subject, predicate)", () => {
    const id = insertFact(db, "claude", itemId, "auth", "uses", "JWT");
    const count = applySupersedRule(db, "claude", { kind: "supersede", predicate: "uses" });
    expect(count).toBe(0);
    expect(isInvalidated(db, id)).toBe(false);
  });

  it("handles multiple different subjects independently", () => {
    const authOld = insertFact(db, "claude", itemId, "auth", "uses", "JWT", "2026-01-01 00:00:00");
    const authNew = insertFact(db, "claude", itemId, "auth", "uses", "sessions", "2026-01-02 00:00:00");
    const dbOld = insertFact(db, "claude", itemId, "db", "uses", "postgres", "2026-01-01 00:00:00");
    const dbNew = insertFact(db, "claude", itemId, "db", "uses", "sqlite", "2026-01-02 00:00:00");
    applySupersedRule(db, "claude", { kind: "supersede", predicate: "uses" });
    expect(isInvalidated(db, authOld)).toBe(true);
    expect(isInvalidated(db, authNew)).toBe(false);
    expect(isInvalidated(db, dbOld)).toBe(true);
    expect(isInvalidated(db, dbNew)).toBe(false);
  });

  it("only affects facts matching the predicate", () => {
    insertFact(db, "claude", itemId, "auth", "uses", "JWT", "2026-01-01 00:00:00");
    insertFact(db, "claude", itemId, "auth", "uses", "sessions", "2026-01-02 00:00:00");
    const isId = insertFact(db, "claude", itemId, "auth", "is", "secure", "2026-01-01 00:00:00");
    applySupersedRule(db, "claude", { kind: "supersede", predicate: "uses" });
    expect(isInvalidated(db, isId)).toBe(false);
  });

  it("does not touch other agents' facts", () => {
    const itemId2 = insertCompactionItem(db, "gemini");
    const g1 = insertFact(db, "gemini", itemId2, "auth", "uses", "JWT", "2026-01-01 00:00:00");
    const g2 = insertFact(db, "gemini", itemId2, "auth", "uses", "sessions", "2026-01-02 00:00:00");
    applySupersedRule(db, "claude", { kind: "supersede", predicate: "uses" });
    expect(isInvalidated(db, g1)).toBe(false);
    expect(isInvalidated(db, g2)).toBe(false);
  });
});

describe("applyObjectPatternRule", () => {
  let db: Database;
  let itemId: number;

  beforeEach(() => {
    db = makeDb();
    itemId = insertCompactionItem(db, "claude");
  });

  it("invalidates facts whose object matches the pattern", () => {
    const id = insertFact(db, "claude", itemId, "lib", "is", "deprecated");
    const count = applyObjectPatternRule(db, "claude", { kind: "object_pattern", pattern: "deprecated" });
    expect(count).toBe(1);
    expect(isInvalidated(db, id)).toBe(true);
  });

  it("matches substring within the object", () => {
    const id = insertFact(db, "claude", itemId, "lib", "is", "no longer maintained (deprecated)");
    applyObjectPatternRule(db, "claude", { kind: "object_pattern", pattern: "deprecated" });
    expect(isInvalidated(db, id)).toBe(true);
  });

  it("does not invalidate non-matching facts", () => {
    const id = insertFact(db, "claude", itemId, "lib", "is", "active and maintained");
    applyObjectPatternRule(db, "claude", { kind: "object_pattern", pattern: "deprecated" });
    expect(isInvalidated(db, id)).toBe(false);
  });

  it("does not touch other agents' facts", () => {
    const itemId2 = insertCompactionItem(db, "gemini");
    const id = insertFact(db, "gemini", itemId2, "lib", "is", "deprecated");
    applyObjectPatternRule(db, "claude", { kind: "object_pattern", pattern: "deprecated" });
    expect(isInvalidated(db, id)).toBe(false);
  });

  it("does not invalidate already-invalid facts", () => {
    const id = insertFact(db, "claude", itemId, "lib", "is", "deprecated");
    db.prepare("UPDATE agent_memory_facts SET valid_to = CURRENT_TIMESTAMP WHERE id = ?").run(id);
    const count = applyObjectPatternRule(db, "claude", { kind: "object_pattern", pattern: "deprecated" });
    expect(count).toBe(0);
  });
});

describe("applyInvalidationRules", () => {
  let db: Database;
  let itemId: number;

  beforeEach(() => {
    db = makeDb();
    itemId = insertCompactionItem(db, "claude");
  });

  it("returns empty results for empty rules", () => {
    expect(applyInvalidationRules(db, "claude", [])).toEqual([]);
  });

  it("returns one result per rule", () => {
    const results = applyInvalidationRules(db, "claude", [
      { kind: "ttl", predicate: "uptime", max_age_days: 1 },
      { kind: "supersede", predicate: "uses" },
    ]);
    expect(results).toHaveLength(2);
  });

  it("reports correct rule_kind in each result", () => {
    const results = applyInvalidationRules(db, "claude", [
      { kind: "object_pattern", pattern: "deprecated" },
    ]);
    expect(results[0].rule_kind).toBe("object_pattern");
  });

  it("reports total invalidated per rule", () => {
    insertFact(db, "claude", itemId, "lib", "is", "deprecated");
    const results = applyInvalidationRules(db, "claude", [
      { kind: "object_pattern", pattern: "deprecated" },
    ]);
    expect(results[0].invalidated).toBe(1);
  });

  it("applies multiple rules independently", () => {
    insertFact(db, "claude", itemId, "host", "uptime", "stale", "2020-01-01 00:00:00");
    insertFact(db, "claude", itemId, "lib", "is", "deprecated");
    const results = applyInvalidationRules(db, "claude", [
      { kind: "ttl", predicate: "uptime", max_age_days: 1 },
      { kind: "object_pattern", pattern: "deprecated" },
    ]);
    expect(results[0].invalidated).toBe(1);
    expect(results[1].invalidated).toBe(1);
  });
});
