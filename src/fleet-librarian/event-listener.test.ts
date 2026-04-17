import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { ensureLibrarianSchema, pollBurstFlushEvents, recordMaintenance } from "./maintenance";

function makeLibrarianDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL;");
  return db;
}

function makeFleetDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL;");
  db.run(`CREATE TABLE IF NOT EXISTS fleet_event_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    agent_name TEXT,
    payload_json TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`);
  return db;
}

function makeJobsDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL;");
  db.run(`CREATE TABLE IF NOT EXISTS fleet_internal_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_agent TEXT NOT NULL,
    sender TEXT NOT NULL,
    body TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'normal',
    status TEXT NOT NULL DEFAULT 'queued',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`);
  return db;
}

function insertEvent(fleetDb: Database, eventType: string, agentName: string | null, payload: string | null = null) {
  return fleetDb.prepare(
    `INSERT INTO fleet_event_log (event_type, agent_name, payload_json) VALUES (?, ?, ?)`,
  ).run(eventType, agentName, payload);
}

function noopJobsBin(_agent: string, _body: string) {}

describe("ensureLibrarianSchema — fleet_event_listener_cursor", () => {
  it("creates the cursor table", () => {
    const memDb = new Database(":memory:");
    const libDb = makeLibrarianDb();
    ensureLibrarianSchema(memDb, libDb);
    const row = libDb.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='fleet_event_listener_cursor'`).get();
    expect(row).not.toBeNull();
  });
});

describe("pollBurstFlushEvents", () => {
  let fleetDb: Database;
  let librarianDb: Database;
  let jobsDb: Database;
  const queuedJobs: Array<{ agent: string; body: string }> = [];

  beforeEach(() => {
    fleetDb = makeFleetDb();
    librarianDb = makeLibrarianDb();
    jobsDb = makeJobsDb();
    queuedJobs.length = 0;

    const memDb = new Database(":memory:");
    ensureLibrarianSchema(memDb, librarianDb);
  });

  function poll() {
    pollBurstFlushEvents(fleetDb, librarianDb, jobsDb, "/bin/true");
  }

  it("does nothing when no burst_flushed events exist", () => {
    poll();
    const cursor = librarianDb.prepare(`SELECT last_id FROM fleet_event_listener_cursor WHERE event_type = 'burst_flushed'`).get();
    expect(cursor).toBeNull();
  });

  it("advances cursor after processing events", () => {
    insertEvent(fleetDb, "burst_flushed", "agent-a");
    insertEvent(fleetDb, "burst_flushed", "agent-b");
    poll();
    const cursor = librarianDb.prepare(`SELECT last_id FROM fleet_event_listener_cursor WHERE event_type = 'burst_flushed'`).get() as { last_id: number } | null;
    expect(cursor).not.toBeNull();
    expect(cursor!.last_id).toBe(2);
  });

  it("does not re-process events already past the cursor", () => {
    insertEvent(fleetDb, "burst_flushed", "agent-a");
    poll();
    const journalBefore = (librarianDb.prepare(`SELECT COUNT(*) AS n FROM fleet_maintenance_journal`).get() as { n: number }).n;

    // Second poll — no new events
    poll();
    const journalAfter = (librarianDb.prepare(`SELECT COUNT(*) AS n FROM fleet_maintenance_journal`).get() as { n: number }).n;
    expect(journalAfter).toBe(journalBefore);
  });

  it("skips events with null agent_name", () => {
    insertEvent(fleetDb, "burst_flushed", null);
    poll();
    const cursor = librarianDb.prepare(`SELECT last_id FROM fleet_event_listener_cursor WHERE event_type = 'burst_flushed'`).get() as { last_id: number } | null;
    expect(cursor!.last_id).toBe(1);
    const journal = (librarianDb.prepare(`SELECT COUNT(*) AS n FROM fleet_maintenance_journal`).get() as { n: number }).n;
    expect(journal).toBe(0);
  });

  it("records digest queued in maintenance journal", () => {
    insertEvent(fleetDb, "burst_flushed", "agent-x", JSON.stringify({ message_ids: [1, 2], count: 2 }));
    poll();
    const row = librarianDb.prepare(
      `SELECT task, phase, detail FROM fleet_maintenance_journal WHERE agent_name = 'agent-x'`,
    ).get() as { task: string; phase: string; detail: string } | null;
    expect(row).not.toBeNull();
    expect(row!.task).toBe("digest");
    expect(row!.phase).toBe("queued");
    expect(row!.detail).toMatch(/^event:\d+$/);
  });

  it("ignores non-burst_flushed events", () => {
    insertEvent(fleetDb, "agent_started", "agent-a");
    poll();
    const cursor = librarianDb.prepare(`SELECT last_id FROM fleet_event_listener_cursor WHERE event_type = 'burst_flushed'`).get();
    expect(cursor).toBeNull();
  });

  it("processes only new events on subsequent polls", () => {
    insertEvent(fleetDb, "burst_flushed", "agent-a");
    poll();
    const countAfterFirst = (librarianDb.prepare(`SELECT COUNT(*) AS n FROM fleet_maintenance_journal`).get() as { n: number }).n;

    insertEvent(fleetDb, "burst_flushed", "agent-b");
    poll();
    const rows = librarianDb.prepare(`SELECT agent_name FROM fleet_maintenance_journal WHERE task = 'digest'`).all() as Array<{ agent_name: string }>;
    const agents = rows.map((r) => r.agent_name);
    expect(agents).toContain("agent-b");
  });
});
