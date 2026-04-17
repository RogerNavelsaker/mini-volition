import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { ensureSchema } from "./schema";

function makeDb(): Database {
  const db = new Database(":memory:");
  ensureSchema(db);
  return db;
}

describe("agent_memory_prefetch_cache schema", () => {
  it("creates the prefetch cache table", () => {
    const db = makeDb();
    const row = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='agent_memory_prefetch_cache'`,
    ).get();
    expect(row).not.toBeNull();
  });

  it("has UNIQUE constraint on (agent_name, query_hash)", () => {
    const db = makeDb();
    db.run(`INSERT INTO agent_memory_prefetch_cache (agent_name, query_hash, result_json) VALUES ('a1', 'h1', '{}');`);
    expect(() =>
      db.run(`INSERT INTO agent_memory_prefetch_cache (agent_name, query_hash, result_json) VALUES ('a1', 'h1', '{}');`),
    ).toThrow();
  });
});

describe("prefetch cache round-trip", () => {
  let db: Database;

  beforeEach(() => {
    db = makeDb();
  });

  it("stores and retrieves result_json", () => {
    const payload = JSON.stringify({ recentDigests: [], episodic: [], archival: [] });
    db.run(
      `INSERT INTO agent_memory_prefetch_cache (agent_name, query_hash, result_json) VALUES ('agent-x', 'hash1', ?)`,
      [payload],
    );
    const row = db.prepare(
      `SELECT result_json FROM agent_memory_prefetch_cache WHERE agent_name = ? AND query_hash = ?`,
    ).get("agent-x", "hash1") as { result_json: string } | null;
    expect(row).not.toBeNull();
    expect(JSON.parse(row!.result_json)).toMatchObject({ recentDigests: [] });
  });

  it("INSERT OR REPLACE overwrites existing entry", () => {
    db.run(`INSERT INTO agent_memory_prefetch_cache (agent_name, query_hash, result_json) VALUES ('a', 'h', '"old"')`);
    db.run(`INSERT OR REPLACE INTO agent_memory_prefetch_cache (agent_name, query_hash, result_json) VALUES ('a', 'h', '"new"')`);
    const row = db.prepare(
      `SELECT result_json FROM agent_memory_prefetch_cache WHERE agent_name = 'a' AND query_hash = 'h'`,
    ).get() as { result_json: string } | null;
    expect(row?.result_json).toBe('"new"');
  });

  it("TTL filter excludes old entries via datetime comparison", () => {
    db.run(
      `INSERT INTO agent_memory_prefetch_cache (agent_name, query_hash, result_json, created_at)
       VALUES ('a', 'h', '{}', datetime('now', '-400 seconds'))`,
    );
    const row = db.prepare(
      `SELECT result_json FROM agent_memory_prefetch_cache
       WHERE agent_name = 'a' AND query_hash = 'h'
         AND created_at > datetime('now', '-300 seconds')`,
    ).get();
    expect(row).toBeNull();
  });

  it("TTL filter includes fresh entries", () => {
    db.run(
      `INSERT INTO agent_memory_prefetch_cache (agent_name, query_hash, result_json) VALUES ('a', 'h', '{}')`,
    );
    const row = db.prepare(
      `SELECT result_json FROM agent_memory_prefetch_cache
       WHERE agent_name = 'a' AND query_hash = 'h'
         AND created_at > datetime('now', '-300 seconds')`,
    ).get();
    expect(row).not.toBeNull();
  });
});
