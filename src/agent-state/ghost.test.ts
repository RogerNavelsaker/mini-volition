import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { ensureSchema } from "./schema";
import { detectGhosts, markGhost, recordGhostTransition, ACTIVE_STATUSES } from "./ghost";

function makeDb(): Database {
  const db = new Database(":memory:");
  ensureSchema(db);
  return db;
}

function insertAgent(db: Database, name: string, status: string, updatedAt: string) {
  db.run(
    `INSERT INTO fleet_agent_state (agent_name, status, updated_at) VALUES (?, ?, ?)`,
    [name, status, updatedAt],
  );
}

function staleTimestamp(msAgo: number): string {
  return new Date(Date.now() - msAgo).toISOString().replace("T", " ").slice(0, 19);
}

describe("detectGhosts", () => {
  test("returns empty when no agents are stale", () => {
    const db = makeDb();
    insertAgent(db, "agent-a", "thinking", staleTimestamp(1_000));
    const ghosts = detectGhosts(db, 60_000);
    expect(ghosts).toHaveLength(0);
  });

  test("detects agent stuck in thinking past threshold", () => {
    const db = makeDb();
    insertAgent(db, "agent-a", "thinking", staleTimestamp(120_000));
    const ghosts = detectGhosts(db, 60_000);
    expect(ghosts).toHaveLength(1);
    expect(ghosts[0].agent_name).toBe("agent-a");
    expect(ghosts[0].status).toBe("thinking");
  });

  test("detects all active statuses past threshold", () => {
    const db = makeDb();
    for (const [i, status] of ACTIVE_STATUSES.entries()) {
      insertAgent(db, `agent-${i}`, status, staleTimestamp(120_000));
    }
    const ghosts = detectGhosts(db, 60_000);
    expect(ghosts).toHaveLength(ACTIVE_STATUSES.length);
  });

  test("ignores idle and failed agents", () => {
    const db = makeDb();
    insertAgent(db, "agent-idle", "idle", staleTimestamp(300_000));
    insertAgent(db, "agent-failed", "failed", staleTimestamp(300_000));
    const ghosts = detectGhosts(db, 60_000);
    expect(ghosts).toHaveLength(0);
  });

  test("reports stale_ms as approximate elapsed time", () => {
    const db = makeDb();
    insertAgent(db, "agent-a", "sleeping", staleTimestamp(120_000));
    const ghosts = detectGhosts(db, 60_000);
    expect(ghosts[0].stale_ms).toBeGreaterThan(60_000);
  });

  test("does not detect ghost-status agents again", () => {
    const db = makeDb();
    insertAgent(db, "agent-a", "ghost", staleTimestamp(300_000));
    const ghosts = detectGhosts(db, 60_000);
    expect(ghosts).toHaveLength(0);
  });
});

describe("markGhost", () => {
  test("transitions active agent to ghost status", () => {
    const db = makeDb();
    insertAgent(db, "agent-a", "thinking", staleTimestamp(120_000));
    const marked = markGhost(db, "agent-a");
    expect(marked).toBe(true);
    const row = db.prepare("SELECT status FROM fleet_agent_state WHERE agent_name = 'agent-a'").get() as { status: string };
    expect(row.status).toBe("ghost");
  });

  test("returns false for idle agent (not active)", () => {
    const db = makeDb();
    insertAgent(db, "agent-a", "idle", staleTimestamp(120_000));
    const marked = markGhost(db, "agent-a");
    expect(marked).toBe(false);
    const row = db.prepare("SELECT status FROM fleet_agent_state WHERE agent_name = 'agent-a'").get() as { status: string };
    expect(row.status).toBe("idle");
  });

  test("returns false for unknown agent", () => {
    const db = makeDb();
    const marked = markGhost(db, "no-such-agent");
    expect(marked).toBe(false);
  });

  test("records last_error with the ghost reason", () => {
    const db = makeDb();
    insertAgent(db, "agent-a", "thinking", staleTimestamp(120_000));
    markGhost(db, "agent-a", "custom reason");
    const row = db.prepare("SELECT last_error FROM fleet_agent_state WHERE agent_name = 'agent-a'").get() as { last_error: string };
    expect(row.last_error).toBe("custom reason");
  });

  test("is idempotent — marking ghost again returns false", () => {
    const db = makeDb();
    insertAgent(db, "agent-a", "thinking", staleTimestamp(120_000));
    markGhost(db, "agent-a");
    const second = markGhost(db, "agent-a");
    expect(second).toBe(false);
  });
});

describe("recordGhostTransition", () => {
  test("inserts a row into fleet_turn_journal", () => {
    const db = makeDb();
    recordGhostTransition(db, "agent-a", "process exited");
    const row = db.prepare("SELECT * FROM fleet_turn_journal WHERE agent_name = 'agent-a'").get() as any;
    expect(row).toBeTruthy();
    expect(row.wake_source).toBe("ghost_check");
    expect(row.wake_reason).toBe("ghost_detected");
    expect(row.phase).toBe("failed");
    expect(row.detail).toBe("process exited");
  });

  test("turn_key is unique per call", () => {
    const db = makeDb();
    recordGhostTransition(db, "agent-a", "r1");
    recordGhostTransition(db, "agent-a", "r2");
    const rows = db.prepare("SELECT turn_key FROM fleet_turn_journal WHERE agent_name = 'agent-a'").all() as { turn_key: string }[];
    expect(rows).toHaveLength(2);
    expect(rows[0].turn_key).not.toBe(rows[1].turn_key);
  });
});
