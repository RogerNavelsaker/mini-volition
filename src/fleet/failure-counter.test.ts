import { describe, it, expect, beforeEach } from "bun:test";
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
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`);
  return db;
}

function isoAfterSeconds(db: Database, seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function recordFailure(db: Database, agent: string, threshold: number, cooldownSec: number, reason: string | null) {
  const rec = db.prepare("SELECT * FROM fleet_governor WHERE agent_name = ?").get(agent) as any;
  const nextCount = (rec?.consecutive_failures ?? 0) + 1;
  const shouldCooldown = nextCount >= threshold;
  const cooldownUntil = shouldCooldown ? isoAfterSeconds(db, cooldownSec) : (rec?.forced_cooldown_until ?? null);
  db.prepare(
    `INSERT INTO fleet_governor (agent_name, window_started_at, turn_count, forced_cooldown_until, last_reason, consecutive_failures, updated_at)
     VALUES (?, COALESCE(?, CURRENT_TIMESTAMP), 0, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(agent_name) DO UPDATE SET
       consecutive_failures = excluded.consecutive_failures,
       forced_cooldown_until = excluded.forced_cooldown_until,
       last_reason = excluded.last_reason,
       updated_at = CURRENT_TIMESTAMP`,
  ).run(agent, rec?.window_started_at ?? null, cooldownUntil, reason, nextCount);
  return { consecutive_failures: nextCount, cooled_down: shouldCooldown, cooldown_until: cooldownUntil };
}

function resetFailures(db: Database, agent: string) {
  db.prepare(
    `INSERT INTO fleet_governor (agent_name, window_started_at, turn_count, forced_cooldown_until, last_reason, consecutive_failures, updated_at)
     VALUES (?, CURRENT_TIMESTAMP, 0, NULL, NULL, 0, CURRENT_TIMESTAMP)
     ON CONFLICT(agent_name) DO UPDATE SET
       consecutive_failures = 0,
       forced_cooldown_until = NULL,
       updated_at = CURRENT_TIMESTAMP`,
  ).run(agent);
  return { consecutive_failures: 0 };
}

function getRow(db: Database, agent: string) {
  return db.prepare("SELECT * FROM fleet_governor WHERE agent_name = ?").get(agent) as any;
}

describe("fleet_governor — consecutive_failures column", () => {
  it("defaults to 0", () => {
    const db = makeDb();
    db.run(`INSERT INTO fleet_governor (agent_name, window_started_at, turn_count) VALUES ('agent-a', CURRENT_TIMESTAMP, 0)`);
    const row = getRow(db, "agent-a");
    expect(row.consecutive_failures).toBe(0);
  });
});

describe("recordFailure", () => {
  let db: Database;

  beforeEach(() => { db = makeDb(); });

  it("increments consecutive_failures on first failure", () => {
    const result = recordFailure(db, "agent-a", 3, 300, "turn error");
    expect(result.consecutive_failures).toBe(1);
    expect(result.cooled_down).toBe(false);
    expect(getRow(db, "agent-a").consecutive_failures).toBe(1);
  });

  it("accumulates across successive calls", () => {
    recordFailure(db, "agent-a", 3, 300, "err1");
    recordFailure(db, "agent-a", 3, 300, "err2");
    const result = recordFailure(db, "agent-a", 3, 300, "err3");
    expect(result.consecutive_failures).toBe(3);
  });

  it("triggers cooldown when threshold reached", () => {
    recordFailure(db, "agent-a", 2, 60, null);
    const result = recordFailure(db, "agent-a", 2, 60, "fatal");
    expect(result.cooled_down).toBe(true);
    expect(result.cooldown_until).not.toBeNull();
    const row = getRow(db, "agent-a");
    expect(row.forced_cooldown_until).not.toBeNull();
  });

  it("does not trigger cooldown below threshold", () => {
    const result = recordFailure(db, "agent-a", 5, 60, null);
    expect(result.cooled_down).toBe(false);
    expect(result.cooldown_until).toBeNull();
  });

  it("cooldown_until is in the future", () => {
    recordFailure(db, "agent-a", 1, 120, null);
    const row = getRow(db, "agent-a");
    const cooldownMs = new Date(row.forced_cooldown_until).getTime();
    expect(cooldownMs).toBeGreaterThan(Date.now());
  });

  it("stores reason in last_reason", () => {
    recordFailure(db, "agent-a", 3, 300, "timeout error");
    expect(getRow(db, "agent-a").last_reason).toBe("timeout error");
  });

  it("threshold=1 coolsdown on first failure", () => {
    const result = recordFailure(db, "agent-a", 1, 60, null);
    expect(result.cooled_down).toBe(true);
    expect(result.consecutive_failures).toBe(1);
  });
});

describe("resetFailures", () => {
  let db: Database;

  beforeEach(() => { db = makeDb(); });

  it("resets consecutive_failures to 0", () => {
    recordFailure(db, "agent-a", 5, 300, null);
    recordFailure(db, "agent-a", 5, 300, null);
    resetFailures(db, "agent-a");
    expect(getRow(db, "agent-a").consecutive_failures).toBe(0);
  });

  it("returns consecutive_failures: 0", () => {
    recordFailure(db, "agent-a", 5, 300, null);
    const result = resetFailures(db, "agent-a");
    expect(result.consecutive_failures).toBe(0);
  });

  it("clears forced_cooldown_until", () => {
    recordFailure(db, "agent-a", 1, 300, null); // triggers cooldown
    resetFailures(db, "agent-a");
    expect(getRow(db, "agent-a").forced_cooldown_until).toBeNull();
  });

  it("after reset, failure counter starts from 1 again", () => {
    recordFailure(db, "agent-a", 3, 300, null);
    recordFailure(db, "agent-a", 3, 300, null);
    resetFailures(db, "agent-a");
    const result = recordFailure(db, "agent-a", 3, 300, null);
    expect(result.consecutive_failures).toBe(1);
    expect(result.cooled_down).toBe(false);
  });
});
