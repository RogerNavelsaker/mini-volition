import type { Database } from "bun:sqlite";

export function ensureSchema(db: Database) {
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.run(`CREATE TABLE IF NOT EXISTS fleet_agent_state (
    agent_name TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    current_task TEXT,
    wake_reason TEXT,
    last_error TEXT,
    cooldown_until DATETIME,
    last_message_id INTEGER,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`);
  db.run(`CREATE TABLE IF NOT EXISTS fleet_agent_action_journal (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_name TEXT NOT NULL,
    message_id INTEGER,
    action_index INTEGER NOT NULL,
    action_type TEXT NOT NULL,
    phase TEXT NOT NULL,
    detail TEXT,
    replay_disposition TEXT NOT NULL DEFAULT 'manual_review',
    replay_reason TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`);
  db.run(`CREATE TABLE IF NOT EXISTS fleet_turn_journal (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_name TEXT NOT NULL,
    turn_key TEXT NOT NULL,
    wake_source TEXT NOT NULL,
    wake_reason TEXT NOT NULL,
    message_id INTEGER,
    phase TEXT NOT NULL,
    detail TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`);
  db.run(`CREATE TABLE IF NOT EXISTS fleet_turn_checkpoints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_name TEXT NOT NULL,
    turn_key TEXT NOT NULL,
    wake_source TEXT NOT NULL,
    wake_reason TEXT NOT NULL,
    wake_class TEXT NOT NULL,
    wake_priority INTEGER NOT NULL,
    message_id INTEGER,
    sender TEXT NOT NULL,
    layer TEXT NOT NULL,
    burst_count INTEGER NOT NULL,
    prompt_hash TEXT,
    prompt_chars INTEGER NOT NULL DEFAULT 0,
    envelope_status TEXT NOT NULL,
    envelope_summary TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(agent_name, turn_key)
  );`);
}
