import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  ensureJobSchema,
  addJobDependency,
  pendingBlockers,
  unblockDependents,
} from "./core";

function makeDb(): Database {
  const db = new Database(":memory:");
  ensureJobSchema(db);
  return db;
}

function queueJob(db: Database, id: number, status = "queued") {
  db.run(
    `INSERT INTO fleet_internal_jobs (id, target_agent, sender, body, priority, status)
     VALUES (?, 'agent-a', 'sender', 'body', 'normal', ?)`,
    [id, status],
  );
}

describe("ensureJobSchema", () => {
  test("creates fleet_internal_jobs table", () => {
    const db = makeDb();
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='fleet_internal_jobs'").get();
    expect(row).toBeTruthy();
  });

  test("creates fleet_job_dependencies table", () => {
    const db = makeDb();
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='fleet_job_dependencies'").get();
    expect(row).toBeTruthy();
  });

  test("creates index on blocking_job_id", () => {
    const db = makeDb();
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_job_deps_blocking'").get();
    expect(row).toBeTruthy();
  });

  test("is idempotent", () => {
    const db = makeDb();
    expect(() => ensureJobSchema(db)).not.toThrow();
  });
});

describe("addJobDependency", () => {
  test("inserts a dependency row", () => {
    const db = makeDb();
    queueJob(db, 1);
    queueJob(db, 2);
    addJobDependency(db, 1, 2);
    const row = db.prepare("SELECT * FROM fleet_job_dependencies WHERE dependent_job_id = 1 AND blocking_job_id = 2").get();
    expect(row).toBeTruthy();
  });

  test("is idempotent — duplicate insert does not throw", () => {
    const db = makeDb();
    queueJob(db, 1);
    queueJob(db, 2);
    addJobDependency(db, 1, 2);
    expect(() => addJobDependency(db, 1, 2)).not.toThrow();
    const rows = db.prepare("SELECT COUNT(*) as cnt FROM fleet_job_dependencies WHERE dependent_job_id = 1").get() as any;
    expect(rows.cnt).toBe(1);
  });

  test("allows multiple blockers for one dependent", () => {
    const db = makeDb();
    queueJob(db, 1);
    queueJob(db, 2);
    queueJob(db, 3);
    addJobDependency(db, 1, 2);
    addJobDependency(db, 1, 3);
    const rows = db.prepare("SELECT COUNT(*) as cnt FROM fleet_job_dependencies WHERE dependent_job_id = 1").get() as any;
    expect(rows.cnt).toBe(2);
  });
});

describe("pendingBlockers", () => {
  test("returns 0 when no dependencies exist", () => {
    const db = makeDb();
    queueJob(db, 1);
    expect(pendingBlockers(db, 1)).toBe(0);
  });

  test("counts queued blocking jobs as pending", () => {
    const db = makeDb();
    queueJob(db, 1, "blocked");
    queueJob(db, 2, "queued");
    addJobDependency(db, 1, 2);
    expect(pendingBlockers(db, 1)).toBe(1);
  });

  test("does not count completed blockers", () => {
    const db = makeDb();
    queueJob(db, 1, "blocked");
    queueJob(db, 2, "completed");
    addJobDependency(db, 1, 2);
    expect(pendingBlockers(db, 1)).toBe(0);
  });

  test("does not count cancelled blockers", () => {
    const db = makeDb();
    queueJob(db, 1, "blocked");
    queueJob(db, 2, "cancelled");
    addJobDependency(db, 1, 2);
    expect(pendingBlockers(db, 1)).toBe(0);
  });

  test("counts claimed and failed blockers as pending", () => {
    const db = makeDb();
    queueJob(db, 1, "blocked");
    queueJob(db, 2, "claimed");
    queueJob(db, 3, "failed");
    addJobDependency(db, 1, 2);
    addJobDependency(db, 1, 3);
    expect(pendingBlockers(db, 1)).toBe(2);
  });

  test("partial completion leaves remaining count", () => {
    const db = makeDb();
    queueJob(db, 1, "blocked");
    queueJob(db, 2, "completed");
    queueJob(db, 3, "queued");
    addJobDependency(db, 1, 2);
    addJobDependency(db, 1, 3);
    expect(pendingBlockers(db, 1)).toBe(1);
  });
});

describe("unblockDependents", () => {
  test("returns empty array when no dependents", () => {
    const db = makeDb();
    queueJob(db, 1, "completed");
    expect(unblockDependents(db, 1)).toEqual([]);
  });

  test("unblocks a dependent when its only blocker completes", () => {
    const db = makeDb();
    queueJob(db, 1, "blocked");
    queueJob(db, 2, "completed");
    addJobDependency(db, 1, 2);
    const unblocked = unblockDependents(db, 2);
    expect(unblocked).toContain(1);
    const job = db.prepare("SELECT status FROM fleet_internal_jobs WHERE id = 1").get() as any;
    expect(job.status).toBe("queued");
    expect((db.prepare("SELECT blocked_on FROM fleet_internal_jobs WHERE id = 1").get() as any).blocked_on).toBeNull();
  });

  test("does not unblock when other blockers are still pending", () => {
    const db = makeDb();
    queueJob(db, 1, "blocked");
    queueJob(db, 2, "completed");
    queueJob(db, 3, "queued");
    addJobDependency(db, 1, 2);
    addJobDependency(db, 1, 3);
    const unblocked = unblockDependents(db, 2);
    expect(unblocked).toEqual([]);
    const job = db.prepare("SELECT status FROM fleet_internal_jobs WHERE id = 1").get() as any;
    expect(job.status).toBe("blocked");
  });

  test("unblocks multiple dependents when all their blockers complete", () => {
    const db = makeDb();
    queueJob(db, 1, "blocked");
    queueJob(db, 2, "blocked");
    queueJob(db, 3, "completed");
    addJobDependency(db, 1, 3);
    addJobDependency(db, 2, 3);
    const unblocked = unblockDependents(db, 3);
    expect(unblocked).toContain(1);
    expect(unblocked).toContain(2);
  });

  test("unblocks waiting jobs as well as blocked jobs", () => {
    const db = makeDb();
    queueJob(db, 1, "waiting");
    queueJob(db, 2, "completed");
    addJobDependency(db, 1, 2);
    const unblocked = unblockDependents(db, 2);
    expect(unblocked).toContain(1);
    const job = db.prepare("SELECT status FROM fleet_internal_jobs WHERE id = 1").get() as any;
    expect(job.status).toBe("queued");
  });

  test("does not touch already-completed dependents", () => {
    const db = makeDb();
    queueJob(db, 1, "completed");
    queueJob(db, 2, "completed");
    addJobDependency(db, 1, 2);
    const unblocked = unblockDependents(db, 2);
    expect(unblocked).toEqual([]);
  });

  test("cancelled blocker also unblocks dependents", () => {
    const db = makeDb();
    queueJob(db, 1, "blocked");
    queueJob(db, 2, "cancelled");
    addJobDependency(db, 1, 2);
    const unblocked = unblockDependents(db, 2);
    expect(unblocked).toContain(1);
  });
});
