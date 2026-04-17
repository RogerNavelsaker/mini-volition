import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  buildLookupCacheKey,
  invalidateLookupCache,
  readLookupCache,
  resolveLookupExpiry,
  writeLookupCache,
} from "./cache";

function makeDb() {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE agent_memory_lookup_cache (
    agent_name TEXT NOT NULL,
    cache_key TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    expires_at DATETIME NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(agent_name, cache_key)
  );`);
  return db;
}

describe("lookup cache helpers", () => {
  test("normalizes lookup cache keys", () => {
    expect(buildLookupCacheKey("  hello   world  ", 3, "mix")).toBe(
      buildLookupCacheKey("hello world", 3, "mix"),
    );
  });

  test("reads only non-expired cache entries", () => {
    const db = makeDb();
    writeLookupCache(db, "codex", "k1", "{\"ok\":true}", "2099-01-01T00:00:00.000Z");
    writeLookupCache(db, "codex", "k2", "{\"stale\":true}", "2000-01-01T00:00:00.000Z");

    expect(readLookupCache(db, "codex", "k1", "2026-04-18T00:00:00.000Z")).toBe("{\"ok\":true}");
    expect(readLookupCache(db, "codex", "k2", "2026-04-18T00:00:00.000Z")).toBeNull();
  });

  test("invalidates per-agent and global cache entries", () => {
    const db = makeDb();
    writeLookupCache(db, "codex", "k1", "{\"ok\":true}", "2099-01-01T00:00:00.000Z");
    writeLookupCache(db, "claude", "k1", "{\"ok\":true}", "2099-01-01T00:00:00.000Z");

    invalidateLookupCache(db, "codex");
    expect(readLookupCache(db, "codex", "k1", "2026-04-18T00:00:00.000Z")).toBeNull();
    expect(readLookupCache(db, "claude", "k1", "2026-04-18T00:00:00.000Z")).toBe("{\"ok\":true}");

    invalidateLookupCache(db);
    expect(readLookupCache(db, "claude", "k1", "2026-04-18T00:00:00.000Z")).toBeNull();
  });

  test("caps cache expiry at the stale boundary when memory is fresh", () => {
    const now = Date.parse("2026-04-18T12:10:00.000Z");
    const expiresAt = resolveLookupExpiry(now, false, "2026-04-18T12:00:00", 900, 300);
    expect(expiresAt).toBe("2026-04-18T12:15:00.000Z");
  });

  test("uses ttl when memory is already stale", () => {
    const now = Date.parse("2026-04-18T12:10:00.000Z");
    const expiresAt = resolveLookupExpiry(now, true, "2026-04-18T11:00:00", 900, 45);
    expect(expiresAt).toBe("2026-04-18T12:10:45.000Z");
  });
});
