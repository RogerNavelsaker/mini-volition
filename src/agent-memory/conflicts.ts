import type { Database } from "bun:sqlite";

export type ConflictFact = {
  id: number;
  source_item_id: number;
  object: string;
  evidence: string | null;
  updated_at: string;
};

export type ConflictGroup = {
  subject: string;
  predicate: string;
  facts: ConflictFact[];
};

export type ConflictProposal = {
  subject: string;
  predicate: string;
  keep_id: number;
  invalidate_ids: number[];
  reason: string;
};

function scoreConflictFact(fact: ConflictFact): number {
  let score = 0;
  // Recency: parse updated_at as timestamp millis
  const ts = Date.parse(fact.updated_at.replace(" ", "T"));
  if (!isNaN(ts)) score += ts / 1e12;
  // Specificity: longer object is more specific
  score += fact.object.length * 0.0001;
  // Evidence weight
  if (fact.evidence) score += fact.evidence.length * 0.00005;
  return score;
}

export function findConflictingFacts(db: Database, agentName: string): ConflictGroup[] {
  const conflicting = db.prepare(
    `SELECT subject, predicate
     FROM agent_memory_facts
     WHERE agent_name = ?
       AND valid_to IS NULL
     GROUP BY subject, predicate
     HAVING COUNT(DISTINCT object) > 1`,
  ).all(agentName) as Array<{ subject: string; predicate: string }>;

  if (conflicting.length === 0) return [];

  return conflicting.map(({ subject, predicate }) => {
    const facts = db.prepare(
      `SELECT id, source_item_id, object, evidence, updated_at
       FROM agent_memory_facts
       WHERE agent_name = ?
         AND subject = ?
         AND predicate = ?
         AND valid_to IS NULL
       ORDER BY updated_at DESC`,
    ).all(agentName, subject, predicate) as ConflictFact[];
    return { subject, predicate, facts };
  });
}

export function proposeConflictResolutions(groups: ConflictGroup[]): ConflictProposal[] {
  return groups.map(({ subject, predicate, facts }) => {
    const scored = facts
      .map((f) => ({ fact: f, score: scoreConflictFact(f) }))
      .sort((a, b) => b.score - a.score);

    const winner = scored[0].fact;
    const losers = scored.slice(1).map((s) => s.fact.id);

    return {
      subject,
      predicate,
      keep_id: winner.id,
      invalidate_ids: losers,
      reason: `kept most recent+specific: object="${winner.object.slice(0, 60)}"`,
    };
  });
}

export function applyConflictResolutions(
  db: Database,
  agentName: string,
  proposals: ConflictProposal[],
): number {
  let invalidated = 0;
  const stmt = db.prepare(
    `UPDATE agent_memory_facts
     SET valid_to = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?
       AND agent_name = ?
       AND valid_to IS NULL`,
  );
  for (const proposal of proposals) {
    for (const id of proposal.invalidate_ids) {
      const result = stmt.run(id, agentName);
      invalidated += result.changes;
    }
  }
  return invalidated;
}
