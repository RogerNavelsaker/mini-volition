import type { Database } from "bun:sqlite";

export function relationForItemKinds(leftKind: string, rightKind: string): string {
  if (leftKind === rightKind) return `repeats_${leftKind}`;
  if (leftKind === "fact" && rightKind === "decision") return "informs_decision";
  if (leftKind === "decision" && rightKind === "fact") return "grounded_in_fact";
  if (leftKind === "pattern" && rightKind === "decision") return "shapes_decision";
  if (leftKind === "decision" && rightKind === "pattern") return "expresses_pattern";
  if (leftKind === "lesson" && rightKind === "pattern") return "summarizes_pattern";
  if (leftKind === "pattern" && rightKind === "lesson") return "instantiates_lesson";
  if (leftKind === "open_risk" && rightKind === "decision") return "risk_for_decision";
  if (leftKind === "open_risk" && rightKind === "pattern") return "risk_with_pattern";
  if (leftKind === "decision" && rightKind === "open_risk") return "creates_risk";
  return "related_context";
}

export function upsertMemoryLink(
  db: Database,
  agentName: string,
  fromItemId: number,
  toItemId: number,
  relation: string,
  weight: number,
  evidence: string,
  validFrom: string | null = null,
) {
  if (fromItemId === toItemId) return;
  db.run(
    `INSERT INTO agent_memory_links (agent_name, from_item_id, to_item_id, relation, weight, evidence, valid_from, valid_to, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), NULL, CURRENT_TIMESTAMP)
     ON CONFLICT(from_item_id, to_item_id, relation) DO UPDATE SET
       weight = excluded.weight,
       evidence = excluded.evidence,
       valid_to = NULL,
       updated_at = CURRENT_TIMESTAMP`,
    [agentName, fromItemId, toItemId, relation, weight, evidence, validFrom],
  );
}

export function invalidateMemoryLinks(db: Database, agentName: string, itemId: number, relationPrefix: string | null = null) {
  const query = relationPrefix
    ? `UPDATE agent_memory_links
       SET valid_to = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE agent_name = ?
         AND (from_item_id = ? OR to_item_id = ?)
         AND relation LIKE ?
         AND valid_to IS NULL`
    : `UPDATE agent_memory_links
       SET valid_to = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE agent_name = ?
         AND (from_item_id = ? OR to_item_id = ?)
         AND valid_to IS NULL`;
  const args = relationPrefix ? [agentName, itemId, itemId, `${relationPrefix}%`] : [agentName, itemId, itemId];
  db.run(query, args);
}

export function timelineQueryTokens(query: string, tokenize: (value: string) => string[]): string[] {
  return [...new Set(tokenize(query))].slice(0, 8);
}
