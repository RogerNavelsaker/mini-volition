import type { Database } from "bun:sqlite";

export type ChannelEvent = {
  channel: string;
  timestamp: string;
};

export type FocusConfig = {
  window_ms: number;
  burst_threshold: number;
  suspend_ms: number;
};

export type SuspensionDirective = {
  channel: string;
  count: number;
  resume_at: string;
  reason: string;
};

export type FocusEntry = {
  agent_name: string;
  channel: string;
  status: "active" | "suspended";
  suspended_at: string | null;
  resume_at: string | null;
  reason: string | null;
  updated_at: string;
};

export function detectNoisyChannels(
  events: ChannelEvent[],
  config: FocusConfig,
  nowIso: string = new Date().toISOString(),
): SuspensionDirective[] {
  const nowMs = Date.parse(nowIso);
  const windowStart = nowMs - config.window_ms;

  const counts = new Map<string, number>();
  for (const event of events) {
    const eventMs = Date.parse(event.timestamp);
    if (eventMs >= windowStart && eventMs <= nowMs) {
      counts.set(event.channel, (counts.get(event.channel) ?? 0) + 1);
    }
  }

  const directives: SuspensionDirective[] = [];
  for (const [channel, count] of counts) {
    if (count >= config.burst_threshold) {
      directives.push({
        channel,
        count,
        resume_at: new Date(nowMs + config.suspend_ms).toISOString(),
        reason: `burst: ${count} msgs in ${config.window_ms}ms window`,
      });
    }
  }

  return directives.sort((a, b) => b.count - a.count);
}

export function ensureFocusSchema(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS fleet_focus_windows (
    agent_name TEXT NOT NULL,
    channel TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    suspended_at TEXT,
    resume_at TEXT,
    reason TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (agent_name, channel)
  );`);
}

export function getFocusEntry(db: Database, agentName: string, channel: string): FocusEntry | null {
  return (db.prepare(
    `SELECT * FROM fleet_focus_windows WHERE agent_name = ? AND channel = ? LIMIT 1`,
  ).get(agentName, channel) as FocusEntry | null) ?? null;
}

export function listFocusEntries(db: Database, agentName: string): FocusEntry[] {
  return db.prepare(
    `SELECT * FROM fleet_focus_windows WHERE agent_name = ? ORDER BY channel ASC`,
  ).all(agentName) as FocusEntry[];
}

export function suspendChannel(
  db: Database,
  agentName: string,
  channel: string,
  resumeAt: string,
  reason: string,
  nowIso: string = new Date().toISOString(),
): FocusEntry {
  return db.prepare(
    `INSERT INTO fleet_focus_windows (agent_name, channel, status, suspended_at, resume_at, reason, updated_at)
     VALUES (?, ?, 'suspended', ?, ?, ?, ?)
     ON CONFLICT(agent_name, channel) DO UPDATE SET
       status = 'suspended',
       suspended_at = excluded.suspended_at,
       resume_at = excluded.resume_at,
       reason = excluded.reason,
       updated_at = excluded.updated_at
     RETURNING *`,
  ).get(agentName, channel, nowIso, resumeAt, reason, nowIso) as FocusEntry;
}

export function resumeChannel(
  db: Database,
  agentName: string,
  channel: string,
  nowIso: string = new Date().toISOString(),
): FocusEntry | null {
  return (db.prepare(
    `INSERT INTO fleet_focus_windows (agent_name, channel, status, suspended_at, resume_at, reason, updated_at)
     VALUES (?, ?, 'active', NULL, NULL, NULL, ?)
     ON CONFLICT(agent_name, channel) DO UPDATE SET
       status = 'active',
       suspended_at = NULL,
       resume_at = NULL,
       reason = NULL,
       updated_at = excluded.updated_at
     RETURNING *`,
  ).get(agentName, channel, nowIso) as FocusEntry | null) ?? null;
}

export function applyDirectives(
  db: Database,
  agentName: string,
  directives: SuspensionDirective[],
  nowIso: string = new Date().toISOString(),
): FocusEntry[] {
  return directives.map((d) => suspendChannel(db, agentName, d.channel, d.resume_at, d.reason, nowIso));
}

export function checkExpiredSuspensions(
  db: Database,
  agentName: string,
  nowIso: string = new Date().toISOString(),
): FocusEntry[] {
  const expired = db.prepare(
    `SELECT * FROM fleet_focus_windows
     WHERE agent_name = ? AND status = 'suspended' AND resume_at <= ?`,
  ).all(agentName, nowIso) as FocusEntry[];

  return expired.map((entry) => resumeChannel(db, agentName, entry.channel, nowIso) as FocusEntry);
}

export function isSuspended(
  db: Database,
  agentName: string,
  channel: string,
  nowIso: string = new Date().toISOString(),
): boolean {
  const entry = getFocusEntry(db, agentName, channel);
  if (!entry || entry.status !== "suspended") return false;
  if (!entry.resume_at) return true;
  return entry.resume_at > nowIso;
}
