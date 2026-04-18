import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { assessTopology, listStuckAgents, listGhostedAgents } from "./topology";

const NOW = "2026-04-18T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);

function ts(offsetMs: number): string {
  return new Date(NOW_MS + offsetMs).toISOString();
}

function makeDb(): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE fleet_agent_state (
    agent_name TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    health_status TEXT NOT NULL DEFAULT 'dead',
    updated_at TEXT NOT NULL,
    last_message_id INTEGER
  );`);
  db.run(`CREATE TABLE fleet_agent_ghosts (
    agent_name TEXT PRIMARY KEY,
    turn_key TEXT NOT NULL,
    wake_source TEXT NOT NULL,
    wake_reason TEXT NOT NULL,
    message_id INTEGER,
    failure_kind TEXT NOT NULL DEFAULT 'ghosted',
    detail TEXT,
    checkpoint_status TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );`);
  return db;
}

function insertAgent(
  db: Database,
  name: string,
  status: string,
  healthStatus: string,
  updatedAt: string,
  lastMessageId: number | null = null,
) {
  db.prepare(
    `INSERT INTO fleet_agent_state (agent_name, status, health_status, updated_at, last_message_id)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(name, status, healthStatus, updatedAt, lastMessageId);
}

function insertGhost(db: Database, name: string, wakeSource: string, messageId: number | null = null) {
  db.prepare(
    `INSERT INTO fleet_agent_ghosts (agent_name, turn_key, wake_source, wake_reason, message_id, created_at, updated_at)
     VALUES (?, ?, ?, 'test', ?, ?, ?)`,
  ).run(name, `turn-${name}`, wakeSource, messageId, NOW, NOW);
}

const STUCK_MS = 60_000;

describe("assessTopology — healthy agents", () => {
  let db: Database;
  beforeEach(() => { db = makeDb(); });

  it("returns empty lists when no agents", () => {
    const report = assessTopology(db, STUCK_MS, NOW);
    expect(report.healthy).toHaveLength(0);
    expect(report.degraded).toHaveLength(0);
    expect(report.dead).toHaveLength(0);
    expect(report.repair_actions).toHaveLength(0);
  });

  it("classifies active agent as healthy", () => {
    insertAgent(db, "claude", "idle", "active", ts(-10_000));
    const report = assessTopology(db, STUCK_MS, NOW);
    expect(report.healthy).toContain("claude");
    expect(report.degraded).not.toContain("claude");
  });

  it("classifies thinking agent below threshold as healthy", () => {
    insertAgent(db, "claude", "thinking", "active", ts(-30_000));
    const report = assessTopology(db, STUCK_MS, NOW);
    expect(report.healthy).toContain("claude");
  });
});

describe("assessTopology — stuck agents", () => {
  let db: Database;
  beforeEach(() => { db = makeDb(); });

  it("classifies thinking agent beyond threshold as degraded", () => {
    insertAgent(db, "claude", "thinking", "active", ts(-90_000));
    const report = assessTopology(db, STUCK_MS, NOW);
    expect(report.degraded).toContain("claude");
    expect(report.healthy).not.toContain("claude");
  });

  it("emits reassign_jobs action when stuck agent has last_message_id", () => {
    insertAgent(db, "claude", "thinking", "active", ts(-90_000), 42);
    const report = assessTopology(db, STUCK_MS, NOW);
    const action = report.repair_actions.find((a) => a.agent_name === "claude" && a.kind === "reassign_jobs");
    expect(action).toBeDefined();
    expect(action?.message_id).toBe(42);
  });

  it("emits mark_dead action when stuck agent has no last_message_id", () => {
    insertAgent(db, "claude", "thinking", "active", ts(-90_000), null);
    const report = assessTopology(db, STUCK_MS, NOW);
    const action = report.repair_actions.find((a) => a.agent_name === "claude" && a.kind === "mark_dead");
    expect(action).toBeDefined();
  });

  it("classifies thinking at exactly threshold as stuck", () => {
    insertAgent(db, "claude", "thinking", "active", ts(-STUCK_MS - 1));
    const report = assessTopology(db, STUCK_MS, NOW);
    expect(report.degraded).toContain("claude");
  });
});

describe("assessTopology — dead and latent agents", () => {
  let db: Database;
  beforeEach(() => { db = makeDb(); });

  it("classifies health_status=dead agents in dead list", () => {
    insertAgent(db, "claude", "idle", "dead", ts(-10_000));
    const report = assessTopology(db, STUCK_MS, NOW);
    expect(report.dead).toContain("claude");
    expect(report.healthy).not.toContain("claude");
  });

  it("classifies health_status=latent agents in degraded", () => {
    insertAgent(db, "claude", "idle", "latent", ts(-10_000));
    const report = assessTopology(db, STUCK_MS, NOW);
    expect(report.degraded).toContain("claude");
  });
});

describe("assessTopology — ghosted agents", () => {
  let db: Database;
  beforeEach(() => { db = makeDb(); });

  it("classifies ghosted agent as degraded", () => {
    insertAgent(db, "claude", "thinking", "active", ts(-90_000));
    insertGhost(db, "claude", "internal_job", 7);
    const report = assessTopology(db, STUCK_MS, NOW);
    expect(report.degraded).toContain("claude");
  });

  it("emits reassign_jobs for ghost with internal_job wake_source", () => {
    insertAgent(db, "claude", "thinking", "active", ts(-90_000));
    insertGhost(db, "claude", "internal_job", 7);
    const report = assessTopology(db, STUCK_MS, NOW);
    const action = report.repair_actions.find((a) => a.kind === "reassign_jobs" && a.agent_name === "claude");
    expect(action).toBeDefined();
    expect(action?.message_id).toBe(7);
  });

  it("emits release_mail for ghost with mail_burst wake_source", () => {
    insertAgent(db, "claude", "thinking", "active", ts(-90_000));
    insertGhost(db, "claude", "mail_burst", 99);
    const report = assessTopology(db, STUCK_MS, NOW);
    const action = report.repair_actions.find((a) => a.kind === "release_mail" && a.agent_name === "claude");
    expect(action).toBeDefined();
    expect(action?.message_id).toBe(99);
  });

  it("emits clear_ghost action after ghost work reassigned", () => {
    insertAgent(db, "claude", "thinking", "active", ts(-90_000));
    insertGhost(db, "claude", "internal_job", 7);
    const report = assessTopology(db, STUCK_MS, NOW);
    const action = report.repair_actions.find((a) => a.kind === "clear_ghost" && a.agent_name === "claude");
    expect(action).toBeDefined();
  });
});

describe("assessTopology — multiple agents", () => {
  let db: Database;
  beforeEach(() => { db = makeDb(); });

  it("classifies multiple agents independently", () => {
    insertAgent(db, "claude", "idle", "active", ts(-5_000));
    insertAgent(db, "gemini", "thinking", "active", ts(-120_000));
    insertAgent(db, "codex", "idle", "dead", ts(-10_000));
    const report = assessTopology(db, STUCK_MS, NOW);
    expect(report.healthy).toContain("claude");
    expect(report.degraded).toContain("gemini");
    expect(report.dead).toContain("codex");
  });
});

describe("listStuckAgents", () => {
  let db: Database;
  beforeEach(() => { db = makeDb(); });

  it("returns only stuck agents", () => {
    insertAgent(db, "claude", "thinking", "active", ts(-120_000));
    insertAgent(db, "gemini", "idle", "active", ts(-5_000));
    const stuck = listStuckAgents(db, STUCK_MS, NOW);
    expect(stuck).toHaveLength(1);
    expect(stuck[0].agent_name).toBe("claude");
    expect(stuck[0].stuck).toBe(true);
  });

  it("returns empty when no stuck agents", () => {
    insertAgent(db, "claude", "idle", "active", ts(-5_000));
    expect(listStuckAgents(db, STUCK_MS, NOW)).toHaveLength(0);
  });
});

describe("listGhostedAgents", () => {
  let db: Database;
  beforeEach(() => { db = makeDb(); });

  it("returns empty when no ghosts", () => {
    expect(listGhostedAgents(db)).toHaveLength(0);
  });

  it("returns all ghosted agents", () => {
    insertAgent(db, "claude", "thinking", "active", NOW);
    insertAgent(db, "gemini", "thinking", "active", NOW);
    insertGhost(db, "claude", "internal_job");
    insertGhost(db, "gemini", "mail_burst");
    const ghosted = listGhostedAgents(db);
    expect(ghosted.sort()).toEqual(["claude", "gemini"]);
  });
});
