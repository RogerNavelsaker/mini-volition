import type { Database } from "bun:sqlite";

export type DigestEvent = {
  id: number;
  agent_name: string | null;
  payload_json: string | null;
};

export type FleetMessage = {
  id: number;
  layer: string;
  recipient: string;
  sender: string;
  body: string;
  created_at: string;
};

export function ensureDigestSchema(digestDb: Database) {
  digestDb.run(`CREATE TABLE IF NOT EXISTS fleet_digest_cursor (
    event_type TEXT PRIMARY KEY,
    last_id INTEGER NOT NULL DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`);
  digestDb.run(`CREATE TABLE IF NOT EXISTS fleet_digest_journal (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER,
    agent_name TEXT,
    message_count INTEGER,
    phase TEXT NOT NULL,
    detail TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`);
}

export function buildDigestRecord(messages: FleetMessage[]): { summary: string; actors: string } {
  const senders = [...new Set(messages.map((m) => m.sender))];
  const recipients = [...new Set(messages.map((m) => m.recipient))];
  const allActors = [...new Set([...senders, ...recipients])];
  const preview = messages[0]?.body?.slice(0, 120) ?? "";
  const summary = `Burst of ${messages.length} message(s) from ${senders.join(", ")} to ${recipients.join(", ")}: ${preview}`;
  return { summary, actors: JSON.stringify(allActors) };
}

export function processDigestEvent(
  mailDb: Database,
  memoryDb: Database,
  digestDb: Database,
  event: DigestEvent,
): void {
  if (!event.agent_name) return;

  let messageIds: number[] = [];
  try {
    const payload = event.payload_json ? (JSON.parse(event.payload_json) as { message_ids?: unknown }) : {};
    if (Array.isArray(payload.message_ids)) {
      messageIds = payload.message_ids.filter((id): id is number => Number.isInteger(id) && id > 0);
    }
  } catch {
    digestDb.run(
      `INSERT INTO fleet_digest_journal (event_id, agent_name, message_count, phase, detail) VALUES (?, ?, 0, 'failed', 'bad_payload')`,
      [event.id, event.agent_name],
    );
    return;
  }

  if (messageIds.length === 0) return;

  const placeholders = messageIds.map(() => "?").join(",");
  const messages = mailDb.prepare(
    `SELECT id, layer, recipient, sender, body, created_at FROM fleet_comms WHERE id IN (${placeholders})`,
  ).all(...messageIds) as FleetMessage[];

  if (messages.length === 0) return;

  const { summary, actors } = buildDigestRecord(messages);
  memoryDb.run(
    `INSERT INTO public_digests (summary, actors, type, timestamp) VALUES (?, ?, 'burst', CURRENT_TIMESTAMP)`,
    [summary, actors],
  );
  digestDb.run(
    `INSERT INTO fleet_digest_journal (event_id, agent_name, message_count, phase) VALUES (?, ?, ?, 'completed')`,
    [event.id, event.agent_name, messages.length],
  );
}

export function pollBurstEvents(
  fleetDb: Database,
  mailDb: Database,
  memoryDb: Database,
  digestDb: Database,
): number {
  const cursor = (digestDb.prepare(
    `SELECT last_id FROM fleet_digest_cursor WHERE event_type = 'burst_flushed'`,
  ).get() as { last_id: number } | null)?.last_id ?? 0;

  const rows = fleetDb.prepare(
    `SELECT id, agent_name, payload_json FROM fleet_event_log WHERE event_type = 'burst_flushed' AND id > ? ORDER BY id ASC LIMIT 50`,
  ).all(cursor) as DigestEvent[];

  if (rows.length === 0) return 0;

  for (const row of rows) {
    processDigestEvent(mailDb, memoryDb, digestDb, row);
  }

  const maxId = rows[rows.length - 1].id;
  digestDb.prepare(
    `INSERT INTO fleet_digest_cursor (event_type, last_id, updated_at) VALUES ('burst_flushed', ?, CURRENT_TIMESTAMP)
     ON CONFLICT(event_type) DO UPDATE SET last_id = excluded.last_id, updated_at = excluded.updated_at`,
  ).run(maxId);

  return rows.length;
}

export function deadLetterSweep(
  mailDb: Database,
  memoryDb: Database,
  digestDb: Database,
  windowMinutes: number = 10,
): number {
  const recentCompleted = mailDb.prepare(
    `SELECT DISTINCT c.agent_name
     FROM fleet_comms_claims c
     WHERE c.status = 'completed'
       AND c.completed_at > datetime('now', ?)
       AND c.agent_name IS NOT NULL`,
  ).all(`-${windowMinutes} minutes`) as Array<{ agent_name: string }>;

  if (recentCompleted.length === 0) return 0;

  let created = 0;
  for (const { agent_name } of recentCompleted) {
    const alreadyDigested = (memoryDb.prepare(
      `SELECT COUNT(*) AS n FROM public_digests WHERE timestamp > datetime('now', ?) AND type = 'burst'`,
    ).get(`-${windowMinutes} minutes`) as { n: number }).n;
    if (alreadyDigested > 0) continue;

    const messages = mailDb.prepare(
      `SELECT fc.id, fc.layer, fc.recipient, fc.sender, fc.body, fc.created_at
       FROM fleet_comms fc
       JOIN fleet_comms_claims c ON c.message_id = fc.id
       WHERE c.agent_name = ?
         AND c.status = 'completed'
         AND c.completed_at > datetime('now', ?)
       ORDER BY fc.id ASC
       LIMIT 50`,
    ).all(agent_name, `-${windowMinutes} minutes`) as FleetMessage[];

    if (messages.length === 0) continue;

    const { summary, actors } = buildDigestRecord(messages);
    memoryDb.run(
      `INSERT INTO public_digests (summary, actors, type, timestamp) VALUES (?, ?, 'burst', CURRENT_TIMESTAMP)`,
      [summary, actors],
    );
    digestDb.run(
      `INSERT INTO fleet_digest_journal (event_id, agent_name, message_count, phase, detail) VALUES (NULL, ?, ?, 'completed', 'dead_letter')`,
      [agent_name, messages.length],
    );
    created++;
  }
  return created;
}
