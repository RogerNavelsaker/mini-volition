import type { Database } from "bun:sqlite";

export type LineageRecordKind = "compaction_item" | "fact";

export type LineageTagRow = {
  id: number;
  agent_name: string;
  record_kind: LineageRecordKind;
  record_id: number;
  tag: string;
  provenance: string | null;
  inherited_from_kind: LineageRecordKind | null;
  inherited_from_id: number | null;
  depth: number;
  created_at?: string;
  updated_at?: string;
};

export function listLineageTags(
  db: Database,
  agentName: string,
  recordKind: LineageRecordKind,
  recordId: number,
): LineageTagRow[] {
  return db.prepare(
    `SELECT id, agent_name, record_kind, record_id, tag, provenance, inherited_from_kind, inherited_from_id, depth, created_at, updated_at
     FROM agent_memory_lineage_tags
     WHERE agent_name = ? AND record_kind = ? AND record_id = ?
     ORDER BY depth ASC, tag ASC`,
  ).all(agentName, recordKind, recordId) as LineageTagRow[];
}

export function upsertLineageTag(
  db: Database,
  agentName: string,
  recordKind: LineageRecordKind,
  recordId: number,
  tag: string,
  provenance: string | null,
  inheritedFromKind: LineageRecordKind | null = null,
  inheritedFromId: number | null = null,
  depth = 0,
): LineageTagRow | null {
  db.run(
    `INSERT INTO agent_memory_lineage_tags (
       agent_name, record_kind, record_id, tag, provenance, inherited_from_kind, inherited_from_id, depth, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT(agent_name, record_kind, record_id, tag) DO UPDATE SET
       provenance = excluded.provenance,
       inherited_from_kind = excluded.inherited_from_kind,
       inherited_from_id = excluded.inherited_from_id,
       depth = MIN(agent_memory_lineage_tags.depth, excluded.depth),
       updated_at = CURRENT_TIMESTAMP`,
    [agentName, recordKind, recordId, tag, provenance, inheritedFromKind, inheritedFromId, depth],
  );
  return db.prepare(
    `SELECT id, agent_name, record_kind, record_id, tag, provenance, inherited_from_kind, inherited_from_id, depth, created_at, updated_at
     FROM agent_memory_lineage_tags
     WHERE agent_name = ? AND record_kind = ? AND record_id = ? AND tag = ?
     LIMIT 1`,
  ).get(agentName, recordKind, recordId, tag) as LineageTagRow | null;
}

export function seedCompactionItemLineage(
  db: Database,
  agentName: string,
  compactionId: number,
  itemId: number,
  itemKind: string,
): LineageTagRow[] {
  const rows = [
    upsertLineageTag(db, agentName, "compaction_item", itemId, `compaction:${compactionId}`, "seed", null, null, 0),
    upsertLineageTag(db, agentName, "compaction_item", itemId, `kind:${itemKind}`, "seed", null, null, 0),
  ].filter(Boolean) as LineageTagRow[];
  return rows;
}

export function inheritLineageTags(
  db: Database,
  agentName: string,
  fromKind: LineageRecordKind,
  fromId: number,
  toKind: LineageRecordKind,
  toId: number,
  provenance: string,
): LineageTagRow[] {
  const sourceTags = listLineageTags(db, agentName, fromKind, fromId);
  return sourceTags
    .map((tag) =>
      upsertLineageTag(
        db,
        agentName,
        toKind,
        toId,
        tag.tag,
        provenance,
        fromKind,
        fromId,
        Math.max(1, (tag.depth ?? 0) + 1),
      ),
    )
    .filter(Boolean) as LineageTagRow[];
}
