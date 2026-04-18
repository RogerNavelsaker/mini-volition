import type { Database } from "bun:sqlite";

export function ensureSchema(db: Database) {
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.run(`CREATE TABLE IF NOT EXISTS tier0_verbatim (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_name TEXT,
    source TEXT,
    content TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  );`);
  db.run(`CREATE TABLE IF NOT EXISTS tier1_working (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_name TEXT,
    role TEXT,
    content TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  );`);
  db.run(`CREATE TABLE IF NOT EXISTS tier2_episodic (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_name TEXT,
    summary TEXT,
    duration_asleep INTEGER,
    actors TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  );`);
  db.run(`CREATE TABLE IF NOT EXISTS tier3_archival (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_name TEXT,
    task_id TEXT,
    result TEXT,
    reflection TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  );`);
  db.run(`CREATE TABLE IF NOT EXISTS public_digests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    summary TEXT,
    actors TEXT,
    type TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  );`);
  db.run(`CREATE TABLE IF NOT EXISTS agent_memory_artifacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_name TEXT,
    source_kind TEXT NOT NULL,
    source_table TEXT NOT NULL,
    source_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    embedding_json TEXT,
    embedding_model TEXT,
    importance TEXT NOT NULL DEFAULT 'normal',
    strength REAL NOT NULL DEFAULT 1.0,
    recall_count INTEGER NOT NULL DEFAULT 0,
    last_recalled_at DATETIME,
    decay_score REAL NOT NULL DEFAULT 1.0,
    status TEXT NOT NULL DEFAULT 'active',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(source_table, source_id)
  );`);
  db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS agent_memory_fts USING fts5(
    content,
    source_kind UNINDEXED,
    tokenize = 'porter unicode61'
  );`);
  db.run(`CREATE TABLE IF NOT EXISTS agent_memory_refresh_state (
    agent_name TEXT PRIMARY KEY,
    last_refresh_at DATETIME,
    last_status TEXT,
    last_error TEXT,
    artifact_count INTEGER NOT NULL DEFAULT 0,
    source TEXT,
    error_streak INTEGER NOT NULL DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`);
  db.run(`CREATE TABLE IF NOT EXISTS agent_memory_retention_policies (
    agent_name TEXT NOT NULL,
    source_kind TEXT NOT NULL,
    min_importance TEXT NOT NULL DEFAULT 'normal',
    max_age_days INTEGER,
    max_items INTEGER,
    compact_after_days INTEGER,
    archive_after_days INTEGER,
    prune_after_days INTEGER,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (agent_name, source_kind)
  );`);
  db.run(`CREATE TABLE IF NOT EXISTS agent_memory_lookup_cache (
    agent_name TEXT NOT NULL,
    cache_key TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    expires_at DATETIME NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(agent_name, cache_key)
  );`);
  db.run(`CREATE TABLE IF NOT EXISTS agent_memory_compactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_name TEXT NOT NULL,
    source_artifact_ids TEXT NOT NULL,
    signature TEXT NOT NULL,
    summary TEXT NOT NULL,
    structured_json TEXT,
    source TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(agent_name, signature)
  );`);
  db.run(`CREATE TABLE IF NOT EXISTS agent_memory_compaction_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    compaction_id INTEGER NOT NULL,
    agent_name TEXT NOT NULL,
    item_kind TEXT NOT NULL,
    content TEXT NOT NULL,
    strength REAL NOT NULL DEFAULT 1.0,
    recall_count INTEGER NOT NULL DEFAULT 0,
    last_recalled_at DATETIME,
    decay_score REAL NOT NULL DEFAULT 1.0,
    status TEXT NOT NULL DEFAULT 'active',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`);
  db.run(`CREATE TABLE IF NOT EXISTS agent_memory_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_name TEXT NOT NULL,
    from_item_id INTEGER NOT NULL,
    to_item_id INTEGER NOT NULL,
    relation TEXT NOT NULL,
    weight REAL NOT NULL DEFAULT 0.0,
    evidence TEXT,
    valid_from DATETIME DEFAULT CURRENT_TIMESTAMP,
    valid_to DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(from_item_id, to_item_id, relation)
  );`);
  db.run(`CREATE TABLE IF NOT EXISTS agent_memory_facts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_name TEXT NOT NULL,
    source_item_id INTEGER NOT NULL,
    subject TEXT NOT NULL,
    predicate TEXT NOT NULL,
    object TEXT NOT NULL,
    evidence TEXT,
    valid_from DATETIME DEFAULT CURRENT_TIMESTAMP,
    valid_to DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(agent_name, source_item_id, subject, predicate, object)
  );`);
  db.run(`CREATE TABLE IF NOT EXISTS agent_memory_search_index (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    record_kind TEXT NOT NULL,
    record_id INTEGER NOT NULL,
    agent_name TEXT,
    source_kind TEXT NOT NULL,
    content TEXT NOT NULL,
    embedding_json TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(record_kind, record_id)
  );`);
  db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS agent_memory_search_fts USING fts5(
    content,
    source_kind UNINDEXED,
    record_kind UNINDEXED,
    record_id UNINDEXED,
    agent_name UNINDEXED,
    tokenize = 'porter unicode61'
  );`);
}
