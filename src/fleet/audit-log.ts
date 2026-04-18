import type { Database } from "bun:sqlite";

export type AuditEntry = {
  id: number;
  seq: number;
  recorded_at: string;
  actor: string;
  action: string;
  resource: string;
  result: string;
  meta: string | null;
  prev_hash: string | null;
  entry_hash: string;
};

export type AuditQueryOptions = {
  actor?: string;
  action?: string;
  resource?: string;
  limit?: number;
  since_id?: number;
};

export type ChainVerifyResult = {
  ok: boolean;
  checked: number;
  first_broken_seq: number | null;
};

export function ensureAuditSchema(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS fleet_audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    seq INTEGER NOT NULL,
    recorded_at TEXT NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    resource TEXT NOT NULL,
    result TEXT NOT NULL,
    meta TEXT,
    prev_hash TEXT,
    entry_hash TEXT NOT NULL
  );`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_fleet_audit_actor ON fleet_audit_log (actor);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_fleet_audit_action ON fleet_audit_log (action);`);
}

function computeHash(data: string): string {
  const bytes = new TextEncoder().encode(data);
  let h = 5381n;
  for (const b of bytes) {
    h = ((h << 5n) + h + BigInt(b)) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}

function buildEntryPayload(
  seq: number,
  recordedAt: string,
  actor: string,
  action: string,
  resource: string,
  result: string,
  meta: string | null,
  prevHash: string | null,
): string {
  return JSON.stringify({ seq, recorded_at: recordedAt, actor, action, resource, result, meta, prev_hash: prevHash });
}

export function appendAuditLog(
  db: Database,
  actor: string,
  action: string,
  resource: string,
  result: string,
  meta: Record<string, unknown> | null = null,
  nowIso: string = new Date().toISOString(),
): AuditEntry {
  const last = db.prepare(
    `SELECT seq, entry_hash FROM fleet_audit_log ORDER BY seq DESC LIMIT 1`,
  ).get() as { seq: number; entry_hash: string } | null;

  const seq = (last?.seq ?? 0) + 1;
  const prevHash = last?.entry_hash ?? null;
  const metaStr = meta ? JSON.stringify(meta) : null;
  const payload = buildEntryPayload(seq, nowIso, actor, action, resource, result, metaStr, prevHash);
  const entryHash = computeHash(payload);

  const row = db.prepare(
    `INSERT INTO fleet_audit_log (seq, recorded_at, actor, action, resource, result, meta, prev_hash, entry_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING *`,
  ).get(seq, nowIso, actor, action, resource, result, metaStr, prevHash, entryHash) as AuditEntry;

  return row;
}

export function queryAuditLog(db: Database, options: AuditQueryOptions = {}): AuditEntry[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (options.actor) { conditions.push("actor = ?"); params.push(options.actor); }
  if (options.action) { conditions.push("action = ?"); params.push(options.action); }
  if (options.resource) { conditions.push("resource = ?"); params.push(options.resource); }
  if (options.since_id != null) { conditions.push("id > ?"); params.push(options.since_id); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = options.limit != null ? `LIMIT ${Math.max(1, options.limit)}` : "";

  return db.prepare(
    `SELECT * FROM fleet_audit_log ${where} ORDER BY seq ASC ${limit}`,
  ).all(...params) as AuditEntry[];
}

export function verifyAuditChain(db: Database): ChainVerifyResult {
  const entries = db.prepare(
    `SELECT seq, recorded_at, actor, action, resource, result, meta, prev_hash, entry_hash
     FROM fleet_audit_log ORDER BY seq ASC`,
  ).all() as AuditEntry[];

  let checked = 0;
  for (const entry of entries) {
    const payload = buildEntryPayload(
      entry.seq,
      entry.recorded_at,
      entry.actor,
      entry.action,
      entry.resource,
      entry.result,
      entry.meta,
      entry.prev_hash,
    );
    const expected = computeHash(payload);
    if (expected !== entry.entry_hash) {
      return { ok: false, checked, first_broken_seq: entry.seq };
    }
    checked++;
  }

  return { ok: true, checked, first_broken_seq: null };
}
