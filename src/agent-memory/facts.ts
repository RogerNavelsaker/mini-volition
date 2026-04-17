import type { Database } from "bun:sqlite";

export type DerivedFact = {
  subject: string;
  predicate: string;
  object: string;
  evidence: string;
};

export type EntityTuple = {
  subject: string;
  predicate: string;
  object: string;
  description?: string;
};

export type MemoryItemRef = {
  id: number;
  item_kind: string;
  content: string;
};

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function normalizeForMatch(text: string): string {
  return normalize(text)
    .toLowerCase()
    .replace(/[`"'()[\]{}:;,.!?/\\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeForMatch(text: string): string[] {
  return normalizeForMatch(text).match(/[a-z0-9_]{3,}/g) ?? [];
}

function containsWholePhrase(content: string, phrase: string): boolean {
  const normalizedContent = ` ${normalizeForMatch(content)} `;
  const normalizedPhrase = normalizeForMatch(phrase);
  if (!normalizedPhrase) return false;
  return normalizedContent.includes(` ${normalizedPhrase} `);
}

function tokenOverlap(left: string, right: string): number {
  const leftTokens = [...new Set(tokenizeForMatch(left))];
  if (leftTokens.length === 0) return 0;
  const rightSet = new Set(tokenizeForMatch(right));
  let matches = 0;
  for (const token of leftTokens) {
    if (rightSet.has(token)) matches += 1;
  }
  return matches / leftTokens.length;
}

function matchScore(item: MemoryItemRef, entity: EntityTuple): number {
  let score = 0;
  if (containsWholePhrase(item.content, entity.subject)) score += 0.55;
  if (containsWholePhrase(item.content, entity.object)) score += 0.55;
  if (containsWholePhrase(item.content, entity.predicate)) score += 0.2;
  score += tokenOverlap(`${entity.subject} ${entity.object}`, item.content) * 0.35;
  score += tokenOverlap(entity.description ?? "", item.content) * 0.25;
  if (item.item_kind === "fact") score += 0.08;
  if (item.item_kind === "decision" && /decid|prefer|choose|use/i.test(entity.predicate)) score += 0.04;
  return score;
}

export function matchEntityToItem(items: MemoryItemRef[], entity: EntityTuple): MemoryItemRef | null {
  let best: MemoryItemRef | null = null;
  let bestScore = 0;
  for (const item of items) {
    const score = matchScore(item, entity);
    if (score > bestScore) {
      best = item;
      bestScore = score;
    }
  }
  return bestScore >= 0.45 ? best : null;
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
