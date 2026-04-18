import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  ensureSpawnSchema,
  getActiveSpawn,
  listActiveSpawns,
  recordSpawn,
  recordDespawn,
  spawnHistory,
} from "./spawn-registry";

const T = "2026-04-18T10:00:00.000Z";
const T2 = "2026-04-18T11:00:00.000Z";

function makeDb(): Database {
  const db = new Database(":memory:");
  ensureSpawnSchema(db);
  return db;
}

describe("recordSpawn", () => {
  let db: Database;
  beforeEach(() => { db = makeDb(); });

  it("inserts and returns a spawn record", () => {
    const result = recordSpawn(db, "claude", "claude-3-5", "unix:///tmp/claude.sock", null, T);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.id).toBeGreaterThan(0);
    expect(result.record.agent_name).toBe("claude");
    expect(result.record.model).toBe("claude-3-5");
    expect(result.record.socket).toBe("unix:///tmp/claude.sock");
    expect(result.record.status).toBe("active");
    expect(result.record.spawned_at).toBe(T);
    expect(result.record.despawned_at).toBeNull();
  });

  it("stores reason when provided", () => {
    const result = recordSpawn(db, "claude", "claude-3-5", "unix:///tmp/claude.sock", "initial spawn", T);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.reason).toBe("initial spawn");
  });

  it("stores null reason when not provided", () => {
    const result = recordSpawn(db, "claude", "claude-3-5", "unix:///tmp/claude.sock", null, T);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.reason).toBeNull();
  });

  it("rejects empty agent_name", () => {
    const result = recordSpawn(db, "  ", "model", "socket", null, T);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("agent_name");
  });

  it("rejects empty model", () => {
    const result = recordSpawn(db, "claude", "", "socket", null, T);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("model");
  });

  it("rejects empty socket", () => {
    const result = recordSpawn(db, "claude", "model", "   ", null, T);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("socket");
  });

  it("rejects duplicate active agent", () => {
    recordSpawn(db, "claude", "model", "socket", null, T);
    const result = recordSpawn(db, "claude", "model2", "socket2", null, T2);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("already active");
  });

  it("allows re-spawn after despawn", () => {
    recordSpawn(db, "claude", "model", "socket", null, T);
    recordDespawn(db, "claude", null, T);
    const result = recordSpawn(db, "claude", "model2", "socket2", null, T2);
    expect(result.ok).toBe(true);
  });

  it("allows different agents to spawn simultaneously", () => {
    const r1 = recordSpawn(db, "claude", "model", "socket1", null, T);
    const r2 = recordSpawn(db, "gemini", "model", "socket2", null, T);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
  });
});

describe("recordDespawn", () => {
  let db: Database;
  beforeEach(() => { db = makeDb(); });

  it("despawns an active agent", () => {
    recordSpawn(db, "claude", "model", "socket", null, T);
    const result = recordDespawn(db, "claude", "shutdown", T2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.status).toBe("despawned");
    expect(result.record.despawned_at).toBe(T2);
    expect(result.record.reason).toBe("shutdown");
  });

  it("rejects despawn of unknown agent", () => {
    const result = recordDespawn(db, "unknown", null, T);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("not active");
  });

  it("rejects despawn of already-despawned agent", () => {
    recordSpawn(db, "claude", "model", "socket", null, T);
    recordDespawn(db, "claude", null, T);
    const result = recordDespawn(db, "claude", null, T2);
    expect(result.ok).toBe(false);
  });
});

describe("getActiveSpawn", () => {
  let db: Database;
  beforeEach(() => { db = makeDb(); });

  it("returns null for unknown agent", () => {
    expect(getActiveSpawn(db, "claude")).toBeNull();
  });

  it("returns the active record", () => {
    recordSpawn(db, "claude", "model", "socket", null, T);
    const record = getActiveSpawn(db, "claude");
    expect(record).not.toBeNull();
    expect(record?.agent_name).toBe("claude");
    expect(record?.status).toBe("active");
  });

  it("returns null after despawn", () => {
    recordSpawn(db, "claude", "model", "socket", null, T);
    recordDespawn(db, "claude", null, T2);
    expect(getActiveSpawn(db, "claude")).toBeNull();
  });
});

describe("listActiveSpawns", () => {
  let db: Database;
  beforeEach(() => { db = makeDb(); });

  it("returns empty list when no agents", () => {
    expect(listActiveSpawns(db)).toHaveLength(0);
  });

  it("returns all active agents", () => {
    recordSpawn(db, "claude", "m1", "s1", null, T);
    recordSpawn(db, "gemini", "m2", "s2", null, T);
    const list = listActiveSpawns(db);
    expect(list).toHaveLength(2);
    expect(list.map((r) => r.agent_name).sort()).toEqual(["claude", "gemini"]);
  });

  it("excludes despawned agents", () => {
    recordSpawn(db, "claude", "m1", "s1", null, T);
    recordSpawn(db, "gemini", "m2", "s2", null, T);
    recordDespawn(db, "claude", null, T2);
    const list = listActiveSpawns(db);
    expect(list).toHaveLength(1);
    expect(list[0].agent_name).toBe("gemini");
  });

  it("orders by spawned_at ascending", () => {
    recordSpawn(db, "gemini", "m", "s2", null, T2);
    recordSpawn(db, "claude", "m", "s1", null, T);
    const list = listActiveSpawns(db);
    expect(list[0].agent_name).toBe("claude");
    expect(list[1].agent_name).toBe("gemini");
  });
});

describe("spawnHistory", () => {
  let db: Database;
  beforeEach(() => { db = makeDb(); });

  it("returns empty for unknown agent", () => {
    expect(spawnHistory(db, "claude")).toHaveLength(0);
  });

  it("returns all records for an agent", () => {
    recordSpawn(db, "claude", "m", "s", null, T);
    recordDespawn(db, "claude", null, T2);
    recordSpawn(db, "claude", "m2", "s2", null, T2);
    const history = spawnHistory(db, "claude");
    expect(history).toHaveLength(2);
  });

  it("does not include other agents", () => {
    recordSpawn(db, "claude", "m", "s1", null, T);
    recordSpawn(db, "gemini", "m", "s2", null, T);
    const history = spawnHistory(db, "claude");
    expect(history).toHaveLength(1);
    expect(history[0].agent_name).toBe("claude");
  });

  it("orders by spawned_at ascending", () => {
    recordSpawn(db, "claude", "m", "s", null, T);
    recordDespawn(db, "claude", null, T2);
    recordSpawn(db, "claude", "m2", "s2", null, T2);
    const history = spawnHistory(db, "claude");
    expect(history[0].spawned_at).toBe(T);
    expect(history[1].spawned_at).toBe(T2);
  });
});
