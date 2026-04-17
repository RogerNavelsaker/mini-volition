import { Database } from "bun:sqlite";
import { addJobDependency, cascadeCancel, ensureJobSchema, jobDeps, manualUnblock, nextQueuedJob, normalizePriority, pendingBlockers, PRIORITIES, reclaimStaleClaims, unblockDependents } from "./core";
import { appendJobArtifact } from "../state-artifacts/lib";
import { existsSync, readFileSync, readdirSync } from "fs";
import { join, resolve } from "path";

const dbPath = process.env.AGENT_JOBS_DB || join(process.env.META_REPO_ROOT || ".", "runtime/agent-jobs.db");
const db = new Database(dbPath);

const SKILL = `---
name: agent-jobs
description: Per-agent internal job queue for deferred and scheduled work
binary: agent-jobs
source: src/agent-jobs/main.ts
---

# Agent Jobs

Binary: \`agent-jobs\`
Source: \`src/agent-jobs/main.ts\`

Per-agent SQLite queue for internal deferred work.
`;

if (Bun.argv[2] === "skill") {
  console.log(SKILL);
  process.exit(0);
}

const [, , cmd, arg1, arg2, arg3, arg4] = Bun.argv;
const arg5 = Bun.argv[6];

function usage(): never {
  console.error("Usage: agent-jobs <queue|peek|claim|complete|fail|reschedule|wait|block|cancel|resume|depend|cascade-cancel|unblock-job|deps|reclaim-stale|rebuild|verify|list|skill> ...");
  process.exit(64);
}

function stateDir(...parts: string[]) {
  return join(resolve(process.cwd(), process.env.FLEET_STATE_DIR || join(process.env.META_REPO_ROOT || ".", "state")), ...parts);
}

function readJsonl(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function rebuildJobs(agent?: string) {
  const jobsRoot = stateDir("jobs");
  const agents = agent
    ? [agent]
    : existsSync(jobsRoot)
      ? readdirSync(jobsRoot, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
        .map((entry) => entry.name.replace(/\.jsonl$/, ""))
      : [];
  const rebuilt: Array<Record<string, unknown>> = [];
  db.exec("BEGIN IMMEDIATE;");
  try {
    const allDeps: Array<{ dependent_job_id: number; blocking_job_id: number }> = [];
    for (const name of agents) {
      db.prepare("DELETE FROM fleet_job_dependencies WHERE dependent_job_id IN (SELECT id FROM fleet_internal_jobs WHERE target_agent = ?)").run(name);
      db.prepare("DELETE FROM fleet_internal_jobs WHERE target_agent = ?").run(name);
      const rows = readJsonl(stateDir("jobs", `${name}.jsonl`));
      const latestById = new Map<number, any>();
      for (const row of rows) {
        if (row.record_type === "job" && row.job && typeof row.job === "object") {
          const job = row.job as any;
          if (job.id != null) latestById.set(Number(job.id), job);
        } else if (row.record_type === "job_claim_recovery" && Array.isArray(row.reclaimed_ids)) {
          for (const id of row.reclaimed_ids as unknown[]) {
            const current = latestById.get(Number(id));
            if (!current) continue;
            latestById.set(Number(id), {
              ...current,
              status: "queued",
              claimed_at: null,
              claimed_by: null,
              completed_at: null,
              last_error: "stale claim recovered",
              updated_at: row.recorded_at ?? current.updated_at,
            });
          }
        } else if (row.record_type === "job_dependency" && row.dependent_job_id != null && row.blocking_job_id != null) {
          allDeps.push({ dependent_job_id: Number(row.dependent_job_id), blocking_job_id: Number(row.blocking_job_id) });
        }
      }
      const insert = db.prepare(
        `INSERT INTO fleet_internal_jobs (
           id, target_agent, sender, body, priority, available_at, status,
           wait_reason, blocked_on, claimed_at, claimed_by, completed_at, cancelled_at, last_error, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const job of [...latestById.values()].sort((a, b) => Number(a.id) - Number(b.id))) {
        insert.run(
          job.id,
          job.target_agent,
          job.sender,
          job.body,
          job.priority ?? "normal",
          job.available_at ?? null,
          job.status ?? "queued",
          job.wait_reason ?? null,
          job.blocked_on ?? null,
          job.claimed_at ?? null,
          job.claimed_by ?? null,
          job.completed_at ?? null,
          job.cancelled_at ?? null,
          job.last_error ?? null,
          job.created_at ?? job.updated_at ?? new Date().toISOString(),
          job.updated_at ?? job.created_at ?? new Date().toISOString(),
        );
      }
      rebuilt.push({ agent: name, records: rows.length, jobs: latestById.size });
    }
    const insertDep = db.prepare(
      `INSERT OR IGNORE INTO fleet_job_dependencies (dependent_job_id, blocking_job_id) VALUES (?, ?)`,
    );
    for (const dep of allDeps) {
      try { insertDep.run(dep.dependent_job_id, dep.blocking_job_id); } catch { /* missing job — skip */ }
    }
    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
  console.log(JSON.stringify({ rebuilt }));
}

function verifyJobs(agent?: string) {
  const jobsRoot = stateDir("jobs");
  const agents = agent
    ? [agent]
    : existsSync(jobsRoot)
      ? readdirSync(jobsRoot, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
        .map((entry) => entry.name.replace(/\.jsonl$/, ""))
      : [];
  const verified = agents.map((name) => {
    const rows = readJsonl(stateDir("jobs", `${name}.jsonl`));
    const expected = new Map<number, any>();
    for (const row of rows) {
      if (row.record_type === "job" && row.job && typeof row.job === "object") {
        const job = row.job as any;
        if (job.id != null) expected.set(Number(job.id), job);
      } else if (row.record_type === "job_claim_recovery" && Array.isArray(row.reclaimed_ids)) {
        for (const id of row.reclaimed_ids as unknown[]) {
          const current = expected.get(Number(id));
          if (!current) continue;
          expected.set(Number(id), { ...current, status: "queued", claimed_at: null, claimed_by: null, completed_at: null, last_error: "stale claim recovered" });
        }
      }
    }
    const actualRows = db.prepare("SELECT id, status, target_agent, wait_reason, blocked_on, claimed_by, completed_at, cancelled_at, last_error FROM fleet_internal_jobs WHERE target_agent = ? ORDER BY id ASC").all(name) as any[];
    const actual = new Map(actualRows.map((row) => [Number(row.id), row]));
    const missing = [...expected.keys()].filter((id) => !actual.has(id));
    const extra = [...actual.keys()].filter((id) => !expected.has(id));
    const mismatched = [...expected.entries()]
      .filter(([id, job]) => {
        const row = actual.get(id);
        return row && (
          row.status !== (job.status ?? "queued")
          || row.target_agent !== job.target_agent
          || (row.wait_reason ?? null) !== (job.wait_reason ?? null)
          || (row.blocked_on ?? null) !== (job.blocked_on ?? null)
          || (row.claimed_by ?? null) !== (job.claimed_by ?? null)
          || (row.cancelled_at ?? null) !== (job.cancelled_at ?? null)
          || (row.last_error ?? null) !== (job.last_error ?? null)
        );
      })
      .map(([id]) => id);
    const issues = [
      missing.length ? `missing job ids: ${missing.join(",")}` : null,
      extra.length ? `extra job ids: ${extra.join(",")}` : null,
      mismatched.length ? `mismatched job ids: ${mismatched.join(",")}` : null,
    ].filter(Boolean);
    return {
      agent: name,
      ok: issues.length === 0,
      expected_jobs: expected.size,
      actual_jobs: actual.size,
      missing_ids: missing,
      extra_ids: extra,
      mismatched_ids: mismatched,
      issues,
      repair: issues.length === 0 ? null : `agent-jobs rebuild ${name}`,
    };
  });
  console.log(JSON.stringify({ verified }));
}
ensureJobSchema(db);

if (cmd === "queue") {
  if (!arg1 || !arg2 || !arg3) {
    console.error("Usage: agent-jobs queue <targetAgent> <sender> <body> [priority] [availableAt]");
    process.exit(64);
  }
  const priority = normalizePriority(arg4);
  db.run(
    `INSERT INTO fleet_internal_jobs (target_agent, sender, body, priority, available_at, status, updated_at)
     VALUES (?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), 'queued', CURRENT_TIMESTAMP)`,
    [arg1, arg2, arg3, priority, arg5 ?? null],
  );
  const queued = db.prepare("SELECT * FROM fleet_internal_jobs WHERE id = last_insert_rowid()").get() as any;
  appendJobArtifact(arg1, {
    record_type: "job",
    event: "queued",
    job: queued,
  });
  console.log(JSON.stringify(queued ?? null));
} else if (cmd === "peek") {
  if (!arg1) {
    console.error("Usage: agent-jobs peek <agent>");
    process.exit(64);
  }
  console.log(JSON.stringify(nextQueuedJob(db, arg1) ?? null));
} else if (cmd === "claim") {
  if (!arg1) {
    console.error("Usage: agent-jobs claim <agent> [jobId]");
    process.exit(64);
  }
  const requestedId = arg2 ? Math.max(1, parseInt(arg2, 10) || 0) : null;
  const job = requestedId
    ? db.prepare(
        `SELECT * FROM fleet_internal_jobs
         WHERE id = ?
           AND target_agent = ?
           AND status = 'queued'
           AND datetime(COALESCE(available_at, CURRENT_TIMESTAMP)) <= CURRENT_TIMESTAMP`,
      ).get(requestedId, arg1) as any
    : nextQueuedJob(db, arg1);
  if (!job) {
    console.log("null");
    process.exit(0);
  }
  db.run(
    `UPDATE fleet_internal_jobs
     SET status = 'claimed',
         wait_reason = NULL,
         blocked_on = NULL,
         claimed_at = CURRENT_TIMESTAMP,
         claimed_by = ?,
         cancelled_at = NULL,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND status = 'queued'`,
    [arg1, job.id],
  );
  const claimed = db.prepare("SELECT * FROM fleet_internal_jobs WHERE id = ?").get(job.id) as any;
  if (claimed?.status === "claimed" && claimed?.claimed_by === arg1) {
    appendJobArtifact(arg1, {
      record_type: "job",
      event: "claimed",
      job: claimed,
    });
  }
  console.log(JSON.stringify(claimed?.status === "claimed" && claimed?.claimed_by === arg1 ? claimed : null));
} else if (cmd === "complete") {
  if (!arg1 || !arg2) {
    console.error("Usage: agent-jobs complete <jobId> <agent>");
    process.exit(64);
  }
  db.run(
    `UPDATE fleet_internal_jobs
     SET status = 'completed',
         wait_reason = NULL,
         blocked_on = NULL,
         completed_at = CURRENT_TIMESTAMP,
         claimed_by = COALESCE(claimed_by, ?),
         cancelled_at = NULL,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [arg2, Number(arg1)],
  );
  const completed = db.prepare("SELECT * FROM fleet_internal_jobs WHERE id = ?").get(Number(arg1)) as any;
  const unblocked = unblockDependents(db, Number(arg1));
  appendJobArtifact(arg2, {
    record_type: "job",
    event: "completed",
    job: completed,
    unblocked_job_ids: unblocked,
  });
  console.log(JSON.stringify({ ...completed, unblocked_job_ids: unblocked } ?? null));
} else if (cmd === "fail") {
  if (!arg1 || !arg2) {
    console.error("Usage: agent-jobs fail <jobId> <agent> [error]");
    process.exit(64);
  }
  db.run(
    `UPDATE fleet_internal_jobs
     SET status = 'failed',
         wait_reason = NULL,
         blocked_on = NULL,
         claimed_by = COALESCE(claimed_by, ?),
         cancelled_at = NULL,
         last_error = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [arg2, arg3 ?? null, Number(arg1)],
  );
  const failed = db.prepare("SELECT * FROM fleet_internal_jobs WHERE id = ?").get(Number(arg1)) as any;
  appendJobArtifact(arg2, {
    record_type: "job",
    event: "failed",
    job: failed,
  });
  console.log(JSON.stringify(failed ?? null));
} else if (cmd === "reschedule") {
  if (!arg1 || !arg2) {
    console.error("Usage: agent-jobs reschedule <jobId> <agent> [availableAt] [error]");
    process.exit(64);
  }
  db.run(
    `UPDATE fleet_internal_jobs
     SET status = 'queued',
         available_at = COALESCE(NULLIF(?, ''), available_at, CURRENT_TIMESTAMP),
         wait_reason = NULL,
         blocked_on = NULL,
         claimed_at = NULL,
         claimed_by = NULL,
         completed_at = NULL,
         cancelled_at = NULL,
         last_error = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [arg3 ?? null, arg4 ?? null, Number(arg1)],
  );
  const rescheduled = db.prepare("SELECT * FROM fleet_internal_jobs WHERE id = ?").get(Number(arg1)) as any;
  appendJobArtifact(arg2, {
    record_type: "job",
    event: "rescheduled",
    job: rescheduled,
  });
  console.log(JSON.stringify(rescheduled ?? null));
} else if (cmd === "wait") {
  if (!arg1 || !arg2) {
    console.error("Usage: agent-jobs wait <jobId> <agent> <reason> [availableAt]");
    process.exit(64);
  }
  db.run(
    `UPDATE fleet_internal_jobs
     SET status = 'waiting',
         wait_reason = ?,
         blocked_on = NULL,
         available_at = COALESCE(NULLIF(?, ''), available_at, CURRENT_TIMESTAMP),
         claimed_at = NULL,
         claimed_by = NULL,
         completed_at = NULL,
         cancelled_at = NULL,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [arg3 ?? "waiting", arg4 ?? null, Number(arg1)],
  );
  const waiting = db.prepare("SELECT * FROM fleet_internal_jobs WHERE id = ?").get(Number(arg1)) as any;
  appendJobArtifact(arg2, { record_type: "job", event: "waiting", job: waiting });
  console.log(JSON.stringify(waiting ?? null));
} else if (cmd === "block") {
  if (!arg1 || !arg2) {
    console.error("Usage: agent-jobs block <jobId> <agent> <blockedOn>");
    process.exit(64);
  }
  db.run(
    `UPDATE fleet_internal_jobs
     SET status = 'blocked',
         blocked_on = ?,
         wait_reason = NULL,
         claimed_at = NULL,
         claimed_by = NULL,
         completed_at = NULL,
         cancelled_at = NULL,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [arg3 ?? "unknown", Number(arg1)],
  );
  const blocked = db.prepare("SELECT * FROM fleet_internal_jobs WHERE id = ?").get(Number(arg1)) as any;
  appendJobArtifact(arg2, { record_type: "job", event: "blocked", job: blocked });
  console.log(JSON.stringify(blocked ?? null));
} else if (cmd === "cancel") {
  if (!arg1 || !arg2) {
    console.error("Usage: agent-jobs cancel <jobId> <agent> [reason]");
    process.exit(64);
  }
  db.run(
    `UPDATE fleet_internal_jobs
     SET status = 'cancelled',
         wait_reason = NULL,
         blocked_on = NULL,
         claimed_at = NULL,
         claimed_by = COALESCE(claimed_by, ?),
         completed_at = NULL,
         cancelled_at = CURRENT_TIMESTAMP,
         last_error = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [arg2, arg3 ?? "cancelled", Number(arg1)],
  );
  const cancelled = db.prepare("SELECT * FROM fleet_internal_jobs WHERE id = ?").get(Number(arg1)) as any;
  const unblockedOnCancel = unblockDependents(db, Number(arg1));
  appendJobArtifact(arg2, { record_type: "job", event: "cancelled", job: cancelled, unblocked_job_ids: unblockedOnCancel });
  console.log(JSON.stringify({ ...cancelled, unblocked_job_ids: unblockedOnCancel } ?? null));
} else if (cmd === "resume") {
  if (!arg1 || !arg2) {
    console.error("Usage: agent-jobs resume <jobId> <agent> [availableAt]");
    process.exit(64);
  }
  db.run(
    `UPDATE fleet_internal_jobs
     SET status = 'queued',
         available_at = COALESCE(NULLIF(?, ''), available_at, CURRENT_TIMESTAMP),
         wait_reason = NULL,
         blocked_on = NULL,
         claimed_at = NULL,
         claimed_by = NULL,
         completed_at = NULL,
         cancelled_at = NULL,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [arg3 ?? null, Number(arg1)],
  );
  const resumed = db.prepare("SELECT * FROM fleet_internal_jobs WHERE id = ?").get(Number(arg1)) as any;
  appendJobArtifact(arg2, { record_type: "job", event: "resumed", job: resumed });
  console.log(JSON.stringify(resumed ?? null));
} else if (cmd === "depend") {
  if (!arg1 || !arg2 || !arg3) {
    console.error("Usage: agent-jobs depend <dependentJobId> <blockingJobId> <agent>");
    process.exit(64);
  }
  const depJobId = Number(arg1);
  const blockJobId = Number(arg2);
  addJobDependency(db, depJobId, blockJobId);
  db.run(
    `UPDATE fleet_internal_jobs
     SET status = 'blocked',
         blocked_on = ?,
         wait_reason = NULL,
         claimed_at = NULL,
         claimed_by = NULL,
         completed_at = NULL,
         cancelled_at = NULL,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND status NOT IN ('completed', 'cancelled', 'failed')`,
    [String(blockJobId), depJobId],
  );
  const dep = db.prepare("SELECT * FROM fleet_internal_jobs WHERE id = ?").get(depJobId) as any;
  appendJobArtifact(arg3, {
    record_type: "job_dependency",
    event: "depend",
    dependent_job_id: depJobId,
    blocking_job_id: blockJobId,
    job: dep,
  });
  console.log(JSON.stringify({ dependent_job_id: depJobId, blocking_job_id: blockJobId, job: dep }));
} else if (cmd === "cascade-cancel") {
  if (!arg1 || !arg2) {
    console.error("Usage: agent-jobs cascade-cancel <jobId> <agent> [reason]");
    process.exit(64);
  }
  const reason = arg3 ?? "cascade cancelled";
  const cancelled = cascadeCancel(db, Number(arg1), reason);
  for (const id of cancelled) {
    const job = db.prepare("SELECT * FROM fleet_internal_jobs WHERE id = ?").get(id) as any;
    appendJobArtifact(arg2, { record_type: "job", event: "cancelled", job, cascade_root: Number(arg1) });
  }
  console.log(JSON.stringify({ cascade_root: Number(arg1), cancelled_ids: cancelled }));
} else if (cmd === "unblock-job") {
  if (!arg1 || !arg2) {
    console.error("Usage: agent-jobs unblock-job <jobId> <agent>");
    process.exit(64);
  }
  const changed = manualUnblock(db, Number(arg1));
  const job = db.prepare("SELECT * FROM fleet_internal_jobs WHERE id = ?").get(Number(arg1)) as any;
  if (changed) {
    appendJobArtifact(arg2, { record_type: "job", event: "unblocked", job, manual: true });
  }
  console.log(JSON.stringify({ job_id: Number(arg1), unblocked: changed, job }));
} else if (cmd === "deps") {
  if (!arg1) {
    console.error("Usage: agent-jobs deps <jobId>");
    process.exit(64);
  }
  const deps = jobDeps(db, Number(arg1));
  console.log(JSON.stringify({ job_id: Number(arg1), ...deps }));
} else if (cmd === "reclaim-stale") {
  if (!arg1) {
    console.error("Usage: agent-jobs reclaim-stale <agent> [ttlMs]");
    process.exit(64);
  }
  const ttlMs = Math.max(30_000, parseInt(arg2 || process.env.FLEET_JOB_CLAIM_TTL_MS || "300000", 10) || 300000);
  const reclaimed = reclaimStaleClaims(db, arg1, ttlMs);
  if (reclaimed.length > 0) {
    appendJobArtifact(arg1, {
      record_type: "job_claim_recovery",
      event: "reclaim_stale",
      ttl_ms: ttlMs,
      reclaimed_ids: reclaimed,
    });
  }
  console.log(JSON.stringify({ agent: arg1, ttl_ms: ttlMs, reclaimed_ids: reclaimed }));
} else if (cmd === "rebuild") {
  rebuildJobs(arg1);
} else if (cmd === "verify") {
  verifyJobs(arg1);
} else if (cmd === "list") {
  const limit = Math.max(1, parseInt(arg2 || "20", 10) || 20);
  if (arg1) {
    console.log(JSON.stringify(db.prepare("SELECT * FROM fleet_internal_jobs WHERE target_agent = ? ORDER BY id DESC LIMIT ?").all(arg1, limit)));
  } else {
    console.log(JSON.stringify(db.prepare("SELECT * FROM fleet_internal_jobs ORDER BY id DESC LIMIT ?").all(limit)));
  }
} else {
  usage();
}
