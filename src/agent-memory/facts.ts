import type { Database } from "bun:sqlite";

export type DerivedFact = {
  subject: string;
  predicate: string;
  object: string;
  evidence: string;
};

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function deriveFacts(agentName: string, facts: string[], decisions: string[]): DerivedFact[] {
  const derived: DerivedFact[] = [];

  for (const entry of facts) {
    const text = normalize(entry);
    if (!text) continue;
    const usesMatch = text.match(/^(.+?)\s+(uses|used|using|relies on|depends on)\s+(.+)$/i);
    const isMatch = text.match(/^(.+?)\s+(is|are|was|were)\s+(.+)$/i);
    if (usesMatch) {
      derived.push({
        subject: normalize(usesMatch[1]),
        predicate: normalize(usesMatch[2]).toLowerCase(),
        object: normalize(usesMatch[3]),
        evidence: text,
      });
    } else if (isMatch) {
      derived.push({
        subject: normalize(isMatch[1]),
        predicate: normalize(isMatch[2]).toLowerCase(),
        object: normalize(isMatch[3]),
        evidence: text,
      });
    } else {
      derived.push({
        subject: agentName,
        predicate: "fact",
        object: text,
        evidence: text,
      });
    }
  }

  for (const entry of decisions) {
    const text = normalize(entry);
    if (!text) continue;
    derived.push({
      subject: agentName,
      predicate: "decides",
      object: text,
      evidence: text,
    });
  }

  return derived;
}

export function upsertMemoryFact(
  db: Database,
  agentName: string,
  sourceItemId: number,
  fact: DerivedFact,
  validFrom: string | null = null,
) {
  db.run(
    `INSERT INTO agent_memory_facts
     (agent_name, source_item_id, subject, predicate, object, evidence, valid_from, valid_to, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), NULL, CURRENT_TIMESTAMP)
     ON CONFLICT(agent_name, source_item_id, subject, predicate, object) DO UPDATE SET
       evidence = excluded.evidence,
       valid_to = NULL,
       updated_at = CURRENT_TIMESTAMP`,
    [agentName, sourceItemId, fact.subject, fact.predicate, fact.object, fact.evidence, validFrom],
  );
}

export function invalidateMemoryFacts(db: Database, agentName: string, query: string) {
  db.run(
    `UPDATE agent_memory_facts
     SET valid_to = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE agent_name = ?
       AND valid_to IS NULL
       AND (
         subject LIKE ?
         OR predicate LIKE ?
         OR object LIKE ?
         OR evidence LIKE ?
       )`,
    [agentName, `%${query}%`, `%${query}%`, `%${query}%`, `%${query}%`],
  );
}
