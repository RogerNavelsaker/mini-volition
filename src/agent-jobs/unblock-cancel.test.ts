import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  ensureJobSchema,
  addJobDependency,
  cascadeCancel,
  manualUnblock,
  jobDeps,
} from "./core";

function makeDb(): Database {
  const db = new Database(":memory:");
  ensureJobSchema(db);
  return db;
}

function queueJob(db: Database, id: number, status = "queued", agent = "agent-a") {
  db.run(
    `INSERT INTO fleet_internal_jobs (id, target_agent, sender, body, priority, status)
     VALUES (?, ?, 'sender', 'body', 'normal', ?)`,
    [id, agent, status],
  );
}

function status(db: Database, id: number): string {
  return (db.prepare("SELECT status FROM fleet_internal_jobs WHERE id = ?").get(id) as any)?.status;
}

// ── cascadeCancel ──────────────────────────────────────────────────────────

describe("cascadeCancel", () => {
  test("cancels a single job", () => {
    const db = makeDb();
    queueJob(db, 1);
    const cancelled = cascadeCancel(db, 1, "test");
    expect(cancelled).toContain(1);
    expect(status(db, 1)).toBe("cancelled");
  });

  test("returns empty when job already completed", () => {
    const db = makeDb();
    queueJob(db, 1, "completed");
    const cancelled = cascadeCancel(db, 1, "test");
    expect(cancelled).not.toContain(1);
    expect(status(db, 1)).toBe("completed");
  });

  test("returns empty when job already cancelled", () => {
    const db = makeDb();
    queueJob(db, 1, "cancelled");
    const cancelled = cascadeCancel(db, 1, "test");
    expect(cancelled).not.toContain(1);
  });

  test("cancels direct dependents", () => {
    const db = makeDb();
    queueJob(db, 1);
    queueJob(db, 2, "blocked");
    addJobDependency(db, 2, 1);
    const cancelled = cascadeCancel(db, 1, "test");
    expect(cancelled).toContain(1);
    expect(cancelled).toContain(2);
    expect(status(db, 2)).toBe("cancelled");
  });

  test("cascades recursively through dependency chain", () => {
    const db = makeDb();
    queueJob(db, 1);
    queueJob(db, 2, "blocked");
    queueJob(db, 3, "blocked");
    addJobDependency(db, 2, 1);
    addJobDependency(db, 3, 2);
    const cancelled = cascadeCancel(db, 1, "test");
    expect(cancelled).toContain(1);
    expect(cancelled).toContain(2);
    expect(cancelled).toContain(3);
    expect(status(db, 3)).toBe("cancelled");
  });

  test("handles diamond dependency without duplicate cancel", () => {
    const db = makeDb();
    // 1 → 2, 1 → 3, both 2 and 3 → 4
    queueJob(db, 1);
    queueJob(db, 2, "blocked");
    queueJob(db, 3, "blocked");
    queueJob(db, 4, "blocked");
    addJobDependency(db, 2, 1);
    addJobDependency(db, 3, 1);
    addJobDependency(db, 4, 2);
    addJobDependency(db, 4, 3);
    const cancelled = cascadeCancel(db, 1, "test");
    expect(cancelled.filter((id) => id === 4).length).toBe(1);
    expect(status(db, 4)).toBe("cancelled");
  });

  test("does not cancel dependents that are already completed", () => {
    const db = makeDb();
    queueJob(db, 1);
    queueJob(db, 2, "completed");
    addJobDependency(db, 2, 1);
    const cancelled = cascadeCancel(db, 1, "test");
    expect(cancelled).not.toContain(2);
    expect(status(db, 2)).toBe("completed");
  });

  test("sets last_error to reason on root", () => {
    const db = makeDb();
    queueJob(db, 1);
    cascadeCancel(db, 1, "manual shutdown");
    const row = db.prepare("SELECT last_error FROM fleet_internal_jobs WHERE id = 1").get() as any;
    expect(row.last_error).toBe("manual shutdown");
  });

  test("sets last_error to cascade message on dependents", () => {
    const db = makeDb();
    queueJob(db, 1);
    queueJob(db, 2, "blocked");
    addJobDependency(db, 2, 1);
    cascadeCancel(db, 1, "manual shutdown");
    const row = db.prepare("SELECT last_error FROM fleet_internal_jobs WHERE id = 2").get() as any;
    expect(row.last_error).toContain("cascade from 1");
  });
});

// ── manualUnblock ──────────────────────────────────────────────────────────

describe("manualUnblock", () => {
  test("transitions blocked job to queued", () => {
    const db = makeDb();
    queueJob(db, 1, "blocked");
    expect(manualUnblock(db, 1)).toBe(true);
    expect(status(db, 1)).toBe("queued");
  });

  test("transitions waiting job to queued", () => {
    const db = makeDb();
    queueJob(db, 1, "waiting");
    expect(manualUnblock(db, 1)).toBe(true);
    expect(status(db, 1)).toBe("queued");
  });

  test("returns false for already-queued job", () => {
    const db = makeDb();
    queueJob(db, 1, "queued");
    expect(manualUnblock(db, 1)).toBe(false);
  });

  test("returns false for completed job", () => {
    const db = makeDb();
    queueJob(db, 1, "completed");
    expect(manualUnblock(db, 1)).toBe(false);
  });

  test("clears blocked_on field", () => {
    const db = makeDb();
    queueJob(db, 1, "blocked");
    db.run("UPDATE fleet_internal_jobs SET blocked_on = '99' WHERE id = 1");
    manualUnblock(db, 1);
    const row = db.prepare("SELECT blocked_on FROM fleet_internal_jobs WHERE id = 1").get() as any;
    expect(row.blocked_on).toBeNull();
  });

  test("clears wait_reason field", () => {
    const db = makeDb();
    queueJob(db, 1, "waiting");
    db.run("UPDATE fleet_internal_jobs SET wait_reason = 'external system' WHERE id = 1");
    manualUnblock(db, 1);
    const row = db.prepare("SELECT wait_reason FROM fleet_internal_jobs WHERE id = 1").get() as any;
    expect(row.wait_reason).toBeNull();
  });

  test("overrides pending blockers — manual means manual", () => {
    const db = makeDb();
    queueJob(db, 1, "blocked");
    queueJob(db, 2, "queued");
    addJobDependency(db, 1, 2);
    // job 2 still pending, but manualUnblock forces it anyway
    expect(manualUnblock(db, 1)).toBe(true);
    expect(status(db, 1)).toBe("queued");
  });
});

// ── jobDeps ────────────────────────────────────────────────────────────────

describe("jobDeps", () => {
  test("returns empty arrays for job with no deps", () => {
    const db = makeDb();
    queueJob(db, 1);
    const deps = jobDeps(db, 1);
    expect(deps.blockedBy).toEqual([]);
    expect(deps.blocking).toEqual([]);
  });

  test("reports blockedBy correctly", () => {
    const db = makeDb();
    queueJob(db, 1, "blocked");
    queueJob(db, 2, "queued");
    addJobDependency(db, 1, 2);
    const deps = jobDeps(db, 1);
    expect(deps.blockedBy.map((r) => r.id)).toContain(2);
    expect(deps.blockedBy[0].status).toBe("queued");
  });

  test("reports blocking correctly", () => {
    const db = makeDb();
    queueJob(db, 1, "queued");
    queueJob(db, 2, "blocked");
    addJobDependency(db, 2, 1);
    const deps = jobDeps(db, 1);
    expect(deps.blocking.map((r) => r.id)).toContain(2);
  });

  test("reports multiple blockers and dependents", () => {
    const db = makeDb();
    queueJob(db, 1, "blocked");
    queueJob(db, 2, "queued");
    queueJob(db, 3, "completed");
    queueJob(db, 4, "blocked");
    addJobDependency(db, 1, 2);
    addJobDependency(db, 1, 3);
    addJobDependency(db, 4, 1);
    const deps = jobDeps(db, 1);
    expect(deps.blockedBy.map((r) => r.id)).toEqual([2, 3]);
    expect(deps.blocking.map((r) => r.id)).toEqual([4]);
  });
});
