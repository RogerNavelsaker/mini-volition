import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";

function makeDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL;");
  db.run(`CREATE TABLE IF NOT EXISTS fleet_governor (
    agent_name TEXT PRIMARY KEY,
    window_started_at DATETIME,
    turn_count INTEGER DEFAULT 0,
    forced_cooldown_until DATETIME,
    last_reason TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`);
  db.run(`CREATE TABLE IF NOT EXISTS fleet_event_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    agent_name TEXT,
    payload_json TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`);
  return db;
}

function insert(db: Database, eventType: string, agentName: string | null, payload: string | null) {
  return db.prepare(
    `INSERT INTO fleet_event_log (event_type, agent_name, payload_json) VALUES (?, ?, ?)`,
  ).run(eventType, agentName, payload);
}

describe("fleet_event_log schema", () => {
  it("creates the event log table", () => {
    const db = makeDb();
    const row = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='fleet_event_log'`,
    ).get();
    expect(row).not.toBeNull();
  });

  it("autoincrement id increases with each insert", () => {
    const db = makeDb();
    const r1 = insert(db, "agent_started", "a", null);
    const r2 = insert(db, "agent_stopped", "a", null);
    expect(Number(r2.lastInsertRowid)).toBeGreaterThan(Number(r1.lastInsertRowid));
  });
});

describe("fleet_event_log append-only semantics", () => {
  let db: Database;

  beforeEach(() => { db = makeDb(); });

  it("appends events in insertion order", () => {
    insert(db, "turn_started", "agent-a", null);
    insert(db, "turn_completed", "agent-a", null);
    const rows = db.prepare(
      `SELECT event_type FROM fleet_event_log ORDER BY id ASC`,
    ).all() as Array<{ event_type: string }>;
    expect(rows.map((r) => r.event_type)).toEqual(["turn_started", "turn_completed"]);
  });

  it("stores payload_json intact", () => {
    const payload = JSON.stringify({ from: "idle", to: "thinking" });
    insert(db, "state_transition", "agent-b", payload);
    const row = db.prepare(
      `SELECT payload_json FROM fleet_event_log WHERE event_type = 'state_transition'`,
    ).get() as { payload_json: string } | null;
    expect(row).not.toBeNull();
    expect(JSON.parse(row!.payload_json)).toMatchObject({ from: "idle", to: "thinking" });
  });

  it("filters by agent_name correctly", () => {
    insert(db, "ev", "agent-x", null);
    insert(db, "ev", "agent-y", null);
    insert(db, "ev", "agent-x", null);
    const rows = db.prepare(
      `SELECT id FROM fleet_event_log WHERE agent_name = 'agent-x' ORDER BY id DESC LIMIT 20`,
    ).all();
    expect(rows).toHaveLength(2);
  });

  it("allows null agent_name for fleet-level events", () => {
    insert(db, "fleet_started", null, null);
    const row = db.prepare(`SELECT agent_name FROM fleet_event_log`).get() as { agent_name: string | null };
    expect(row.agent_name).toBeNull();
  });

  it("preserves all rows — no silent DELETE or UPDATE path", () => {
    for (let i = 0; i < 5; i++) insert(db, "ping", "a", null);
    const count = (db.prepare(`SELECT COUNT(*) AS n FROM fleet_event_log`).get() as { n: number }).n;
    expect(count).toBe(5);
  });

  it("burst_flushed payload stores message_ids and count", () => {
    const payload = JSON.stringify({ message_ids: [1, 2, 3], count: 3 });
    insert(db, "burst_flushed", "agent-a", payload);
    const row = db.prepare(
      `SELECT payload_json FROM fleet_event_log WHERE event_type = 'burst_flushed'`,
    ).get() as { payload_json: string } | null;
    expect(row).not.toBeNull();
    const parsed = JSON.parse(row!.payload_json);
    expect(parsed.message_ids).toEqual([1, 2, 3]);
    expect(parsed.count).toBe(3);
  });
});
