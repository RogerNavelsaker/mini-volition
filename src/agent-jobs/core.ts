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
  db.run(`CREATE TABLE IF NOT EXISTS fleet_job_alarms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_agent TEXT NOT NULL,
    kind TEXT NOT NULL,
    message TEXT NOT NULL,
    due_at DATETIME NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    source_job_id INTEGER,
    fired_at DATETIME,
    cancelled_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`);
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
