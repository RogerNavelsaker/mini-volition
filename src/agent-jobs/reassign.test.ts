import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { ensureJobSchema, reassignAgentJobs } from "./core";

function makeDb(): Database {
  const db = new Database(":memory:");
  ensureJobSchema(db);
  return db;
}

function insertJob(db: Database, agent: string, body: string, status = "queued", priority = "normal"): number {
  const result = db.prepare(
    `INSERT INTO fleet_internal_jobs (target_agent, sender, body, status, priority) VALUES (?, 'test', ?, ?, ?)`,
  ).run(agent, body, status, priority);
  return Number(result.lastInsertRowid);
}

function getJob(db: Database, id: number): any {
  return db.prepare("SELECT * FROM fleet_internal_jobs WHERE id = ?").get(id);
}

describe("reassignAgentJobs — queued jobs only (default)", () => {
  let db: Database;
  beforeEach(() => { db = makeDb(); });

  it("reassigns queued jobs from fromAgent to toAgent", () => {
    const id = insertJob(db, "agent-a", "do work");
    reassignAgentJobs(db, "agent-a", "agent-b");
    expect(getJob(db, id).target_agent).toBe("agent-b");
  });

  it("returns list of reassigned job ids", () => {
    const id1 = insertJob(db, "agent-a", "task 1");
    const id2 = insertJob(db, "agent-a", "task 2");
    const result = reassignAgentJobs(db, "agent-a", "agent-b");
    expect(result.reassigned).toContain(id1);
    expect(result.reassigned).toContain(id2);
  });

  it("returns skipped=0 when all jobs reassign successfully", () => {
    insertJob(db, "agent-a", "task");
    const result = reassignAgentJobs(db, "agent-a", "agent-b");
    expect(result.skipped).toBe(0);
  });

  it("does not reassign claimed jobs by default", () => {
    const id = insertJob(db, "agent-a", "claimed task", "claimed");
    db.prepare("UPDATE fleet_internal_jobs SET claimed_at = CURRENT_TIMESTAMP, claimed_by = 'agent-a' WHERE id = ?").run(id);
    reassignAgentJobs(db, "agent-a", "agent-b");
    expect(getJob(db, id).target_agent).toBe("agent-a");
  });

  it("does not reassign completed jobs", () => {
    const id = insertJob(db, "agent-a", "done task", "completed");
    reassignAgentJobs(db, "agent-a", "agent-b");
    expect(getJob(db, id).target_agent).toBe("agent-a");
  });

  it("does not reassign jobs from other agents", () => {
    const id = insertJob(db, "agent-c", "other task");
    reassignAgentJobs(db, "agent-a", "agent-b");
    expect(getJob(db, id).target_agent).toBe("agent-c");
  });

  it("returns empty reassigned list when fromAgent has no queued jobs", () => {
    const result = reassignAgentJobs(db, "agent-a", "agent-b");
    expect(result.reassigned).toHaveLength(0);
    expect(result.skipped).toBe(0);
  });

  it("preserves job body and priority after reassignment", () => {
    const id = insertJob(db, "agent-a", "important task", "queued", "urgent");
    reassignAgentJobs(db, "agent-a", "agent-b");
    const job = getJob(db, id);
    expect(job.body).toBe("important task");
    expect(job.priority).toBe("urgent");
  });

  it("sets last_error to reassignment note", () => {
    const id = insertJob(db, "agent-a", "task");
    reassignAgentJobs(db, "agent-a", "agent-b");
    expect(getJob(db, id).last_error).toMatch(/reassigned from/);
  });
});

describe("reassignAgentJobs — with includeClaimed", () => {
  let db: Database;
  beforeEach(() => { db = makeDb(); });

  it("reassigns claimed jobs when includeClaimed=true", () => {
    const id = insertJob(db, "agent-a", "claimed task", "claimed");
    db.prepare("UPDATE fleet_internal_jobs SET claimed_at = CURRENT_TIMESTAMP, claimed_by = 'agent-a' WHERE id = ?").run(id);
    reassignAgentJobs(db, "agent-a", "agent-b", { includeClaimed: true });
    expect(getJob(db, id).target_agent).toBe("agent-b");
  });

  it("resets claimed status to queued after reassignment", () => {
    const id = insertJob(db, "agent-a", "claimed task", "claimed");
    db.prepare("UPDATE fleet_internal_jobs SET claimed_at = CURRENT_TIMESTAMP, claimed_by = 'agent-a' WHERE id = ?").run(id);
    reassignAgentJobs(db, "agent-a", "agent-b", { includeClaimed: true });
    expect(getJob(db, id).status).toBe("queued");
  });

  it("clears claimed_at and claimed_by after reassignment", () => {
    const id = insertJob(db, "agent-a", "claimed task", "claimed");
    db.prepare("UPDATE fleet_internal_jobs SET claimed_at = CURRENT_TIMESTAMP, claimed_by = 'agent-a' WHERE id = ?").run(id);
    reassignAgentJobs(db, "agent-a", "agent-b", { includeClaimed: true });
    const job = getJob(db, id);
    expect(job.claimed_at).toBeNull();
    expect(job.claimed_by).toBeNull();
  });

  it("reassigns both queued and claimed jobs when includeClaimed=true", () => {
    const queued = insertJob(db, "agent-a", "queued task");
    const claimed = insertJob(db, "agent-a", "claimed task", "claimed");
    db.prepare("UPDATE fleet_internal_jobs SET claimed_at = CURRENT_TIMESTAMP WHERE id = ?").run(claimed);
    const result = reassignAgentJobs(db, "agent-a", "agent-b", { includeClaimed: true });
    expect(result.reassigned).toContain(queued);
    expect(result.reassigned).toContain(claimed);
  });
});
