import type { Database } from "bun:sqlite";

export type SpawnRecord = {
  id: number;
  agent_name: string;
  model: string;
  socket: string;
  status: "active" | "despawned";
  spawned_at: string;
  despawned_at: string | null;
  reason: string | null;
};

export type SpawnResult =
  | { ok: true; record: SpawnRecord }
  | { ok: false; error: string };

export type DespawnResult =
  | { ok: true; record: SpawnRecord }
  | { ok: false; error: string };

export function ensureSpawnSchema(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS fleet_agent_spawns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_name TEXT NOT NULL,
    model TEXT NOT NULL,
    socket TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    spawned_at TEXT NOT NULL,
    despawned_at TEXT,
    reason TEXT
  );`);
  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_fleet_spawns_active
    ON fleet_agent_spawns (agent_name)
    WHERE status = 'active';`);
}

export function getActiveSpawn(db: Database, agentName: string): SpawnRecord | null {
  return (db.prepare(
    `SELECT * FROM fleet_agent_spawns WHERE agent_name = ? AND status = 'active' LIMIT 1`,
  ).get(agentName) as SpawnRecord | null) ?? null;
}

export function listActiveSpawns(db: Database): SpawnRecord[] {
  return db.prepare(
    `SELECT * FROM fleet_agent_spawns WHERE status = 'active' ORDER BY spawned_at ASC`,
  ).all() as SpawnRecord[];
}

export function recordSpawn(
  db: Database,
  agentName: string,
  model: string,
  socket: string,
  reason: string | null = null,
  nowIso: string = new Date().toISOString(),
): SpawnResult {
  if (!agentName.trim()) return { ok: false, error: "agent_name is required" };
  if (!model.trim()) return { ok: false, error: "model is required" };
  if (!socket.trim()) return { ok: false, error: "socket is required" };

  const existing = getActiveSpawn(db, agentName);
  if (existing) return { ok: false, error: `agent '${agentName}' is already active` };

  const record = db.prepare(
    `INSERT INTO fleet_agent_spawns (agent_name, model, socket, status, spawned_at, reason)
     VALUES (?, ?, ?, 'active', ?, ?)
     RETURNING *`,
  ).get(agentName, model, socket, nowIso, reason) as SpawnRecord;

  return { ok: true, record };
}

export function recordDespawn(
  db: Database,
  agentName: string,
  reason: string | null = null,
  nowIso: string = new Date().toISOString(),
): DespawnResult {
  const existing = getActiveSpawn(db, agentName);
  if (!existing) return { ok: false, error: `agent '${agentName}' is not active` };

  const record = db.prepare(
    `UPDATE fleet_agent_spawns
     SET status = 'despawned', despawned_at = ?, reason = ?
     WHERE id = ?
     RETURNING *`,
  ).get(nowIso, reason, existing.id) as SpawnRecord;

  return { ok: true, record };
}

export function spawnHistory(db: Database, agentName: string): SpawnRecord[] {
  return db.prepare(
    `SELECT * FROM fleet_agent_spawns WHERE agent_name = ? ORDER BY spawned_at ASC`,
  ).all(agentName) as SpawnRecord[];
}
