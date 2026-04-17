import type { Database } from "bun:sqlite";
import { upsertMemoryLink, relationForItemKinds } from "./links";

export interface PromotionItem {
  kind: string;
  content: string;
  embedding: number[];
}

export interface PromotionInput {
  agentName: string;
  taskId: string;
  signature: string;
  summary: string;
  structuredJson: string;
  source: string;
  sourceArtifactIds: number[];
  items: PromotionItem[];
  linkEmbeddings: Array<{ fromIdx: number; toIdx: number; relation: string; embedding: number[] }>;
}

export interface PromotionResult {
  archivalId: number;
  compactionId: number;
  itemIds: number[];
  markedSourceCount: number;
}

export function atomicPromote(db: Database, input: PromotionInput): PromotionResult {
  db.exec("BEGIN IMMEDIATE;");
  try {
    // 1. Insert archival record
    db.run(
      `INSERT INTO tier3_archival (agent_name, task_id, result, reflection, timestamp)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [input.agentName, input.taskId, input.structuredJson, input.summary],
    );
    const archivalRow = db.prepare(
      "SELECT id FROM tier3_archival WHERE agent_name = ? AND task_id = ?",
    ).get(input.agentName, input.taskId) as { id: number } | null;
    if (!archivalRow) throw new Error("Failed to insert archival record");
    const archivalId = archivalRow.id;

    // 2. Insert compaction record
    db.run(
      `INSERT INTO agent_memory_compactions (agent_name, source_artifact_ids, signature, summary, structured_json, source)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [input.agentName, input.sourceArtifactIds.join(","), input.signature, input.summary, input.structuredJson, input.source],
    );
    const compactionRow = db.prepare(
      "SELECT id FROM agent_memory_compactions WHERE agent_name = ? AND signature = ?",
    ).get(input.agentName, input.signature) as { id: number } | null;
    if (!compactionRow) throw new Error("Failed to insert compaction record");
    const compactionId = compactionRow.id;

    // 3. Insert compaction items and search index entries
    const itemIds: number[] = [];
    for (const item of input.items) {
      db.run(
        `INSERT INTO agent_memory_compaction_items
         (compaction_id, agent_name, item_kind, content, strength, recall_count, decay_score, status, updated_at)
         VALUES (?, ?, ?, ?, 1.0, 0, 1.0, 'active', CURRENT_TIMESTAMP)`,
        [compactionId, input.agentName, item.kind, item.content],
      );
      const itemRow = db.prepare(
        "SELECT id FROM agent_memory_compaction_items WHERE compaction_id = ? ORDER BY id DESC LIMIT 1",
      ).get(compactionId) as { id: number } | null;
      if (!itemRow) continue;
      itemIds.push(itemRow.id);

      if (item.embedding.length > 0) {
        db.run(
          `INSERT OR REPLACE INTO agent_memory_search_index
           (record_kind, record_id, agent_name, source_kind, content, embedding_json, updated_at)
           VALUES ('compaction_item', ?, ?, 'archival', ?, ?, CURRENT_TIMESTAMP)`,
          [itemRow.id, input.agentName, `${item.kind}: ${item.content}`, JSON.stringify(item.embedding)],
        );
        db.run(
          `INSERT INTO agent_memory_search_fts (content, source_kind, record_kind, record_id, agent_name)
           VALUES (?, 'archival', 'compaction_item', ?, ?)`,
          [`${item.kind}: ${item.content}`, itemRow.id, input.agentName],
        );
      }
    }

    // 4. Upsert cross-item links using pre-computed embeddings
    const createdItems = input.items.map((item, idx) => ({ id: itemIds[idx], item_kind: item.kind, content: item.content })).filter((i) => i.id != null);
    for (const from of createdItems) {
      for (const to of createdItems) {
        if (from.id === to.id) continue;
        const relation = relationForItemKinds(from.item_kind, to.item_kind);
        const evidence = `compaction:${compactionId}`;
        upsertMemoryLink(db, input.agentName, from.id, to.id, relation, 0.65, evidence);

        const linkEmbedEntry = input.linkEmbeddings.find(
          (le) => le.fromIdx === createdItems.indexOf(from) && le.toIdx === createdItems.indexOf(to),
        );
        if (linkEmbedEntry && linkEmbedEntry.embedding.length > 0) {
          const linkRow = db.prepare(
            "SELECT id FROM agent_memory_links WHERE from_item_id = ? AND to_item_id = ? AND relation = ?",
          ).get(from.id, to.id, relation) as { id: number } | null;
          if (linkRow) {
            db.run(
              `INSERT OR REPLACE INTO agent_memory_search_index
               (record_kind, record_id, agent_name, source_kind, content, embedding_json, updated_at)
               VALUES ('link', ?, ?, 'archival', ?, ?, CURRENT_TIMESTAMP)`,
              [linkRow.id, input.agentName, `${relation}: ${from.content.slice(0, 200)} → ${to.content.slice(0, 200)}`, JSON.stringify(linkEmbedEntry.embedding)],
            );
          }
        }
      }
    }

    // 5. Mark source artifacts as promoted
    let markedSourceCount = 0;
    for (const artifactId of input.sourceArtifactIds) {
      const result = db.run(
        `UPDATE agent_memory_artifacts
         SET promoted_compaction_id = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND promoted_compaction_id IS NULL`,
        [compactionId, artifactId],
      );
      markedSourceCount += result.changes;
    }

    db.exec("COMMIT;");
    return { archivalId, compactionId, itemIds, markedSourceCount };
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
}

export function promotionStatus(db: Database, agentName: string): {
  totalArtifacts: number;
  promotedArtifacts: number;
  pendingArtifacts: number;
  compactions: number;
} {
  const total = (db.prepare(
    "SELECT COUNT(*) as cnt FROM agent_memory_artifacts WHERE (agent_name = ? OR agent_name IS NULL) AND status = 'active'",
  ).get(agentName) as { cnt: number }).cnt;

  const promoted = (db.prepare(
    "SELECT COUNT(*) as cnt FROM agent_memory_artifacts WHERE (agent_name = ? OR agent_name IS NULL) AND status = 'active' AND promoted_compaction_id IS NOT NULL",
  ).get(agentName) as { cnt: number }).cnt;

  const compactions = (db.prepare(
    "SELECT COUNT(*) as cnt FROM agent_memory_compactions WHERE agent_name = ?",
  ).get(agentName) as { cnt: number }).cnt;

  return {
    totalArtifacts: total,
    promotedArtifacts: promoted,
    pendingArtifacts: total - promoted,
    compactions,
  };
}
