import { execFileSync } from "child_process";
import type { Database } from "bun:sqlite";

export type RefreshState = {
  agent_name: string;
  last_status: string | null;
  last_error: string | null;
  artifact_count: number;
  error_streak?: number | null;
};

export function ensureLibrarianSchema(memoryDb: Database, librarianDb: Database) {
  memoryDb.run(`CREATE TABLE IF NOT EXISTS agent_memory_refresh_state (
    agent_name TEXT PRIMARY KEY,
    last_refresh_at DATETIME,
    last_status TEXT,
    last_error TEXT,
    artifact_count INTEGER NOT NULL DEFAULT 0,
    source TEXT,
    error_streak INTEGER NOT NULL DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`);
  librarianDb.run(`CREATE TABLE IF NOT EXISTS fleet_maintenance_journal (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_name TEXT NOT NULL,
    task TEXT NOT NULL,
    phase TEXT NOT NULL,
    detail TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`);
  librarianDb.run(`CREATE TABLE IF NOT EXISTS fleet_event_listener_cursor (
    event_type TEXT PRIMARY KEY,
    last_id INTEGER NOT NULL DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`);
}

export function pollBurstFlushEvents(fleetDb: Database, librarianDb: Database, jobsDb: Database, jobsBin: string) {
  const cursor = (librarianDb.prepare(
    `SELECT last_id FROM fleet_event_listener_cursor WHERE event_type = 'burst_flushed'`,
  ).get() as { last_id: number } | null)?.last_id ?? 0;

  const rows = fleetDb.prepare(
    `SELECT id, agent_name FROM fleet_event_log WHERE event_type = 'burst_flushed' AND id > ? ORDER BY id ASC LIMIT 50`,
  ).all(cursor) as Array<{ id: number; agent_name: string | null }>;

  if (rows.length === 0) return;

  for (const row of rows) {
    if (!row.agent_name) continue;
    const existing = jobsDb.prepare(
      `SELECT id FROM fleet_internal_jobs WHERE target_agent = ? AND sender = 'fleet-librarian' AND body = '__maintenance__:digest' AND status IN ('queued', 'claimed') LIMIT 1`,
    ).get(row.agent_name) as { id: number } | null;
    if (!existing) {
      try {
        execFileSync(jobsBin, ["queue", row.agent_name, "fleet-librarian", "__maintenance__:digest", "normal"], { stdio: "ignore" });
        recordMaintenance(librarianDb, row.agent_name, "digest", "queued", `event:${row.id}`);
      } catch (error) {
        recordMaintenance(librarianDb, row.agent_name, "digest", "queue_failed", error instanceof Error ? error.message : String(error));
      }
    }
  }

  const maxId = rows[rows.length - 1].id;
  librarianDb.prepare(
    `INSERT INTO fleet_event_listener_cursor (event_type, last_id, updated_at) VALUES ('burst_flushed', ?, CURRENT_TIMESTAMP)
     ON CONFLICT(event_type) DO UPDATE SET last_id = excluded.last_id, updated_at = excluded.updated_at`,
  ).run(maxId);
}

export function recordMaintenance(librarianDb: Database, agentName: string, task: string, phase: string, detail: string | null = null) {
  librarianDb.run(
    `INSERT INTO fleet_maintenance_journal (agent_name, task, phase, detail)
     VALUES (?, ?, ?, ?)`,
    [agentName, task, phase, detail],
  );
}

export function knownAgents(stateDb: Database): string[] {
  const rows = stateDb.prepare(
    `SELECT DISTINCT agent_name
     FROM fleet_agent_state
     WHERE agent_name IS NOT NULL
       AND agent_name != ''
       AND agent_name NOT IN ('digest')`,
  ).all() as Array<{ agent_name: string }>;
  return rows.map((row) => row.agent_name).filter(Boolean).sort();
}

export function currentRefreshState(memoryDb: Database, agentName: string): RefreshState | null {
  return (memoryDb.prepare("SELECT * FROM agent_memory_refresh_state WHERE agent_name = ?").get(agentName) as RefreshState | null) ?? null;
}

export function recoverStaleMaintenanceJobs(librarianDb: Database, jobsBin: string, agents: string[], staleClaimMs: number) {
  for (const agentName of agents) {
    try {
      const output = execFileSync(jobsBin, ["reclaim-stale", agentName, String(staleClaimMs)], { encoding: "utf-8" }).trim();
      const parsed = output ? JSON.parse(output) as { reclaimed_ids?: number[] } : null;
      for (const jobId of parsed?.reclaimed_ids ?? []) {
        recordMaintenance(librarianDb, agentName, "unknown", "recovered_stale_claim", `job:${jobId}`);
      }
    } catch (error) {
      console.error(`Failed to reclaim stale jobs for ${agentName}`, error);
    }
  }
}

export function queueMaintenanceJob(librarianDb: Database, jobsDb: Database, jobsBin: string, agentName: string) {
  const existing = jobsDb.prepare(
    `SELECT id
     FROM fleet_internal_jobs
     WHERE target_agent = ?
       AND sender = 'fleet-librarian'
       AND body = '__maintenance__:memory'
       AND status IN ('queued', 'claimed')
     LIMIT 1`,
  ).get(agentName) as { id: number } | null;
  if (existing) return;
  try {
    execFileSync(jobsBin, ["queue", agentName, "fleet-librarian", "__maintenance__:memory", "low"], { stdio: "ignore" });
    recordMaintenance(librarianDb, agentName, "memory", "queued");
  } catch (error) {
    recordMaintenance(librarianDb, agentName, "memory", "queue_failed", error instanceof Error ? error.message : String(error));
    console.error(`Failed to queue maintenance job for ${agentName}`, error);
  }
}

export function maybeQueueExtraction(memoryDb: Database, librarianDb: Database, jobsDb: Database, jobsBin: string, agentName: string) {
  // Check if there are compaction items without associated facts
  const unextracted = memoryDb.prepare(
    `SELECT COUNT(*) AS count
     FROM agent_memory_compaction_items ci
     LEFT JOIN agent_memory_facts f ON f.source_item_id = ci.id AND f.agent_name = ci.agent_name
     WHERE ci.agent_name = ?
       AND ci.status = 'active'
       AND f.id IS NULL`,
  ).get(agentName) as { count: number } | null;
  if (!unextracted?.count || unextracted.count < 3) return;
  const existing = jobsDb.prepare(
    `SELECT id
     FROM fleet_internal_jobs
     WHERE target_agent = ?
       AND sender = 'fleet-librarian'
       AND body = '__maintenance__:extract'
       AND status IN ('queued', 'claimed')
     LIMIT 1`,
  ).get(agentName) as { id: number } | null;
  if (existing) return;
  try {
    execFileSync(jobsBin, ["queue", agentName, "fleet-librarian", "__maintenance__:extract", "low"], { stdio: "ignore" });
    recordMaintenance(librarianDb, agentName, "extract", "queued");
  } catch (error) {
    recordMaintenance(librarianDb, agentName, "extract", "queue_failed", error instanceof Error ? error.message : String(error));
  }
}

export function maybeQueueRepair(memoryDb: Database, librarianDb: Database, jobsDb: Database, jobsBin: string, agentName: string, repairErrorThreshold: number) {
  const state = currentRefreshState(memoryDb, agentName);
  const nextStreak = state?.error_streak ?? 0;
  if (nextStreak < repairErrorThreshold) return;
  const existing = jobsDb.prepare(
    `SELECT id
     FROM fleet_internal_jobs
     WHERE target_agent = ?
       AND sender = 'fleet-librarian'
       AND body = '__maintenance__:repair'
       AND status IN ('queued', 'claimed')
     LIMIT 1`,
  ).get(agentName) as { id: number } | null;
  if (existing) return;
  try {
    execFileSync(jobsBin, ["queue", agentName, "fleet-librarian", "__maintenance__:repair", "high"], { stdio: "ignore" });
    recordMaintenance(librarianDb, agentName, "repair", "queued");
  } catch (error) {
    recordMaintenance(librarianDb, agentName, "repair", "queue_failed", error instanceof Error ? error.message : String(error));
    console.error(`Failed to queue repair job for ${agentName}`, error);
  }
}
