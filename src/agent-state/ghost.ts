import type { Database } from "bun:sqlite";

export const ACTIVE_STATUSES = ["thinking", "sleeping", "rate_limited", "cooldown"] as const;
export type ActiveStatus = typeof ACTIVE_STATUSES[number];

export interface GhostRecord {
  agent_name: string;
  status: string;
  current_task: string | null;
  updated_at: string;
  stale_ms: number;
}

export function detectGhosts(db: Database, staleMs: number): GhostRecord[] {
  const placeholders = ACTIVE_STATUSES.map(() => "?").join(", ");
  const threshold = new Date(Date.now() - staleMs).toISOString().replace("T", " ").slice(0, 19);
  const rows = db.prepare(
    `SELECT agent_name, status, current_task, updated_at
     FROM fleet_agent_state
     WHERE status IN (${placeholders})
       AND updated_at < ?`,
  ).all(...ACTIVE_STATUSES, threshold) as Array<{
    agent_name: string;
    status: string;
    current_task: string | null;
    updated_at: string;
  }>;
  const now = Date.now();
  return rows.map((row) => {
    const updatedMs = new Date(row.updated_at.endsWith("Z") ? row.updated_at : `${row.updated_at}Z`).getTime();
    return {
      ...row,
      stale_ms: Number.isFinite(updatedMs) ? now - updatedMs : staleMs,
    };
  });
}

export function markGhost(
  db: Database,
  agentName: string,
  reason = "stale active status — process likely dead",
): boolean {
  const result = db.prepare(
    `UPDATE fleet_agent_state
     SET status = 'ghost', last_error = ?, updated_at = CURRENT_TIMESTAMP
     WHERE agent_name = ? AND status IN (${ACTIVE_STATUSES.map(() => "?").join(", ")})`,
  ).run(reason, agentName, ...ACTIVE_STATUSES);
  return result.changes > 0;
}

let _ghostSeq = 0;

export function recordGhostTransition(
  db: Database,
  agentName: string,
  ghostReason: string,
) {
  const turnKey = `ghost:${agentName}:${Date.now()}:${++_ghostSeq}`;
  db.prepare(
    `INSERT INTO fleet_turn_journal (agent_name, turn_key, wake_source, wake_reason, message_id, phase, detail)
     VALUES (?, ?, 'ghost_check', 'ghost_detected', NULL, 'failed', ?)`,
  ).run(agentName, turnKey, ghostReason);
}
