import type { Database } from "bun:sqlite";

export type GcConfig = {
  artifact_retention_days: number;
  compaction_item_retention_days: number;
  fact_retention_days: number;
  link_retention_days: number;
};

export type GcResult = {
  artifacts_deleted: number;
  compaction_items_deleted: number;
  facts_deleted: number;
  links_deleted: number;
};

const DEFAULT_GC_CONFIG: GcConfig = {
  artifact_retention_days: 7,
  compaction_item_retention_days: 7,
  fact_retention_days: 30,
  link_retention_days: 30,
};

export function softDeleteArtifact(
  db: Database,
  id: number,
  nowIso: string = new Date().toISOString(),
): boolean {
  const result = db.prepare(
    `UPDATE agent_memory_artifacts
     SET status = 'deleted', updated_at = ?
     WHERE id = ? AND status != 'deleted'`,
  ).run(nowIso, id);
  return result.changes > 0;
}

export function softDeleteCompactionItem(
  db: Database,
  id: number,
  nowIso: string = new Date().toISOString(),
): boolean {
  const result = db.prepare(
    `UPDATE agent_memory_compaction_items
     SET status = 'deleted', updated_at = ?
     WHERE id = ? AND status != 'deleted'`,
  ).run(nowIso, id);
  return result.changes > 0;
}

export function softDeleteFact(
  db: Database,
  id: number,
  nowIso: string = new Date().toISOString(),
): boolean {
  const result = db.prepare(
    `UPDATE agent_memory_facts
     SET valid_to = ?
     WHERE id = ? AND (valid_to IS NULL OR valid_to > ?)`,
  ).run(nowIso, id, nowIso);
  return result.changes > 0;
}

export function softDeleteLink(
  db: Database,
  id: number,
  nowIso: string = new Date().toISOString(),
): boolean {
  const result = db.prepare(
    `UPDATE agent_memory_links
     SET valid_to = ?
     WHERE id = ? AND (valid_to IS NULL OR valid_to > ?)`,
  ).run(nowIso, id, nowIso);
  return result.changes > 0;
}

export function gcDeletedArtifacts(
  db: Database,
  agentName: string,
  retentionDays: number,
  nowIso: string = new Date().toISOString(),
): number {
  const result = db.prepare(
    `DELETE FROM agent_memory_artifacts
     WHERE agent_name = ?
       AND status = 'deleted'
       AND julianday(?) - julianday(updated_at) >= ?`,
  ).run(agentName, nowIso, retentionDays);
  return result.changes;
}

export function gcDeletedCompactionItems(
  db: Database,
  agentName: string,
  retentionDays: number,
  nowIso: string = new Date().toISOString(),
): number {
  const result = db.prepare(
    `DELETE FROM agent_memory_compaction_items
     WHERE agent_name = ?
       AND status = 'deleted'
       AND julianday(?) - julianday(updated_at) >= ?`,
  ).run(agentName, nowIso, retentionDays);
  return result.changes;
}

export function gcExpiredFacts(
  db: Database,
  agentName: string,
  retentionDays: number,
  nowIso: string = new Date().toISOString(),
): number {
  const result = db.prepare(
    `DELETE FROM agent_memory_facts
     WHERE agent_name = ?
       AND valid_to IS NOT NULL
       AND julianday(?) - julianday(valid_to) >= ?`,
  ).run(agentName, nowIso, retentionDays);
  return result.changes;
}

export function gcExpiredLinks(
  db: Database,
  agentName: string,
  retentionDays: number,
  nowIso: string = new Date().toISOString(),
): number {
  const result = db.prepare(
    `DELETE FROM agent_memory_links
     WHERE agent_name = ?
       AND valid_to IS NOT NULL
       AND julianday(?) - julianday(valid_to) >= ?`,
  ).run(agentName, nowIso, retentionDays);
  return result.changes;
}

export function gcSweep(
  db: Database,
  agentName: string,
  config: Partial<GcConfig> = {},
  nowIso: string = new Date().toISOString(),
): GcResult {
  const cfg = { ...DEFAULT_GC_CONFIG, ...config };
  return {
    artifacts_deleted: gcDeletedArtifacts(db, agentName, cfg.artifact_retention_days, nowIso),
    compaction_items_deleted: gcDeletedCompactionItems(db, agentName, cfg.compaction_item_retention_days, nowIso),
    facts_deleted: gcExpiredFacts(db, agentName, cfg.fact_retention_days, nowIso),
    links_deleted: gcExpiredLinks(db, agentName, cfg.link_retention_days, nowIso),
  };
}
