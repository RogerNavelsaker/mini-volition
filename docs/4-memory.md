# §Memory
Tiered durability with hybrid recall.

## §Tiers
- **Tier1Working**: Current turn context, recent actions, and immediate wake evidence.
- **Tier1_5Clipboard**: Persistent pinned working context; current storage name: `replicant_clipboards`.
- **Tier2Episodic**: Summaries, digests, task reports, research notes, and worker outputs that have been interpreted.
- **Tier3SemanticProcedural**: Durable facts, lessons, patterns, relations, and policy-relevant knowledge.
- **Artifacts**: Path-backed downloads/overflow/files known through memory but inspected through `file` or `shell`.

## §Clipboard
- **Injection**: Full clipboard is injected every ordinary turn, even when empty.
- **Purpose**: Pin actionable near-term context across pruning, sleep, and lossy summaries.
- **Shape**: Ordered `entries` using `index` and `content`; warning only when near capacity.
- **Control**: Replicant mutates it through clipboard/scratchpad actions; harness injects it.
- **Hygiene**: Store decisions, refs, ids, paths, and active task state.

## §Recall
- **Surface**: Public tool is `memory recall`.
- **Protocol**: Recall before broad shell, file, web, or artifact exploration when memory contains relevant grounding.
- **Default**: Limit 10 by default; harness clamps and reports unapplied selectors.
- **Output**: Compact text-bearing entries with `type`, `title`, `content`, `source_ref`, optional `datetime`.
- **InternalScoring**: Numeric rank, distance, confidence, and selection rationale stay internal by default.

## §RetrievalCore
- **Hybrid**: Lexical/FTS, semantic/vector, temporal, and graph-assist cooperate internally.
- **RRF/Rerank**: Harness fuses and reranks internally before returning bounded entries.
- **GraphAssist**: Auxiliary internal traversal for multi-hop grounding.
- **Fallback**: If one strategy is unavailable or low-yield, return useful partial results and `unapplied`.
- **Workers**: Deeper retrieval/planning uses local workers while the public recall surface stays compact.

## §Upkeep
- **Compaction**: Librarian promotes durable lessons, facts, patterns, and risks.
- **Extraction**: Local inference workers extract typed entity/relation triples at ingest.
- **Decay/Reinforce**: Unused memories decay; repeated useful recall strengthens retention.
- **Audit**: Retrieval and memory effects remain reviewable through durable records.
