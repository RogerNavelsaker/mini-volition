import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { ensureAuditSchema, appendAuditLog, queryAuditLog, verifyAuditChain } from "./audit-log";

function makeDb(): Database {
  const db = new Database(":memory:");
  ensureAuditSchema(db);
  return db;
}

const T = "2026-04-18T10:00:00.000Z";

describe("appendAuditLog", () => {
  let db: Database;
  beforeEach(() => { db = makeDb(); });

  it("inserts and returns an entry", () => {
    const entry = appendAuditLog(db, "fleet", "start", "session/main", "ok", null, T);
    expect(entry.id).toBeGreaterThan(0);
    expect(entry.seq).toBe(1);
    expect(entry.actor).toBe("fleet");
    expect(entry.action).toBe("start");
    expect(entry.resource).toBe("session/main");
    expect(entry.result).toBe("ok");
  });

  it("sets prev_hash=null for the first entry", () => {
    const entry = appendAuditLog(db, "fleet", "start", "session", "ok", null, T);
    expect(entry.prev_hash).toBeNull();
  });

  it("chains entries: second entry prev_hash = first entry hash", () => {
    const e1 = appendAuditLog(db, "fleet", "start", "session", "ok", null, T);
    const e2 = appendAuditLog(db, "fleet", "stop", "session", "ok", null, T);
    expect(e2.prev_hash).toBe(e1.entry_hash);
  });

  it("assigns monotonically increasing seq", () => {
    const e1 = appendAuditLog(db, "a", "x", "r", "ok", null, T);
    const e2 = appendAuditLog(db, "a", "y", "r", "ok", null, T);
    const e3 = appendAuditLog(db, "a", "z", "r", "ok", null, T);
    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(2);
    expect(e3.seq).toBe(3);
  });

  it("stores meta as JSON string when provided", () => {
    const entry = appendAuditLog(db, "fleet", "bump", "governor/claude", "allowed", { turns: 3 }, T);
    expect(entry.meta).toBe(JSON.stringify({ turns: 3 }));
  });

  it("stores meta=null when not provided", () => {
    const entry = appendAuditLog(db, "fleet", "start", "session", "ok", null, T);
    expect(entry.meta).toBeNull();
  });

  it("computes a non-empty entry_hash", () => {
    const entry = appendAuditLog(db, "fleet", "start", "session", "ok", null, T);
    expect(typeof entry.entry_hash).toBe("string");
    expect(entry.entry_hash.length).toBeGreaterThan(0);
  });

  it("different entries produce different hashes", () => {
    const e1 = appendAuditLog(db, "fleet", "start", "session", "ok", null, T);
    const e2 = appendAuditLog(db, "fleet", "stop", "session", "ok", null, T);
    expect(e1.entry_hash).not.toBe(e2.entry_hash);
  });
});

describe("queryAuditLog", () => {
  let db: Database;
  beforeEach(() => {
    db = makeDb();
    appendAuditLog(db, "fleet", "start", "session/main", "ok", null, T);
    appendAuditLog(db, "claude", "turn", "agent/claude", "ok", null, T);
    appendAuditLog(db, "fleet", "bump", "governor/claude", "allowed", null, T);
    appendAuditLog(db, "gemini", "turn", "agent/gemini", "ok", null, T);
  });

  it("returns all entries when no filter", () => {
    expect(queryAuditLog(db)).toHaveLength(4);
  });

  it("filters by actor", () => {
    const results = queryAuditLog(db, { actor: "fleet" });
    expect(results).toHaveLength(2);
    expect(results.every((e) => e.actor === "fleet")).toBe(true);
  });

  it("filters by action", () => {
    const results = queryAuditLog(db, { action: "turn" });
    expect(results).toHaveLength(2);
  });

  it("filters by resource", () => {
    const results = queryAuditLog(db, { resource: "agent/claude" });
    expect(results).toHaveLength(1);
    expect(results[0].actor).toBe("claude");
  });

  it("filters by since_id", () => {
    const all = queryAuditLog(db);
    const afterFirst = queryAuditLog(db, { since_id: all[0].id });
    expect(afterFirst).toHaveLength(3);
  });

  it("respects limit", () => {
    const results = queryAuditLog(db, { limit: 2 });
    expect(results).toHaveLength(2);
  });

  it("returns entries ordered by seq ascending", () => {
    const results = queryAuditLog(db);
    for (let i = 1; i < results.length; i++) {
      expect(results[i].seq).toBeGreaterThan(results[i - 1].seq);
    }
  });

  it("returns empty when no match", () => {
    expect(queryAuditLog(db, { actor: "unknown" })).toHaveLength(0);
  });
});

describe("verifyAuditChain", () => {
  let db: Database;
  beforeEach(() => { db = makeDb(); });

  it("returns ok=true with empty log", () => {
    const result = verifyAuditChain(db);
    expect(result.ok).toBe(true);
    expect(result.checked).toBe(0);
    expect(result.first_broken_seq).toBeNull();
  });

  it("returns ok=true for valid chain", () => {
    appendAuditLog(db, "fleet", "start", "session", "ok", null, T);
    appendAuditLog(db, "fleet", "stop", "session", "ok", null, T);
    const result = verifyAuditChain(db);
    expect(result.ok).toBe(true);
    expect(result.checked).toBe(2);
  });

  it("detects a tampered entry_hash", () => {
    appendAuditLog(db, "fleet", "start", "session", "ok", null, T);
    appendAuditLog(db, "fleet", "stop", "session", "ok", null, T);
    db.prepare("UPDATE fleet_audit_log SET entry_hash = 'tampered0000' WHERE seq = 1").run();
    const result = verifyAuditChain(db);
    expect(result.ok).toBe(false);
    expect(result.first_broken_seq).toBe(1);
  });

  it("detects a tampered result field", () => {
    appendAuditLog(db, "fleet", "start", "session", "ok", null, T);
    db.prepare("UPDATE fleet_audit_log SET result = 'modified' WHERE seq = 1").run();
    const result = verifyAuditChain(db);
    expect(result.ok).toBe(false);
    expect(result.first_broken_seq).toBe(1);
  });

  it("stops at first broken seq", () => {
    appendAuditLog(db, "fleet", "a", "r", "ok", null, T);
    appendAuditLog(db, "fleet", "b", "r", "ok", null, T);
    appendAuditLog(db, "fleet", "c", "r", "ok", null, T);
    db.prepare("UPDATE fleet_audit_log SET entry_hash = 'bad' WHERE seq = 2").run();
    const result = verifyAuditChain(db);
    expect(result.first_broken_seq).toBe(2);
    expect(result.checked).toBe(1);
  });
});
