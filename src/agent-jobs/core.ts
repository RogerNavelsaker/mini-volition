import type { Database } from "bun:sqlite";

export const PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type JobPriority = (typeof PRIORITIES)[number];

export function ensureJobSchema(db: Database) {
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.run(`CREATE TABLE IF NOT EXISTS fleet_internal_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_agent TEXT NOT NULL,
    sender TEXT NOT NULL,
    body TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'normal',
    available_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    status TEXT NOT NULL DEFAULT 'queued',
    wait_reason TEXT,
    blocked_on TEXT,
    claimed_at DATETIME,
    claimed_by TEXT,
    completed_at DATETIME,
    cancelled_at DATETIME,
    last_error TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`);
  db.run(`CREATE TABLE IF NOT EXISTS fleet_job_dependencies (
    dependent_job_id INTEGER NOT NULL REFERENCES fleet_internal_jobs(id),
    blocking_job_id  INTEGER NOT NULL REFERENCES fleet_internal_jobs(id),
    created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (dependent_job_id, blocking_job_id)
  );`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_job_deps_blocking
    ON fleet_job_dependencies (blocking_job_id);`);
}

export function addJobDependency(db: Database, dependentJobId: number, blockingJobId: number) {
  db.run(
    `INSERT OR IGNORE INTO fleet_job_dependencies (dependent_job_id, blocking_job_id)
     VALUES (?, ?)`,
    [dependentJobId, blockingJobId],
  );
}

export function pendingBlockers(db: Database, dependentJobId: number): number {
  const row = db.prepare(
    `SELECT COUNT(*) as cnt
     FROM fleet_job_dependencies d
     JOIN fleet_internal_jobs j ON j.id = d.blocking_job_id
     WHERE d.dependent_job_id = ?
       AND j.status NOT IN ('completed', 'cancelled')`,
  ).get(dependentJobId) as { cnt: number };
  return row?.cnt ?? 0;
}

export function unblockDependents(db: Database, completedJobId: number): number[] {
  const candidates = db.prepare(
    `SELECT d.dependent_job_id
     FROM fleet_job_dependencies d
     WHERE d.blocking_job_id = ?`,
  ).all(completedJobId) as Array<{ dependent_job_id: number }>;

  const unblocked: number[] = [];
  for (const { dependent_job_id } of candidates) {
    if (pendingBlockers(db, dependent_job_id) === 0) {
      const result = db.run(
        `UPDATE fleet_internal_jobs
         SET status = 'queued',
             blocked_on = NULL,
             wait_reason = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND status IN ('blocked', 'waiting')`,
        [dependent_job_id],
      );
      if (result.changes > 0) unblocked.push(dependent_job_id);
    }
  }
  return unblocked;
}

export function cascadeCancel(
  db: Database,
  jobId: number,
  reason: string,
  visited = new Set<number>(),
): number[] {
  if (visited.has(jobId)) return [];
  visited.add(jobId);

  const result = db.run(
    `UPDATE fleet_internal_jobs
     SET status = 'cancelled',
         wait_reason = NULL,
         blocked_on = NULL,
         claimed_at = NULL,
         cancelled_at = CURRENT_TIMESTAMP,
         last_error = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND status NOT IN ('completed', 'cancelled')`,
    [reason, jobId],
  );

  const cancelled = result.changes > 0 ? [jobId] : [];
  const dependents = db.prepare(
    `SELECT d.dependent_job_id
     FROM fleet_job_dependencies d
     JOIN fleet_internal_jobs j ON j.id = d.dependent_job_id
     WHERE d.blocking_job_id = ? AND j.status NOT IN ('completed', 'cancelled')`,
  ).all(jobId) as Array<{ dependent_job_id: number }>;

  for (const { dependent_job_id } of dependents) {
    cancelled.push(...cascadeCancel(db, dependent_job_id, `cascade from ${jobId}: ${reason}`, visited));
  }
  return cancelled;
}

export function manualUnblock(db: Database, jobId: number): boolean {
  const result = db.run(
    `UPDATE fleet_internal_jobs
     SET status = 'queued',
         blocked_on = NULL,
         wait_reason = NULL,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND status IN ('blocked', 'waiting')`,
    [jobId],
  );
  return result.changes > 0;
}

export interface JobDeps {
  blockedBy: Array<{ id: number; status: string }>;
  blocking: Array<{ id: number; status: string }>;
}

export function jobDeps(db: Database, jobId: number): JobDeps {
  const blockedBy = db.prepare(
    `SELECT j.id, j.status
     FROM fleet_job_dependencies d
     JOIN fleet_internal_jobs j ON j.id = d.blocking_job_id
     WHERE d.dependent_job_id = ?
     ORDER BY j.id ASC`,
  ).all(jobId) as Array<{ id: number; status: string }>;

  const blocking = db.prepare(
    `SELECT j.id, j.status
     FROM fleet_job_dependencies d
     JOIN fleet_internal_jobs j ON j.id = d.dependent_job_id
     WHERE d.blocking_job_id = ?
     ORDER BY j.id ASC`,
  ).all(jobId) as Array<{ id: number; status: string }>;

  return { blockedBy, blocking };
}

export function normalizePriority(value: string | undefined | null): JobPriority {
  return PRIORITIES.includes((value ?? "") as JobPriority) ? (value as JobPriority) : "normal";
}

export function nextQueuedJob(db: Database, agent: string) {
  return db.prepare(
    `SELECT * FROM fleet_internal_jobs
     WHERE target_agent = ?
       AND status = 'queued'
       AND datetime(COALESCE(available_at, CURRENT_TIMESTAMP)) <= CURRENT_TIMESTAMP
     ORDER BY
       CASE priority
         WHEN 'urgent' THEN 4
         WHEN 'high' THEN 3
         WHEN 'normal' THEN 2
         ELSE 1
       END DESC,
       datetime(COALESCE(available_at, CURRENT_TIMESTAMP)) ASC,
       id ASC
     LIMIT 1`,
  ).get(agent) as any;
}

export function reclaimStaleClaims(db: Database, agent: string, ttlMs: number) {
  const minTtlMs = Math.max(30_000, ttlMs || 0);
  const jobs = db.prepare(
    `SELECT id, claimed_at
     FROM fleet_internal_jobs
     WHERE target_agent = ?
       AND status = 'claimed'
       AND claimed_at IS NOT NULL`,
  ).all(agent) as Array<{ id: number; claimed_at: string }>;
  const reclaimed: number[] = [];
  for (const job of jobs) {
    const claimedAtMs = new Date(job.claimed_at.endsWith("Z") ? job.claimed_at : `${job.claimed_at}Z`).getTime();
    if (!Number.isFinite(claimedAtMs)) continue;
    if ((Date.now() - claimedAtMs) < minTtlMs) continue;
    db.run(
      `UPDATE fleet_internal_jobs
       SET status = 'queued',
           claimed_at = NULL,
           claimed_by = NULL,
           completed_at = NULL,
           last_error = 'stale claim recovered',
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?
         AND target_agent = ?
         AND status = 'claimed'`,
      [job.id, agent],
    );
    reclaimed.push(job.id);
  }
  return reclaimed;
}
