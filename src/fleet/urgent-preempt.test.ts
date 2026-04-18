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
  return db;
}

function isoAfterSeconds(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function isoPastSeconds(seconds: number): string {
  return new Date(Date.now() - seconds * 1000).toISOString();
}

function setUrgentPreempt(db: Database, agent: string) {
  db.prepare(
    `INSERT INTO fleet_governor (agent_name, window_started_at, turn_count, urgent_preempt, updated_at)
     VALUES (?, CURRENT_TIMESTAMP, 0, 1, CURRENT_TIMESTAMP)
     ON CONFLICT(agent_name) DO UPDATE SET
       urgent_preempt = 1,
       updated_at = CURRENT_TIMESTAMP`,
  ).run(agent);
  return { agent_name: agent, urgent_preempt: true };
}

function governorStatus(db: Database, agent: string, windowSec: number, turnLimit: number) {
  const rec = db.prepare("SELECT * FROM fleet_governor WHERE agent_name = ?").get(agent) as any ?? null;
  const now = Date.now();
  const cooldownUntilMs = rec?.forced_cooldown_until
    ? new Date(rec.forced_cooldown_until.endsWith("Z") ? rec.forced_cooldown_until : `${rec.forced_cooldown_until}Z`).getTime()
    : 0;
  const inCooldown = cooldownUntilMs > now;
  const windowStartedMs = rec?.window_started_at
    ? new Date(rec.window_started_at.endsWith("Z") ? rec.window_started_at : `${rec.window_started_at}Z`).getTime()
    : 0;
  const windowExpired = !windowStartedMs || (now - windowStartedMs) > windowSec * 1000;

  if (windowExpired && rec) {
    db.prepare(
      "UPDATE fleet_governor SET window_started_at = CURRENT_TIMESTAMP, turn_count = 0, forced_cooldown_until = NULL, updated_at = CURRENT_TIMESTAMP WHERE agent_name = ?",
    ).run(agent);
  }

  const urgentPreempt = (rec?.urgent_preempt ?? 0) === 1;
  if (urgentPreempt && inCooldown) {
    db.prepare(
      "UPDATE fleet_governor SET urgent_preempt = 0, updated_at = CURRENT_TIMESTAMP WHERE agent_name = ?",
    ).run(agent);
  }

  const current = db.prepare("SELECT * FROM fleet_governor WHERE agent_name = ?").get(agent) as any ?? null;
  return {
    allowed: !inCooldown || urgentPreempt,
    urgent_preempt: urgentPreempt,
    turn_count: current?.turn_count ?? 0,
    turn_limit: turnLimit,
    window_sec: windowSec,
    window_started_at: current?.window_started_at ?? null,
    forced_cooldown_until: current?.forced_cooldown_until ?? null,
    last_reason: current?.last_reason ?? null,
  };
}

function getRow(db: Database, agent: string): any {
  return db.prepare("SELECT * FROM fleet_governor WHERE agent_name = ?").get(agent);
}

describe("fleet_governor — urgent_preempt column", () => {
  it("defaults to 0 on new row", () => {
    const db = makeDb();
    db.prepare("INSERT INTO fleet_governor (agent_name) VALUES (?)").run("agent-x");
    expect(getRow(db, "agent-x").urgent_preempt).toBe(0);
  });

  it("setUrgentPreempt sets flag to 1", () => {
    const db = makeDb();
    setUrgentPreempt(db, "agent-a");
    expect(getRow(db, "agent-a").urgent_preempt).toBe(1);
  });

  it("setUrgentPreempt returns { urgent_preempt: true }", () => {
    const db = makeDb();
    const result = setUrgentPreempt(db, "agent-a");
    expect(result.urgent_preempt).toBe(true);
  });

  it("setUrgentPreempt on existing row updates flag without resetting turn_count", () => {
    const db = makeDb();
    db.prepare(
      "INSERT INTO fleet_governor (agent_name, turn_count, urgent_preempt) VALUES (?, 3, 0)",
    ).run("agent-b");
    setUrgentPreempt(db, "agent-b");
    const row = getRow(db, "agent-b");
    expect(row.urgent_preempt).toBe(1);
    expect(row.turn_count).toBe(3);
  });
});

describe("governorStatus — urgent preemption behavior", () => {
  it("preempt flag allows status when in cooldown", () => {
    const db = makeDb();
    db.prepare(
      "INSERT INTO fleet_governor (agent_name, window_started_at, turn_count, forced_cooldown_until, urgent_preempt) VALUES (?, CURRENT_TIMESTAMP, 0, ?, 1)",
    ).run("agent-c", isoAfterSeconds(300));
    const status = governorStatus(db, "agent-c", 120, 4);
    expect(status.allowed).toBe(true);
    expect(status.urgent_preempt).toBe(true);
  });

  it("status check clears urgent_preempt flag when in cooldown", () => {
    const db = makeDb();
    db.prepare(
      "INSERT INTO fleet_governor (agent_name, window_started_at, turn_count, forced_cooldown_until, urgent_preempt) VALUES (?, CURRENT_TIMESTAMP, 0, ?, 1)",
    ).run("agent-c", isoAfterSeconds(300));
    governorStatus(db, "agent-c", 120, 4);
    expect(getRow(db, "agent-c").urgent_preempt).toBe(0);
  });

  it("second status check after preemption is blocked again by cooldown", () => {
    const db = makeDb();
    db.prepare(
      "INSERT INTO fleet_governor (agent_name, window_started_at, turn_count, forced_cooldown_until, urgent_preempt) VALUES (?, CURRENT_TIMESTAMP, 0, ?, 1)",
    ).run("agent-d", isoAfterSeconds(300));
    governorStatus(db, "agent-d", 120, 4);
    const second = governorStatus(db, "agent-d", 120, 4);
    expect(second.allowed).toBe(false);
    expect(second.urgent_preempt).toBe(false);
  });

  it("preempt flag does not affect status when NOT in cooldown", () => {
    const db = makeDb();
    db.prepare(
      "INSERT INTO fleet_governor (agent_name, window_started_at, turn_count, forced_cooldown_until, urgent_preempt) VALUES (?, CURRENT_TIMESTAMP, 0, NULL, 1)",
    ).run("agent-e");
    const status = governorStatus(db, "agent-e", 120, 4);
    expect(status.allowed).toBe(true);
    expect(status.urgent_preempt).toBe(true);
  });

  it("preempt flag is not cleared when NOT in cooldown", () => {
    const db = makeDb();
    db.prepare(
      "INSERT INTO fleet_governor (agent_name, window_started_at, turn_count, forced_cooldown_until, urgent_preempt) VALUES (?, CURRENT_TIMESTAMP, 0, NULL, 1)",
    ).run("agent-e");
    governorStatus(db, "agent-e", 120, 4);
    expect(getRow(db, "agent-e").urgent_preempt).toBe(1);
  });

  it("non-preempted agent in cooldown is blocked", () => {
    const db = makeDb();
    db.prepare(
      "INSERT INTO fleet_governor (agent_name, window_started_at, turn_count, forced_cooldown_until, urgent_preempt) VALUES (?, CURRENT_TIMESTAMP, 0, ?, 0)",
    ).run("agent-f", isoAfterSeconds(300));
    const status = governorStatus(db, "agent-f", 120, 4);
    expect(status.allowed).toBe(false);
    expect(status.urgent_preempt).toBe(false);
  });

  it("expired cooldown allows without preempt", () => {
    const db = makeDb();
    db.prepare(
      "INSERT INTO fleet_governor (agent_name, window_started_at, turn_count, forced_cooldown_until, urgent_preempt) VALUES (?, CURRENT_TIMESTAMP, 0, ?, 0)",
    ).run("agent-g", isoPastSeconds(10));
    const status = governorStatus(db, "agent-g", 120, 4);
    expect(status.allowed).toBe(true);
  });
});
