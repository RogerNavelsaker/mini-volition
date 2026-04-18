import type { Database } from "bun:sqlite";

export type GovernorRecord = {
  agent_name: string;
  window_started_at: string | null;
  turn_count: number;
  forced_cooldown_until: string | null;
  last_reason: string | null;
  urgent_preempt: number;
  updated_at: string;
};

export type GovernorStatus = {
  allowed: boolean;
  in_cooldown: boolean;
  turn_limit_reached: boolean;
  urgent_preempt_used: boolean;
  turn_count: number;
  turn_limit: number;
  window_sec: number;
  window_started_at: string | null;
  forced_cooldown_until: string | null;
  last_reason: string | null;
};

function parseMs(value: string | null | undefined): number {
  if (!value) return 0;
  // Normalize SQLite space-separated CURRENT_TIMESTAMP to ISO T-separator before appending Z
  const iso = value.includes("T") ? value : value.replace(" ", "T");
  const normalized = iso.endsWith("Z") ? iso : `${iso}Z`;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : 0;
}

export function ensureGovernorSchema(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS fleet_governor (
    agent_name TEXT PRIMARY KEY,
    window_started_at DATETIME,
    turn_count INTEGER NOT NULL DEFAULT 0,
    forced_cooldown_until DATETIME,
    last_reason TEXT,
    urgent_preempt INTEGER NOT NULL DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`);
}

export function getGovernorRecord(db: Database, agentName: string): GovernorRecord | null {
  return (db.prepare("SELECT * FROM fleet_governor WHERE agent_name = ?").get(agentName) as GovernorRecord | null) ?? null;
}

function decayedTurnCount(record: GovernorRecord, now: number, windowMs: number): number {
  const windowStartedMs = parseMs(record.window_started_at);
  if (!windowStartedMs) return 0;
  const elapsed = now - windowStartedMs;
  if (elapsed <= 0) return record.turn_count;
  if (elapsed >= windowMs) return 0;
  const decayRatio = Math.max(0, 1 - elapsed / windowMs);
  return Math.floor(record.turn_count * decayRatio);
}

export function governorStatus(
  db: Database,
  agentName: string,
  windowSec: number,
  turnLimit: number,
  now: number = Date.now(),
): GovernorStatus {
  const rec = getGovernorRecord(db, agentName);
  const windowMs = windowSec * 1000;

  const cooldownUntilMs = parseMs(rec?.forced_cooldown_until);
  const inCooldown = cooldownUntilMs > now;

  // Decay turn count across window boundary
  const effectiveTurnCount = rec ? decayedTurnCount(rec, now, windowMs) : 0;
  const turnLimitReached = effectiveTurnCount >= turnLimit;

  // Urgent preempt: if in cooldown or rate-limited and flag is set, allow through once
  const urgentPreempt = (rec?.urgent_preempt ?? 0) === 1;
  let urgentPreemptUsed = false;
  if ((inCooldown || turnLimitReached) && urgentPreempt) {
    db.prepare(
      "UPDATE fleet_governor SET urgent_preempt = 0, updated_at = CURRENT_TIMESTAMP WHERE agent_name = ?",
    ).run(agentName);
    urgentPreemptUsed = true;
  }

  const allowed = (!inCooldown && !turnLimitReached) || urgentPreemptUsed;

  return {
    allowed,
    in_cooldown: inCooldown,
    turn_limit_reached: turnLimitReached,
    urgent_preempt_used: urgentPreemptUsed,
    turn_count: effectiveTurnCount,
    turn_limit: turnLimit,
    window_sec: windowSec,
    window_started_at: rec?.window_started_at ?? null,
    forced_cooldown_until: rec?.forced_cooldown_until ?? null,
    last_reason: rec?.last_reason ?? null,
  };
}

export function governorBump(
  db: Database,
  agentName: string,
  windowSec: number,
  turnLimit: number,
  reason: string | null = null,
  now: number = Date.now(),
): GovernorStatus {
  const status = governorStatus(db, agentName, windowSec, turnLimit, now);
  const nextCount = status.turn_count + 1;
  const cooldownUntil = nextCount > turnLimit
    ? new Date(now + windowSec * 1000).toISOString()
    : status.forced_cooldown_until;
  const nowIso = new Date(now).toISOString();

  db.prepare(
    `INSERT INTO fleet_governor (agent_name, window_started_at, turn_count, forced_cooldown_until, last_reason, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(agent_name) DO UPDATE SET
       turn_count = excluded.turn_count,
       forced_cooldown_until = excluded.forced_cooldown_until,
       last_reason = excluded.last_reason,
       updated_at = excluded.updated_at`,
  ).run(agentName, nowIso, nextCount, cooldownUntil, reason, nowIso);

  return governorStatus(db, agentName, windowSec, turnLimit, now);
}

export function governorForce(
  db: Database,
  agentName: string,
  cooldownSec: number,
  reason: string | null = null,
  now: number = Date.now(),
): GovernorStatus {
  const cooldownUntil = new Date(now + cooldownSec * 1000).toISOString();
  const nowIso = new Date(now).toISOString();
  db.prepare(
    `INSERT INTO fleet_governor (agent_name, window_started_at, turn_count, forced_cooldown_until, last_reason, updated_at)
     VALUES (?, ?, 0, ?, ?, ?)
     ON CONFLICT(agent_name) DO UPDATE SET
       forced_cooldown_until = excluded.forced_cooldown_until,
       last_reason = excluded.last_reason,
       updated_at = excluded.updated_at`,
  ).run(agentName, nowIso, cooldownUntil, reason, nowIso);
  return governorStatus(db, agentName, cooldownSec, 0, now);
}

export function governorUrgentPreempt(db: Database, agentName: string): void {
  db.prepare(
    `INSERT INTO fleet_governor (agent_name, window_started_at, turn_count, urgent_preempt, updated_at)
     VALUES (?, CURRENT_TIMESTAMP, 0, 1, CURRENT_TIMESTAMP)
     ON CONFLICT(agent_name) DO UPDATE SET urgent_preempt = 1, updated_at = CURRENT_TIMESTAMP`,
  ).run(agentName);
}

export function governorClearCooldown(db: Database, agentName: string): void {
  db.prepare(
    `UPDATE fleet_governor
     SET forced_cooldown_until = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE agent_name = ?`,
  ).run(agentName);
}
