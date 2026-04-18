import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";

function makeDb(): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE IF NOT EXISTS fleet_governor (
    agent_name TEXT PRIMARY KEY,
    window_started_at DATETIME,
    turn_count INTEGER DEFAULT 0,
    forced_cooldown_until DATETIME,
    last_reason TEXT,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    urgent_preempt INTEGER NOT NULL DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`);
  db.run(`CREATE TABLE IF NOT EXISTS fleet_escalation_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_name TEXT NOT NULL,
    reason TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`);
  return db;
}

function isoAfterSeconds(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function recordEscalation(db: Database, agent: string, threshold: number, cooldownSec: number, reason: string | null) {
  db.prepare(`INSERT INTO fleet_escalation_log (agent_name, reason) VALUES (?, ?)`).run(agent, reason ?? null);
  const windowStart = new Date(Date.now() - cooldownSec * 1000).toISOString();
  const row = db.prepare(`SELECT COUNT(*) as cnt FROM fleet_escalation_log WHERE agent_name = ? AND datetime(created_at) >= datetime(?)`).get(agent, windowStart) as { cnt: number };
  const count = row?.cnt ?? 1;
  const shouldCooldown = count >= threshold;
  const cooldownUntil = shouldCooldown ? isoAfterSeconds(cooldownSec) : null;
  if (shouldCooldown) {
    db.prepare(
      `INSERT INTO fleet_governor (agent_name, window_started_at, turn_count, forced_cooldown_until, last_reason, updated_at)
       VALUES (?, CURRENT_TIMESTAMP, 0, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(agent_name) DO UPDATE SET
         forced_cooldown_until = excluded.forced_cooldown_until,
         last_reason = excluded.last_reason,
         updated_at = CURRENT_TIMESTAMP`,
    ).run(agent, cooldownUntil, reason ?? "escalation threshold reached");
  }
  return { agent_name: agent, escalation_count: count, threshold, cooled_down: shouldCooldown, cooldown_until: cooldownUntil };
}

function escalationStatus(db: Database, agent: string, windowSec: number) {
  const windowStart = new Date(Date.now() - windowSec * 1000).toISOString();
  const row = db.prepare(`SELECT COUNT(*) as cnt FROM fleet_escalation_log WHERE agent_name = ? AND datetime(created_at) >= datetime(?)`).get(agent, windowStart) as { cnt: number };
  const count = row?.cnt ?? 0;
  const latest = db.prepare(`SELECT reason, created_at FROM fleet_escalation_log WHERE agent_name = ? ORDER BY id DESC LIMIT 1`).get(agent) as { reason: string | null; created_at: string } | null;
  return {
    agent_name: agent,
    escalation_count: count,
    window_sec: windowSec,
    latest_reason: latest?.reason ?? null,
    latest_at: latest?.created_at ?? null,
  };
}

function getGovernorRow(db: Database, agent: string): any {
  return db.prepare("SELECT * FROM fleet_governor WHERE agent_name = ?").get(agent);
}

describe("fleet_escalation_log schema", () => {
  it("creates the escalation log table", () => {
    const db = makeDb();
    db.prepare("INSERT INTO fleet_escalation_log (agent_name, reason) VALUES (?, ?)").run("agent-a", "test");
    const row = db.prepare("SELECT * FROM fleet_escalation_log WHERE agent_name = ?").get("agent-a") as any;
    expect(row).not.toBeNull();
    expect(row.agent_name).toBe("agent-a");
    expect(row.reason).toBe("test");
  });

  it("autoincrement id increases with each insert", () => {
    const db = makeDb();
    db.prepare("INSERT INTO fleet_escalation_log (agent_name) VALUES (?)").run("agent-a");
    db.prepare("INSERT INTO fleet_escalation_log (agent_name) VALUES (?)").run("agent-a");
    const rows = db.prepare("SELECT id FROM fleet_escalation_log ORDER BY id ASC").all() as any[];
    expect(rows[1].id).toBeGreaterThan(rows[0].id);
  });

  it("allows null reason", () => {
    const db = makeDb();
    db.prepare("INSERT INTO fleet_escalation_log (agent_name, reason) VALUES (?, ?)").run("agent-b", null);
    const row = db.prepare("SELECT * FROM fleet_escalation_log WHERE agent_name = ?").get("agent-b") as any;
    expect(row.reason).toBeNull();
  });
});

describe("recordEscalation", () => {
  it("returns escalation_count of 1 on first escalation", () => {
    const db = makeDb();
    const result = recordEscalation(db, "agent-a", 3, 300, "bad output");
    expect(result.escalation_count).toBe(1);
  });

  it("accumulates count across calls", () => {
    const db = makeDb();
    recordEscalation(db, "agent-a", 3, 300, "first");
    const result = recordEscalation(db, "agent-a", 3, 300, "second");
    expect(result.escalation_count).toBe(2);
  });

  it("does not cooldown below threshold", () => {
    const db = makeDb();
    const result = recordEscalation(db, "agent-a", 3, 300, "first");
    expect(result.cooled_down).toBe(false);
    expect(result.cooldown_until).toBeNull();
  });

  it("triggers cooldown when threshold is reached", () => {
    const db = makeDb();
    recordEscalation(db, "agent-a", 3, 300, null);
    recordEscalation(db, "agent-a", 3, 300, null);
    const result = recordEscalation(db, "agent-a", 3, 300, "final");
    expect(result.cooled_down).toBe(true);
    expect(result.cooldown_until).not.toBeNull();
  });

  it("cooldown_until is in the future when cooled", () => {
    const db = makeDb();
    recordEscalation(db, "agent-a", 1, 300, null);
    const result = recordEscalation(db, "agent-a", 1, 300, null);
    const now = Date.now();
    const until = new Date(result.cooldown_until!).getTime();
    expect(until).toBeGreaterThan(now);
  });

  it("threshold=1 cools on first escalation", () => {
    const db = makeDb();
    const result = recordEscalation(db, "agent-a", 1, 60, "immediate");
    expect(result.cooled_down).toBe(true);
    expect(result.escalation_count).toBe(1);
  });

  it("sets forced_cooldown_until in fleet_governor when threshold reached", () => {
    const db = makeDb();
    recordEscalation(db, "agent-a", 2, 300, null);
    recordEscalation(db, "agent-a", 2, 300, "over limit");
    const row = getGovernorRow(db, "agent-a");
    expect(row).not.toBeNull();
    expect(row.forced_cooldown_until).not.toBeNull();
  });

  it("does not touch fleet_governor when below threshold", () => {
    const db = makeDb();
    recordEscalation(db, "agent-a", 5, 300, null);
    const row = getGovernorRow(db, "agent-a");
    expect(row).toBeNull();
  });

  it("does not count escalations from other agents", () => {
    const db = makeDb();
    recordEscalation(db, "agent-a", 3, 300, null);
    recordEscalation(db, "agent-a", 3, 300, null);
    const result = recordEscalation(db, "agent-b", 3, 300, null);
    expect(result.escalation_count).toBe(1);
    expect(result.cooled_down).toBe(false);
  });
});

describe("escalationStatus", () => {
  it("returns escalation_count 0 for unknown agent", () => {
    const db = makeDb();
    const status = escalationStatus(db, "agent-z", 300);
    expect(status.escalation_count).toBe(0);
    expect(status.latest_reason).toBeNull();
  });

  it("counts escalations within window", () => {
    const db = makeDb();
    recordEscalation(db, "agent-a", 10, 300, "a");
    recordEscalation(db, "agent-a", 10, 300, "b");
    const status = escalationStatus(db, "agent-a", 300);
    expect(status.escalation_count).toBe(2);
  });

  it("returns latest reason", () => {
    const db = makeDb();
    recordEscalation(db, "agent-a", 10, 300, "first");
    recordEscalation(db, "agent-a", 10, 300, "last");
    const status = escalationStatus(db, "agent-a", 300);
    expect(status.latest_reason).toBe("last");
  });

  it("returns window_sec in response", () => {
    const db = makeDb();
    const status = escalationStatus(db, "agent-a", 600);
    expect(status.window_sec).toBe(600);
  });
});
