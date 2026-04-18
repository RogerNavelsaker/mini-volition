import type { Database } from "bun:sqlite";

export type TtlRule = {
  kind: "ttl";
  predicate: string;
  max_age_days: number;
};

export type SupersedeRule = {
  kind: "supersede";
  predicate: string;
};

export type ObjectPatternRule = {
  kind: "object_pattern";
  pattern: string;
};

export type InvalidationRule = TtlRule | SupersedeRule | ObjectPatternRule;

export type InvalidationResult = {
  rule_kind: string;
  invalidated: number;
};

export function applyTtlRule(db: Database, agentName: string, rule: TtlRule): number {
  const result = db.prepare(
    `UPDATE agent_memory_facts
     SET valid_to = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE agent_name = ?
       AND predicate = ?
       AND valid_to IS NULL
       AND julianday('now') - julianday(updated_at) > ?`,
  ).run(agentName, rule.predicate, rule.max_age_days);
  return result.changes;
}

export function applySupersedRule(db: Database, agentName: string, rule: SupersedeRule): number {
  // Keep the most recently updated fact per (subject, predicate), invalidate the rest
  const result = db.prepare(
    `UPDATE agent_memory_facts
     SET valid_to = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE agent_name = ?
       AND predicate = ?
       AND valid_to IS NULL
       AND id NOT IN (
         SELECT id FROM (
           SELECT id,
                  ROW_NUMBER() OVER (
                    PARTITION BY subject, predicate
                    ORDER BY updated_at DESC, id DESC
                  ) AS rn
           FROM agent_memory_facts
           WHERE agent_name = ?
             AND predicate = ?
             AND valid_to IS NULL
         ) ranked
         WHERE rn = 1
       )`,
  ).run(agentName, rule.predicate, agentName, rule.predicate);
  return result.changes;
}

export function applyObjectPatternRule(db: Database, agentName: string, rule: ObjectPatternRule): number {
  const result = db.prepare(
    `UPDATE agent_memory_facts
     SET valid_to = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE agent_name = ?
       AND valid_to IS NULL
       AND object LIKE ?`,
  ).run(agentName, `%${rule.pattern}%`);
  return result.changes;
}

export function applyInvalidationRules(
  db: Database,
  agentName: string,
  rules: InvalidationRule[],
): InvalidationResult[] {
  const results: InvalidationResult[] = [];
  for (const rule of rules) {
    let invalidated = 0;
    switch (rule.kind) {
      case "ttl":
        invalidated = applyTtlRule(db, agentName, rule);
        break;
      case "supersede":
        invalidated = applySupersedRule(db, agentName, rule);
        break;
      case "object_pattern":
        invalidated = applyObjectPatternRule(db, agentName, rule);
        break;
    }
    results.push({ rule_kind: rule.kind, invalidated });
  }
  return results;
}
