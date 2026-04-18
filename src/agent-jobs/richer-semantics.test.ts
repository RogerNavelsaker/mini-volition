import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { ensureJobSchema, addJobDependency, executionGraph, autoRetryOrFail } from "./core";

function makeDb(): Database {
  const db = new Database(":memory:");
  ensureJobSchema(db);
  return db;
}

function queueJob(db: Database, id: number, opts: { status?: string; agent?: string; maxRetries?: number; retryCount?: number } = {}) {
  db.run(
    `INSERT INTO fleet_internal_jobs (id, target_agent, sender, body, priority, status, max_retries, retry_count)
     VALUES (?, ?, 'sender', 'body', 'normal', ?, ?, ?)`,
    [id, opts.agent ?? "agent-a", opts.status ?? "queued", opts.maxRetries ?? 0, opts.retryCount ?? 0],
  );
}

function getJob(db: Database, id: number): any {
  return db.prepare("SELECT * FROM fleet_internal_jobs WHERE id = ?").get(id);
}

// ── executionGraph ─────────────────────────────────────────────────────────

describe("executionGraph", () => {
  test("empty graph with no jobs", () => {
    const db = makeDb();
    const g = executionGraph(db);
    expect(g.nodes).toEqual([]);
    expect(g.edges).toEqual([]);
  });

  test("returns all nodes when no agent filter", () => {
    const db = makeDb();
    queueJob(db, 1, { agent: "agent-a" });
    queueJob(db, 2, { agent: "agent-b" });
    const g = executionGraph(db);
    expect(g.nodes.map((n) => n.id)).toEqual([1, 2]);
  });

  test("filters nodes by agent", () => {
    const db = makeDb();
    queueJob(db, 1, { agent: "agent-a" });
    queueJob(db, 2, { agent: "agent-b" });
    const g = executionGraph(db, "agent-a");
    expect(g.nodes.map((n) => n.id)).toEqual([1]);
  });

  test("returns edges for dependencies", () => {
    const db = makeDb();
    queueJob(db, 1);
    queueJob(db, 2, { status: "blocked" });
    addJobDependency(db, 2, 1);
    const g = executionGraph(db);
    expect(g.edges).toEqual([{ from: 1, to: 2 }]);
  });

  test("excludes edges where either job is filtered out by agent", () => {
    const db = makeDb();
    queueJob(db, 1, { agent: "agent-a" });
    queueJob(db, 2, { agent: "agent-b", status: "blocked" });
    addJobDependency(db, 2, 1);
    const g = executionGraph(db, "agent-a");
    expect(g.edges).toEqual([]);
  });

  test("node includes retry fields", () => {
    const db = makeDb();
    queueJob(db, 1, { maxRetries: 3, retryCount: 1 });
    const g = executionGraph(db);
    expect(g.nodes[0].max_retries).toBe(3);
    expect(g.nodes[0].retry_count).toBe(1);
  });

  test("multi-edge diamond graph", () => {
    const db = makeDb();
    queueJob(db, 1);
    queueJob(db, 2, { status: "blocked" });
    queueJob(db, 3, { status: "blocked" });
    queueJob(db, 4, { status: "blocked" });
    addJobDependency(db, 2, 1);
    addJobDependency(db, 3, 1);
    addJobDependency(db, 4, 2);
    addJobDependency(db, 4, 3);
    const g = executionGraph(db);
    expect(g.edges).toHaveLength(4);
    expect(g.edges).toContainEqual({ from: 1, to: 2 });
    expect(g.edges).toContainEqual({ from: 1, to: 3 });
    expect(g.edges).toContainEqual({ from: 2, to: 4 });
    expect(g.edges).toContainEqual({ from: 3, to: 4 });
  });
});

// ── autoRetryOrFail ────────────────────────────────────────────────────────

describe("autoRetryOrFail", () => {
  test("marks job failed when max_retries is 0", () => {
    const db = makeDb();
    queueJob(db, 1, { status: "claimed", maxRetries: 0 });
    const r = autoRetryOrFail(db, 1, "boom");
    expect(r.retried).toBe(false);
    expect(getJob(db, 1).status).toBe("failed");
  });

  test("re-queues job when retry_count < max_retries", () => {
    const db = makeDb();
    queueJob(db, 1, { status: "claimed", maxRetries: 3, retryCount: 0 });
    const r = autoRetryOrFail(db, 1, "transient error");
    expect(r.retried).toBe(true);
    expect(r.retry_count).toBe(1);
    expect(getJob(db, 1).status).toBe("queued");
  });

  test("increments retry_count on each retry", () => {
    const db = makeDb();
    queueJob(db, 1, { status: "claimed", maxRetries: 3, retryCount: 2 });
    const r = autoRetryOrFail(db, 1, "err");
    expect(r.retry_count).toBe(3);
    expect(r.retried).toBe(true);
  });

  test("fails when retry_count reaches max_retries", () => {
    const db = makeDb();
    queueJob(db, 1, { status: "claimed", maxRetries: 3, retryCount: 3 });
    const r = autoRetryOrFail(db, 1, "final err");
    expect(r.retried).toBe(false);
    expect(getJob(db, 1).status).toBe("failed");
  });

  test("clears claimed_at and claimed_by on retry", () => {
    const db = makeDb();
    queueJob(db, 1, { status: "claimed", maxRetries: 2, retryCount: 0 });
    db.run("UPDATE fleet_internal_jobs SET claimed_at = CURRENT_TIMESTAMP, claimed_by = 'worker' WHERE id = 1");
    autoRetryOrFail(db, 1, "err");
    const job = getJob(db, 1);
    expect(job.claimed_at).toBeNull();
    expect(job.claimed_by).toBeNull();
  });

  test("records last_error on retry", () => {
    const db = makeDb();
    queueJob(db, 1, { status: "claimed", maxRetries: 2, retryCount: 0 });
    autoRetryOrFail(db, 1, "network timeout");
    expect(getJob(db, 1).last_error).toBe("network timeout");
  });

  test("records last_error on final fail", () => {
    const db = makeDb();
    queueJob(db, 1, { status: "claimed", maxRetries: 0 });
    autoRetryOrFail(db, 1, "unrecoverable");
    expect(getJob(db, 1).last_error).toBe("unrecoverable");
  });

  test("returns false for unknown job id", () => {
    const db = makeDb();
    const r = autoRetryOrFail(db, 999, "err");
    expect(r.retried).toBe(false);
    expect(r.retry_count).toBe(0);
  });
});
