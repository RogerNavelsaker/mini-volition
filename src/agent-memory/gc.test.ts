import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { ensureSchema } from "./schema";
import {
  softDeleteArtifact,
  softDeleteCompactionItem,
  softDeleteFact,
  softDeleteLink,
  gcDeletedArtifacts,
  gcDeletedCompactionItems,
  gcExpiredFacts,
  gcExpiredLinks,
  gcSweep,
} from "./gc";

const NOW = "2026-04-18T12:00:00.000Z";
const PAST_7 = "2026-04-11T12:00:00.000Z";  // exactly 7 days ago
const PAST_8 = "2026-04-10T12:00:00.000Z";  // 8 days ago
const PAST_6 = "2026-04-12T12:00:00.000Z";  // 6 days ago

function makeDb(): Database {
  const db = new Database(":memory:");
  ensureSchema(db);
  return db;
}

function insertArtifact(db: Database, agentName: string, status = "active", updatedAt = NOW): number {
  const result = db.prepare(
    `INSERT INTO agent_memory_artifacts
     (agent_name, source_kind, source_table, source_id, content, content_hash, status, created_at, updated_at)
     VALUES (?, 'episodic', 'tier2_episodic', ?, 'test content', 'hash123', ?, ?, ?)
     RETURNING id`,
  ).get(agentName, Math.random(), status, NOW, updatedAt) as { id: number };
  return result.id;
}

function insertCompactionItem(db: Database, agentName: string, status = "active", updatedAt = NOW): number {
  const compaction = db.prepare(
    `INSERT INTO agent_memory_compactions (agent_name, source_artifact_ids, signature, summary)
     VALUES (?, '[]', ?, 'test') RETURNING id`,
  ).get(agentName, `sig-${Math.random()}`) as { id: number };
  const item = db.prepare(
    `INSERT INTO agent_memory_compaction_items (compaction_id, agent_name, item_kind, content, status, created_at, updated_at)
     VALUES (?, ?, 'lesson', 'test', ?, ?, ?) RETURNING id`,
  ).get(compaction.id, agentName, status, NOW, updatedAt) as { id: number };
  return item.id;
}

function insertFact(db: Database, agentName: string, validTo: string | null = null): number {
  const row = db.prepare(
    `INSERT INTO agent_memory_facts (agent_name, source_item_id, subject, predicate, object, valid_from, valid_to)
     VALUES (?, 1, 'subj', 'pred', 'obj', ?, ?) RETURNING id`,
  ).get(agentName, NOW, validTo) as { id: number };
  return row.id;
}

function insertLink(db: Database, agentName: string, validTo: string | null = null): number {
  const row = db.prepare(
    `INSERT INTO agent_memory_links (agent_name, from_item_id, to_item_id, relation, weight, valid_from, valid_to)
     VALUES (?, 1, 2, 'supports', 0.5, ?, ?) RETURNING id`,
  ).get(agentName, NOW, validTo) as { id: number };
  return row.id;
}

describe("softDeleteArtifact", () => {
  let db: Database;
  beforeEach(() => { db = makeDb(); });

  it("marks artifact as deleted", () => {
    const id = insertArtifact(db, "claude");
    const changed = softDeleteArtifact(db, id, NOW);
    expect(changed).toBe(true);
    const row = db.prepare("SELECT status FROM agent_memory_artifacts WHERE id = ?").get(id) as { status: string };
    expect(row.status).toBe("deleted");
  });

  it("returns false for already-deleted artifact", () => {
    const id = insertArtifact(db, "claude", "deleted");
    const changed = softDeleteArtifact(db, id, NOW);
    expect(changed).toBe(false);
  });

  it("returns false for non-existent artifact", () => {
    expect(softDeleteArtifact(db, 9999, NOW)).toBe(false);
  });
});

describe("softDeleteCompactionItem", () => {
  let db: Database;
  beforeEach(() => { db = makeDb(); });

  it("marks compaction item as deleted", () => {
    const id = insertCompactionItem(db, "claude");
    const changed = softDeleteCompactionItem(db, id, NOW);
    expect(changed).toBe(true);
    const row = db.prepare("SELECT status FROM agent_memory_compaction_items WHERE id = ?").get(id) as { status: string };
    expect(row.status).toBe("deleted");
  });

  it("returns false for already-deleted item", () => {
    const id = insertCompactionItem(db, "claude", "deleted");
    expect(softDeleteCompactionItem(db, id, NOW)).toBe(false);
  });
});

describe("softDeleteFact", () => {
  let db: Database;
  beforeEach(() => { db = makeDb(); });

  it("sets valid_to on active fact", () => {
    const id = insertFact(db, "claude");
    expect(softDeleteFact(db, id, NOW)).toBe(true);
    const row = db.prepare("SELECT valid_to FROM agent_memory_facts WHERE id = ?").get(id) as { valid_to: string };
    expect(row.valid_to).toBe(NOW);
  });

  it("returns false if fact is already expired", () => {
    const id = insertFact(db, "claude", PAST_8);
    expect(softDeleteFact(db, id, NOW)).toBe(false);
  });
});

describe("softDeleteLink", () => {
  let db: Database;
  beforeEach(() => { db = makeDb(); });

  it("sets valid_to on active link", () => {
    const id = insertLink(db, "claude");
    expect(softDeleteLink(db, id, NOW)).toBe(true);
    const row = db.prepare("SELECT valid_to FROM agent_memory_links WHERE id = ?").get(id) as { valid_to: string };
    expect(row.valid_to).toBe(NOW);
  });

  it("returns false if link is already expired", () => {
    const id = insertLink(db, "claude", PAST_8);
    expect(softDeleteLink(db, id, NOW)).toBe(false);
  });
});

describe("gcDeletedArtifacts", () => {
  let db: Database;
  beforeEach(() => { db = makeDb(); });

  it("hard-deletes artifacts soft-deleted past retention window", () => {
    const id = insertArtifact(db, "claude", "deleted", PAST_8);
    const count = gcDeletedArtifacts(db, "claude", 7, NOW);
    expect(count).toBe(1);
    expect(db.prepare("SELECT id FROM agent_memory_artifacts WHERE id = ?").get(id)).toBeNull();
  });

  it("keeps artifacts soft-deleted within retention window", () => {
    const id = insertArtifact(db, "claude", "deleted", PAST_6);
    const count = gcDeletedArtifacts(db, "claude", 7, NOW);
    expect(count).toBe(0);
    expect(db.prepare("SELECT id FROM agent_memory_artifacts WHERE id = ?").get(id)).not.toBeNull();
  });

  it("does not touch active artifacts", () => {
    const id = insertArtifact(db, "claude", "active", PAST_8);
    gcDeletedArtifacts(db, "claude", 7, NOW);
    expect(db.prepare("SELECT id FROM agent_memory_artifacts WHERE id = ?").get(id)).not.toBeNull();
  });

  it("does not touch other agents' deleted artifacts", () => {
    const id = insertArtifact(db, "gemini", "deleted", PAST_8);
    gcDeletedArtifacts(db, "claude", 7, NOW);
    expect(db.prepare("SELECT id FROM agent_memory_artifacts WHERE id = ?").get(id)).not.toBeNull();
  });

  it("deletes when exactly at retention boundary", () => {
    const id = insertArtifact(db, "claude", "deleted", PAST_7);
    const count = gcDeletedArtifacts(db, "claude", 7, NOW);
    expect(count).toBe(1);
    expect(db.prepare("SELECT id FROM agent_memory_artifacts WHERE id = ?").get(id)).toBeNull();
  });
});

describe("gcDeletedCompactionItems", () => {
  let db: Database;
  beforeEach(() => { db = makeDb(); });

  it("hard-deletes items past retention window", () => {
    const id = insertCompactionItem(db, "claude", "deleted", PAST_8);
    expect(gcDeletedCompactionItems(db, "claude", 7, NOW)).toBe(1);
    expect(db.prepare("SELECT id FROM agent_memory_compaction_items WHERE id = ?").get(id)).toBeNull();
  });

  it("keeps items within retention window", () => {
    insertCompactionItem(db, "claude", "deleted", PAST_6);
    expect(gcDeletedCompactionItems(db, "claude", 7, NOW)).toBe(0);
  });
});

describe("gcExpiredFacts", () => {
  let db: Database;
  beforeEach(() => { db = makeDb(); });

  it("hard-deletes facts expired past retention window", () => {
    const id = insertFact(db, "claude", PAST_8);
    expect(gcExpiredFacts(db, "claude", 7, NOW)).toBe(1);
    expect(db.prepare("SELECT id FROM agent_memory_facts WHERE id = ?").get(id)).toBeNull();
  });

  it("keeps active facts (null valid_to)", () => {
    const id = insertFact(db, "claude", null);
    gcExpiredFacts(db, "claude", 7, NOW);
    expect(db.prepare("SELECT id FROM agent_memory_facts WHERE id = ?").get(id)).not.toBeNull();
  });

  it("keeps facts expired within retention window", () => {
    const id = insertFact(db, "claude", PAST_6);
    gcExpiredFacts(db, "claude", 7, NOW);
    expect(db.prepare("SELECT id FROM agent_memory_facts WHERE id = ?").get(id)).not.toBeNull();
  });
});

describe("gcExpiredLinks", () => {
  let db: Database;
  beforeEach(() => { db = makeDb(); });

  it("hard-deletes links expired past retention window", () => {
    const id = insertLink(db, "claude", PAST_8);
    expect(gcExpiredLinks(db, "claude", 7, NOW)).toBe(1);
    expect(db.prepare("SELECT id FROM agent_memory_links WHERE id = ?").get(id)).toBeNull();
  });

  it("keeps active links (null valid_to)", () => {
    const id = insertLink(db, "claude", null);
    gcExpiredLinks(db, "claude", 7, NOW);
    expect(db.prepare("SELECT id FROM agent_memory_links WHERE id = ?").get(id)).not.toBeNull();
  });
});

describe("gcSweep", () => {
  let db: Database;
  beforeEach(() => { db = makeDb(); });

  it("returns zero counts when nothing to delete", () => {
    const result = gcSweep(db, "claude", {}, NOW);
    expect(result.artifacts_deleted).toBe(0);
    expect(result.compaction_items_deleted).toBe(0);
    expect(result.facts_deleted).toBe(0);
    expect(result.links_deleted).toBe(0);
  });

  it("sweeps all expired entities in one call", () => {
    insertArtifact(db, "claude", "deleted", PAST_8);
    insertCompactionItem(db, "claude", "deleted", PAST_8);
    insertFact(db, "claude", PAST_8);
    insertLink(db, "claude", PAST_8);

    const result = gcSweep(db, "claude", { artifact_retention_days: 7, compaction_item_retention_days: 7, fact_retention_days: 7, link_retention_days: 7 }, NOW);
    expect(result.artifacts_deleted).toBe(1);
    expect(result.compaction_items_deleted).toBe(1);
    expect(result.facts_deleted).toBe(1);
    expect(result.links_deleted).toBe(1);
  });

  it("respects per-kind retention config", () => {
    insertArtifact(db, "claude", "deleted", PAST_6);
    insertFact(db, "claude", PAST_6);

    // artifact window: 7 days (6 days old → kept); fact window: 5 days (6 days old → swept)
    const result = gcSweep(db, "claude", { artifact_retention_days: 7, fact_retention_days: 5 }, NOW);
    expect(result.artifacts_deleted).toBe(0);
    expect(result.facts_deleted).toBe(1);
  });

  it("uses default config when not specified", () => {
    // 8-day-old artifact should be swept by default (artifact_retention_days: 7)
    insertArtifact(db, "claude", "deleted", PAST_8);
    const result = gcSweep(db, "claude", {}, NOW);
    expect(result.artifacts_deleted).toBe(1);
  });
});
