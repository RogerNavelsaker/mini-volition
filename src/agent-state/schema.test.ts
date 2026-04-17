import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { ensureSchema } from "./schema";

function makeDb(): Database {
  const db = new Database(":memory:");
  ensureSchema(db);
  return db;
}

describe("ensureSchema", () => {
  test("is idempotent — safe to call multiple times", () => {
    const db = new Database(":memory:");
    expect(() => {
      ensureSchema(db);
      ensureSchema(db);
      ensureSchema(db);
    }).not.toThrow();
  });

  test("creates fleet_agent_state table", () => {
    const db = makeDb();
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='fleet_agent_state'").get();
    expect(row).toBeTruthy();
  });

  test("creates fleet_agent_action_journal table", () => {
    const db = makeDb();
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='fleet_agent_action_journal'").get();
    expect(row).toBeTruthy();
  });

  test("creates fleet_turn_journal table", () => {
    const db = makeDb();
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='fleet_turn_journal'").get();
    expect(row).toBeTruthy();
  });

  test("creates fleet_turn_checkpoints table", () => {
    const db = makeDb();
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='fleet_turn_checkpoints'").get();
    expect(row).toBeTruthy();
  });

  test("fleet_agent_state: agent_name is primary key", () => {
    const db = makeDb();
    db.run("INSERT INTO fleet_agent_state (agent_name, status) VALUES ('agent-a', 'idle')");
    expect(() =>
      db.run("INSERT INTO fleet_agent_state (agent_name, status) VALUES ('agent-a', 'thinking')")
    ).toThrow();
  });

  test("fleet_agent_state: upsert updates existing row", () => {
    const db = makeDb();
    db.run("INSERT INTO fleet_agent_state (agent_name, status) VALUES ('agent-a', 'idle')");
    db.run(
      "INSERT INTO fleet_agent_state (agent_name, status) VALUES ('agent-a', 'thinking') ON CONFLICT(agent_name) DO UPDATE SET status = excluded.status"
    );
    const row = db.prepare("SELECT status FROM fleet_agent_state WHERE agent_name = 'agent-a'").get() as { status: string };
    expect(row.status).toBe("thinking");
  });

  test("fleet_agent_action_journal: replay_disposition defaults to manual_review", () => {
    const db = makeDb();
    db.run(
      "INSERT INTO fleet_agent_action_journal (agent_name, action_index, action_type, phase) VALUES ('agent-a', 0, 'reply', 'completed')"
    );
    const row = db.prepare("SELECT replay_disposition FROM fleet_agent_action_journal WHERE agent_name = 'agent-a'").get() as { replay_disposition: string };
    expect(row.replay_disposition).toBe("manual_review");
  });

  test("fleet_turn_journal: accepts phase values", () => {
    const db = makeDb();
    const phases = ["started", "completed", "failed", "rate_limited", "interrupted_recovered", "interrupted_manual_review"];
    for (const phase of phases) {
      db.run(
        "INSERT INTO fleet_turn_journal (agent_name, turn_key, wake_source, wake_reason, phase) VALUES (?, ?, 'internal_job', 'test', ?)",
        ["agent-a", `key-${phase}`, phase]
      );
    }
    const count = (db.prepare("SELECT COUNT(*) as cnt FROM fleet_turn_journal").get() as { cnt: number }).cnt;
    expect(count).toBe(phases.length);
  });

  test("fleet_turn_checkpoints: UNIQUE(agent_name, turn_key) enforced", () => {
    const db = makeDb();
    const insert = () => db.run(
      `INSERT INTO fleet_turn_checkpoints
       (agent_name, turn_key, wake_source, wake_reason, wake_class, wake_priority, sender, layer, burst_count, envelope_status)
       VALUES ('agent-a', 'key-1', 'internal_job', 'test', 'workload', 50, 'scheduler', 'internal', 1, 'prompt_built')`
    );
    insert();
    expect(insert).toThrow();
  });

  test("fleet_turn_checkpoints: prompt_chars defaults to 0", () => {
    const db = makeDb();
    db.run(
      `INSERT INTO fleet_turn_checkpoints
       (agent_name, turn_key, wake_source, wake_reason, wake_class, wake_priority, sender, layer, burst_count, envelope_status)
       VALUES ('agent-a', 'key-1', 'internal_job', 'test', 'workload', 50, 'scheduler', 'internal', 1, 'prompt_built')`
    );
    const row = db.prepare("SELECT prompt_chars FROM fleet_turn_checkpoints WHERE turn_key = 'key-1'").get() as { prompt_chars: number };
    expect(row.prompt_chars).toBe(0);
  });
});
