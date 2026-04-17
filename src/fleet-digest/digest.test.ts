import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  ensureDigestSchema,
  buildDigestRecord,
  processDigestEvent,
  pollBurstEvents,
  deadLetterSweep,
  type FleetMessage,
} from "./core";

function makeFleetDb(): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE IF NOT EXISTS fleet_event_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    agent_name TEXT,
    payload_json TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`);
  return db;
}

function makeMailDb(): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE IF NOT EXISTS fleet_comms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    layer TEXT,
    recipient TEXT,
    sender TEXT,
    body TEXT,
    read_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`);
  db.run(`CREATE TABLE IF NOT EXISTS fleet_comms_claims (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL,
    agent_name TEXT NOT NULL,
    claimed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME,
    status TEXT NOT NULL DEFAULT 'claimed'
  );`);
  return db;
}

function makeMemoryDb(): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE IF NOT EXISTS public_digests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    summary TEXT,
    actors TEXT,
    type TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  );`);
  return db;
}

function makeDigestDb(): Database {
  const db = new Database(":memory:");
  ensureDigestSchema(db);
  return db;
}

function insertMessage(mailDb: Database, sender: string, recipient: string, body: string): number {
  const result = mailDb.prepare(`INSERT INTO fleet_comms (layer, recipient, sender, body) VALUES ('direct', ?, ?, ?)`).run(recipient, sender, body);
  return Number(result.lastInsertRowid);
}

function insertEvent(fleetDb: Database, agentName: string | null, payload: object | null): number {
  const result = fleetDb.prepare(`INSERT INTO fleet_event_log (event_type, agent_name, payload_json) VALUES ('burst_flushed', ?, ?)`).run(agentName, payload ? JSON.stringify(payload) : null);
  return Number(result.lastInsertRowid);
}

describe("ensureDigestSchema", () => {
  it("creates fleet_digest_cursor table", () => {
    const db = new Database(":memory:");
    ensureDigestSchema(db);
    const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='fleet_digest_cursor'`).get();
    expect(row).not.toBeNull();
  });

  it("creates fleet_digest_journal table", () => {
    const db = new Database(":memory:");
    ensureDigestSchema(db);
    const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='fleet_digest_journal'`).get();
    expect(row).not.toBeNull();
  });
});

describe("buildDigestRecord", () => {
  it("builds summary with sender, recipient, and body preview", () => {
    const messages: FleetMessage[] = [
      { id: 1, layer: "direct", sender: "alice", recipient: "bob", body: "hello world", created_at: "" },
      { id: 2, layer: "direct", sender: "alice", recipient: "bob", body: "follow up", created_at: "" },
    ];
    const { summary, actors } = buildDigestRecord(messages);
    expect(summary).toContain("2 message(s)");
    expect(summary).toContain("alice");
    expect(summary).toContain("bob");
    expect(summary).toContain("hello world");
    expect(JSON.parse(actors)).toContain("alice");
    expect(JSON.parse(actors)).toContain("bob");
  });

  it("deduplicates actors", () => {
    const messages: FleetMessage[] = [
      { id: 1, layer: "direct", sender: "alice", recipient: "alice", body: "self-note", created_at: "" },
    ];
    const { actors } = buildDigestRecord(messages);
    const parsed = JSON.parse(actors) as string[];
    expect(parsed.filter((a) => a === "alice")).toHaveLength(1);
  });

  it("truncates body preview at 120 chars", () => {
    const longBody = "x".repeat(200);
    const messages: FleetMessage[] = [
      { id: 1, layer: "direct", sender: "a", recipient: "b", body: longBody, created_at: "" },
    ];
    const { summary } = buildDigestRecord(messages);
    expect(summary).toContain("x".repeat(120));
    expect(summary).not.toContain("x".repeat(121));
  });
});

describe("processDigestEvent", () => {
  let mailDb: Database;
  let memoryDb: Database;
  let digestDb: Database;

  beforeEach(() => {
    mailDb = makeMailDb();
    memoryDb = makeMemoryDb();
    digestDb = makeDigestDb();
  });

  it("inserts public_digest for valid event", () => {
    const msgId = insertMessage(mailDb, "sender-a", "agent-x", "hello");
    processDigestEvent(mailDb, memoryDb, digestDb, { id: 1, agent_name: "agent-x", payload_json: JSON.stringify({ message_ids: [msgId], count: 1 }) });
    const row = memoryDb.prepare(`SELECT type FROM public_digests`).get() as { type: string } | null;
    expect(row?.type).toBe("burst");
  });

  it("skips null agent_name", () => {
    processDigestEvent(mailDb, memoryDb, digestDb, { id: 1, agent_name: null, payload_json: null });
    const count = (memoryDb.prepare(`SELECT COUNT(*) AS n FROM public_digests`).get() as { n: number }).n;
    expect(count).toBe(0);
  });

  it("records failed phase for bad payload", () => {
    processDigestEvent(mailDb, memoryDb, digestDb, { id: 1, agent_name: "a", payload_json: "not-json{{{" });
    const row = digestDb.prepare(`SELECT phase FROM fleet_digest_journal`).get() as { phase: string } | null;
    expect(row?.phase).toBe("failed");
  });

  it("does nothing for empty message_ids", () => {
    processDigestEvent(mailDb, memoryDb, digestDb, { id: 1, agent_name: "a", payload_json: JSON.stringify({ message_ids: [] }) });
    const count = (memoryDb.prepare(`SELECT COUNT(*) AS n FROM public_digests`).get() as { n: number }).n;
    expect(count).toBe(0);
  });
});

describe("pollBurstEvents", () => {
  let fleetDb: Database;
  let mailDb: Database;
  let memoryDb: Database;
  let digestDb: Database;

  beforeEach(() => {
    fleetDb = makeFleetDb();
    mailDb = makeMailDb();
    memoryDb = makeMemoryDb();
    digestDb = makeDigestDb();
  });

  it("returns 0 when no events", () => {
    const count = pollBurstEvents(fleetDb, mailDb, memoryDb, digestDb);
    expect(count).toBe(0);
  });

  it("processes new events and returns count", () => {
    const msgId = insertMessage(mailDb, "alice", "agent-a", "hi");
    insertEvent(fleetDb, "agent-a", { message_ids: [msgId], count: 1 });
    const count = pollBurstEvents(fleetDb, mailDb, memoryDb, digestDb);
    expect(count).toBe(1);
  });

  it("advances cursor after processing", () => {
    insertEvent(fleetDb, "agent-a", { message_ids: [], count: 0 });
    insertEvent(fleetDb, "agent-b", { message_ids: [], count: 0 });
    pollBurstEvents(fleetDb, mailDb, memoryDb, digestDb);
    const cursor = digestDb.prepare(`SELECT last_id FROM fleet_digest_cursor WHERE event_type = 'burst_flushed'`).get() as { last_id: number };
    expect(cursor.last_id).toBe(2);
  });

  it("does not reprocess events past cursor", () => {
    const msgId = insertMessage(mailDb, "alice", "agent-a", "hi");
    insertEvent(fleetDb, "agent-a", { message_ids: [msgId], count: 1 });
    pollBurstEvents(fleetDb, mailDb, memoryDb, digestDb);
    pollBurstEvents(fleetDb, mailDb, memoryDb, digestDb);
    const count = (memoryDb.prepare(`SELECT COUNT(*) AS n FROM public_digests`).get() as { n: number }).n;
    expect(count).toBe(1);
  });

  it("creates public_digest for each valid event", () => {
    const m1 = insertMessage(mailDb, "alice", "agent-a", "msg1");
    const m2 = insertMessage(mailDb, "bob", "agent-b", "msg2");
    insertEvent(fleetDb, "agent-a", { message_ids: [m1], count: 1 });
    insertEvent(fleetDb, "agent-b", { message_ids: [m2], count: 1 });
    pollBurstEvents(fleetDb, mailDb, memoryDb, digestDb);
    const count = (memoryDb.prepare(`SELECT COUNT(*) AS n FROM public_digests`).get() as { n: number }).n;
    expect(count).toBe(2);
  });
});

describe("deadLetterSweep", () => {
  let mailDb: Database;
  let memoryDb: Database;
  let digestDb: Database;

  beforeEach(() => {
    mailDb = makeMailDb();
    memoryDb = makeMemoryDb();
    digestDb = makeDigestDb();
  });

  it("returns 0 when no recent completed claims", () => {
    const created = deadLetterSweep(mailDb, memoryDb, digestDb, 10);
    expect(created).toBe(0);
  });

  it("creates digest for agent with recent completed claims and no existing digest", () => {
    const msgId = insertMessage(mailDb, "sender", "agent-x", "dead-letter test");
    mailDb.run(
      `INSERT INTO fleet_comms_claims (message_id, agent_name, status, completed_at) VALUES (?, 'agent-x', 'completed', datetime('now'))`,
      [msgId],
    );
    const created = deadLetterSweep(mailDb, memoryDb, digestDb, 10);
    expect(created).toBe(1);
    const row = digestDb.prepare(`SELECT detail FROM fleet_digest_journal WHERE phase = 'completed'`).get() as { detail: string } | null;
    expect(row?.detail).toBe("dead_letter");
  });

  it("skips agents that already have a recent digest", () => {
    const msgId = insertMessage(mailDb, "sender", "agent-x", "already digested");
    mailDb.run(
      `INSERT INTO fleet_comms_claims (message_id, agent_name, status, completed_at) VALUES (?, 'agent-x', 'completed', datetime('now'))`,
      [msgId],
    );
    memoryDb.run(`INSERT INTO public_digests (summary, actors, type) VALUES ('existing', '[]', 'burst')`);
    const created = deadLetterSweep(mailDb, memoryDb, digestDb, 10);
    expect(created).toBe(0);
  });
});
