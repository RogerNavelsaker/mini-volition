import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  ensureGovernorSchema,
  governorStatus,
  governorBump,
  governorForce,
  governorUrgentPreempt,
  governorClearCooldown,
} from "./governor";

const WINDOW_SEC = 120;
const TURN_LIMIT = 4;

function makeDb(): Database {
  const db = new Database(":memory:");
  ensureGovernorSchema(db);
  return db;
}

const now = Date.now();
const nowIso = new Date(now).toISOString();
const futureIso = new Date(now + 10_000).toISOString();
const pastIso = new Date(now - 10_000).toISOString();

function insertGovernor(db: Database, agentName: string, turnCount: number, cooldownUntil: string | null = null, urgentPreempt = 0) {
  db.prepare(
    `INSERT INTO fleet_governor (agent_name, window_started_at, turn_count, forced_cooldown_until, urgent_preempt, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(agentName, nowIso, turnCount, cooldownUntil, urgentPreempt, nowIso);
}

describe("governorStatus — fresh agent", () => {
  let db: Database;
  beforeEach(() => { db = makeDb(); });

  it("returns allowed=true for unknown agent", () => {
    const s = governorStatus(db, "claude", WINDOW_SEC, TURN_LIMIT, now);
    expect(s.allowed).toBe(true);
    expect(s.in_cooldown).toBe(false);
    expect(s.turn_limit_reached).toBe(false);
    expect(s.turn_count).toBe(0);
  });
});

describe("governorStatus — turn limit enforcement", () => {
  let db: Database;
  beforeEach(() => { db = makeDb(); });

  it("blocks when turn_count >= turn_limit", () => {
    insertGovernor(db, "claude", TURN_LIMIT);
    const s = governorStatus(db, "claude", WINDOW_SEC, TURN_LIMIT, now);
    expect(s.allowed).toBe(false);
    expect(s.turn_limit_reached).toBe(true);
    expect(s.in_cooldown).toBe(false);
  });

  it("allows when turn_count is exactly one below limit", () => {
    insertGovernor(db, "claude", TURN_LIMIT - 1);
    const s = governorStatus(db, "claude", WINDOW_SEC, TURN_LIMIT, now);
    expect(s.allowed).toBe(true);
    expect(s.turn_limit_reached).toBe(false);
  });
});

describe("governorStatus — cooldown enforcement", () => {
  let db: Database;
  beforeEach(() => { db = makeDb(); });

  it("blocks when in forced cooldown", () => {
    insertGovernor(db, "claude", 0, futureIso);
    const s = governorStatus(db, "claude", WINDOW_SEC, TURN_LIMIT, now);
    expect(s.allowed).toBe(false);
    expect(s.in_cooldown).toBe(true);
  });

  it("allows when cooldown has expired", () => {
    insertGovernor(db, "claude", 0, pastIso);
    const s = governorStatus(db, "claude", WINDOW_SEC, TURN_LIMIT, now);
    expect(s.allowed).toBe(true);
    expect(s.in_cooldown).toBe(false);
  });
});

describe("governorStatus — urgent preempt", () => {
  let db: Database;
  beforeEach(() => { db = makeDb(); });

  it("allows through cooldown when urgent_preempt=1", () => {
    insertGovernor(db, "claude", 0, futureIso, 1);
    const s = governorStatus(db, "claude", WINDOW_SEC, TURN_LIMIT, now);
    expect(s.allowed).toBe(true);
    expect(s.urgent_preempt_used).toBe(true);
  });

  it("allows through turn limit when urgent_preempt=1", () => {
    insertGovernor(db, "claude", TURN_LIMIT, null, 1);
    const s = governorStatus(db, "claude", WINDOW_SEC, TURN_LIMIT, now);
    expect(s.allowed).toBe(true);
    expect(s.urgent_preempt_used).toBe(true);
  });

  it("clears urgent_preempt flag after use", () => {
    insertGovernor(db, "claude", 0, futureIso, 1);
    governorStatus(db, "claude", WINDOW_SEC, TURN_LIMIT, now);
    const s2 = governorStatus(db, "claude", WINDOW_SEC, TURN_LIMIT, now);
    expect(s2.allowed).toBe(false);
    expect(s2.urgent_preempt_used).toBe(false);
  });

  it("does not use preempt when not blocked", () => {
    insertGovernor(db, "claude", 0, null, 1);
    const s = governorStatus(db, "claude", WINDOW_SEC, TURN_LIMIT, now);
    expect(s.allowed).toBe(true);
    expect(s.urgent_preempt_used).toBe(false);
    const row = db.prepare("SELECT urgent_preempt FROM fleet_governor WHERE agent_name = 'claude'").get() as any;
    expect(row.urgent_preempt).toBe(1);
  });
});

describe("governorBump", () => {
  let db: Database;
  beforeEach(() => { db = makeDb(); });

  it("increments turn_count", () => {
    governorBump(db, "claude", WINDOW_SEC, TURN_LIMIT, null, now);
    const s = governorStatus(db, "claude", WINDOW_SEC, TURN_LIMIT, now);
    expect(s.turn_count).toBe(1);
  });

  it("triggers cooldown when bump exceeds turn_limit", () => {
    for (let i = 0; i < TURN_LIMIT; i++) {
      governorBump(db, "claude", WINDOW_SEC, TURN_LIMIT, null, now);
    }
    const s = governorBump(db, "claude", WINDOW_SEC, TURN_LIMIT, null, now);
    expect(s.in_cooldown).toBe(true);
    expect(s.forced_cooldown_until).not.toBeNull();
  });

  it("records last_reason", () => {
    governorBump(db, "claude", WINDOW_SEC, TURN_LIMIT, "wake:mail_burst", now);
    const s = governorStatus(db, "claude", WINDOW_SEC, TURN_LIMIT, now);
    expect(s.last_reason).toBe("wake:mail_burst");
  });

  it("does not block before turn_limit is reached", () => {
    for (let i = 0; i < TURN_LIMIT - 1; i++) {
      const s = governorBump(db, "claude", WINDOW_SEC, TURN_LIMIT, null, now);
      expect(s.allowed).toBe(true);
    }
  });
});

describe("governorForce", () => {
  let db: Database;
  beforeEach(() => { db = makeDb(); });

  it("forces cooldown immediately", () => {
    const s = governorForce(db, "claude", 60, "manual", now);
    expect(s.in_cooldown).toBe(true);
    expect(s.forced_cooldown_until).not.toBeNull();
    expect(s.last_reason).toBe("manual");
  });

  it("returns allowed=false after force", () => {
    const s = governorForce(db, "claude", 60, null, now);
    expect(s.allowed).toBe(false);
  });
});

describe("governorUrgentPreempt", () => {
  let db: Database;
  beforeEach(() => { db = makeDb(); });

  it("sets urgent_preempt=1 on existing agent", () => {
    insertGovernor(db, "claude", 0, futureIso);
    governorUrgentPreempt(db, "claude");
    const s = governorStatus(db, "claude", WINDOW_SEC, TURN_LIMIT, now);
    expect(s.urgent_preempt_used).toBe(true);
    expect(s.allowed).toBe(true);
  });

  it("creates agent record if not exists", () => {
    governorUrgentPreempt(db, "gemini");
    const row = db.prepare("SELECT urgent_preempt FROM fleet_governor WHERE agent_name = 'gemini'").get() as any;
    expect(row.urgent_preempt).toBe(1);
  });
});

describe("governorClearCooldown", () => {
  let db: Database;
  beforeEach(() => { db = makeDb(); });

  it("clears forced_cooldown_until", () => {
    governorForce(db, "claude", 60, null, now);
    governorClearCooldown(db, "claude");
    const s = governorStatus(db, "claude", WINDOW_SEC, TURN_LIMIT, now);
    expect(s.in_cooldown).toBe(false);
    expect(s.allowed).toBe(true);
  });

  it("no-ops when no cooldown is set", () => {
    insertGovernor(db, "claude", 0);
    governorClearCooldown(db, "claude");
    const s = governorStatus(db, "claude", WINDOW_SEC, TURN_LIMIT, now);
    expect(s.in_cooldown).toBe(false);
  });
});
