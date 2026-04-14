import type { Database } from "bun:sqlite";

export type FleetMessage = {
  id: number;
  layer: string;
  recipient: string;
  sender: string;
  body: string;
  read_at: string | null;
  read_by?: string;
  created_at: string;
};

export type BurstEnvelope = {
  primary: FleetMessage;
  messages: FleetMessage[];
  mergedCount: number;
  remainingUnread: number;
};

export function ensureMailSchema(db: Database) {
  db.run(`CREATE TABLE IF NOT EXISTS fleet_comms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    layer TEXT,
    recipient TEXT,
    sender TEXT,
    body TEXT,
    read_at DATETIME,
    read_by TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`);
  db.run(`CREATE TABLE IF NOT EXISTS fleet_comms_claims (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL,
    agent_name TEXT NOT NULL,
    claimed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME,
    status TEXT NOT NULL DEFAULT 'claimed',
    UNIQUE(message_id, agent_name)
  );`);
}

function claimJoin(agent: string) {
  return `
    LEFT JOIN fleet_comms_claims claim
      ON claim.message_id = fleet_comms.id
     AND LOWER(claim.agent_name) = LOWER('${agent.replace(/'/g, "''")}')
     AND claim.status = 'claimed'
  `;
}

export function unreadQueryFor(db: Database, agent: string) {
  return db.prepare(
    `SELECT fleet_comms.*
     FROM fleet_comms
     ${claimJoin(agent)}
     WHERE fleet_comms.sender != ?
       AND claim.id IS NULL
       AND (
         (LOWER(fleet_comms.recipient) = LOWER(?) AND fleet_comms.read_at IS NULL)
         OR
         (LOWER(fleet_comms.recipient) = 'all' AND IFNULL(fleet_comms.read_by, '') NOT LIKE ?)
       )
     ORDER BY fleet_comms.id ASC`,
  );
}

export function countUnread(db: Database, agent: string): number {
  const rec = unreadQueryFor(db, agent).all(agent, agent, `%|${agent}|%`) as FleetMessage[];
  return rec.length;
}

export function buildBurstFromPrimary(agent: string, primary: FleetMessage, unread: FleetMessage[], maxMessages: number, windowSec: number): BurstEnvelope {
  const windowMs = windowSec * 1000;
  const primaryTime = new Date(primary.created_at.endsWith("Z") ? primary.created_at : `${primary.created_at}Z`).getTime();

  const messages = unread.filter((msg) => {
    const msgTime = new Date(msg.created_at.endsWith("Z") ? msg.created_at : `${msg.created_at}Z`).getTime();
    return (
      msg.sender === primary.sender &&
      msg.layer === primary.layer &&
      msg.recipient.toLowerCase() === primary.recipient.toLowerCase() &&
      msgTime - primaryTime <= windowMs
    );
  }).slice(0, maxMessages);

  return {
    primary,
    messages,
    mergedCount: messages.length,
    remainingUnread: Math.max(0, unread.length - messages.length),
  };
}

export function peekBurst(db: Database, agent: string, maxMessages: number, windowSec: number): BurstEnvelope | null {
  const unread = unreadQueryFor(db, agent).all(agent, agent, `%|${agent}|%`) as FleetMessage[];
  if (unread.length === 0) return null;
  const primary = unread[0];
  return buildBurstFromPrimary(agent, primary, unread, maxMessages, windowSec);
}

export function claimBurst(db: Database, agent: string, maxMessages: number, windowSec: number, primaryId?: number): BurstEnvelope | null {
  const unread = unreadQueryFor(db, agent).all(agent, agent, `%|${agent}|%`) as FleetMessage[];
  if (unread.length === 0) return null;
  const primary = primaryId ? unread.find((msg) => msg.id === primaryId) : unread[0];
  if (!primary) return null;
  const burst = buildBurstFromPrimary(agent, primary, unread, maxMessages, windowSec);
  for (const msg of burst.messages) {
    db.run(
      `INSERT INTO fleet_comms_claims (message_id, agent_name, claimed_at, completed_at, status)
       VALUES (?, ?, CURRENT_TIMESTAMP, NULL, 'claimed')
       ON CONFLICT(message_id, agent_name) DO UPDATE SET
         claimed_at = CURRENT_TIMESTAMP,
         completed_at = NULL,
         status = 'claimed'`,
      [msg.id, agent],
    );
  }
  return { ...burst, remainingUnread: Math.max(0, countUnread(db, agent)) };
}

export function completeBurst(db: Database, agent: string, messageIds: number[]) {
  const ids = [...new Set(messageIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
  for (const id of ids) {
    const msg = db.prepare("SELECT * FROM fleet_comms WHERE id = ?").get(id) as FleetMessage | null;
    if (!msg) continue;
    db.run(
      `UPDATE fleet_comms_claims
       SET status = 'completed',
           completed_at = CURRENT_TIMESTAMP
       WHERE message_id = ?
         AND LOWER(agent_name) = LOWER(?)`,
      [id, agent],
    );
    if (msg.recipient.toLowerCase() === "all") {
      db.run("UPDATE fleet_comms SET read_by = IFNULL(read_by, '') || ? WHERE id = ? AND IFNULL(read_by, '') NOT LIKE ?", [`|${agent}|`, id, `%|${agent}|%`]);
    } else {
      db.run("UPDATE fleet_comms SET read_at = CURRENT_TIMESTAMP WHERE id = ? AND read_at IS NULL", [id]);
    }
  }
}

export function reclaimStaleClaims(db: Database, agent: string, ttlMs: number) {
  const minTtlMs = Math.max(30_000, ttlMs || 0);
  const rows = db.prepare(
    `SELECT id, claimed_at
     FROM fleet_comms_claims
     WHERE LOWER(agent_name) = LOWER(?)
       AND status = 'claimed'
       AND claimed_at IS NOT NULL`,
  ).all(agent) as Array<{ id: number; claimed_at: string }>;
  const reclaimed: number[] = [];
  for (const row of rows) {
    const claimedAtMs = new Date(row.claimed_at.endsWith("Z") ? row.claimed_at : `${row.claimed_at}Z`).getTime();
    if (!Number.isFinite(claimedAtMs)) continue;
    if ((Date.now() - claimedAtMs) < minTtlMs) continue;
    db.run("DELETE FROM fleet_comms_claims WHERE id = ? AND status = 'claimed'", [row.id]);
    reclaimed.push(row.id);
  }
  return reclaimed;
}

export function releaseClaims(db: Database, agent: string, messageIds: number[]) {
  const ids = [...new Set(messageIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
  for (const id of ids) {
    db.run(
      `DELETE FROM fleet_comms_claims
       WHERE message_id = ?
         AND LOWER(agent_name) = LOWER(?)
         AND status = 'claimed'`,
      [id, agent],
    );
  }
  return ids;
}
