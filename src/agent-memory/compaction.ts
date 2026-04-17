import type { MemoryKind } from "./types";

export type CompactionCandidate = {
  id: number;
  source_kind: MemoryKind;
  content: string;
  importance: string;
  strength: number;
  recall_count: number;
  decay_score: number;
};

const COMPACTION_SOURCE_KINDS = new Set<MemoryKind>(["digest", "episodic", "verbatim"]);

function compactionEligible(candidate: CompactionCandidate): boolean {
  if (!COMPACTION_SOURCE_KINDS.has(candidate.source_kind)) return false;
  if (candidate.importance === "critical" || candidate.importance === "high") return true;
  if ((candidate.recall_count ?? 0) >= 2) return true;
  if ((candidate.strength ?? 0) >= 2) return true;
  if (candidate.source_kind === "verbatim" && (((candidate.recall_count ?? 0) >= 1) || (candidate.strength ?? 0) >= 1.25)) return true;
  return false;
}

export function selectCompactionCandidates(candidates: CompactionCandidate[]): CompactionCandidate[] {
  return candidates
    .filter(compactionEligible)
    .sort((left, right) =>
      (right.importance === "critical" ? 2 : right.importance === "high" ? 1 : 0)
      - (left.importance === "critical" ? 2 : left.importance === "high" ? 1 : 0)
      || (right.recall_count ?? 0) - (left.recall_count ?? 0)
      || (right.strength ?? 0) - (left.strength ?? 0)
      || (right.decay_score ?? 0) - (left.decay_score ?? 0))
    .slice(0, 6);
}

