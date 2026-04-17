# §MemoryRetrieval

Tiered durability (FTS5 + Vector hybrid).

## §Tiers
- **Tier 1 (Working)**: Current turn log.
- **Tier 1.5 (Scratchpad)**: Persistent notepad (`runtime/scratchpads/<agent>.md`).
- **Tier 2 (Episodic)**: Summaries/digests.
- **Tier 3 (Archival)**: Compacted lessons, structured facts, relations.

## §Retrieval
- **τHybrid**: FTS5 + Vector search.
- **HyDE**: `hyde` (inference-local-medium) → hypothetical answer embedding.
- **Decomposition**: `decompose_keywords` (inference-local-small) → HL/LL FTS fusion via RRF.
- **Reranking**: `inference-local-rerank` top-k filtering.

## §Upkeep
- **Refresh**: Async, non-blocking staleness check.
- **Reinforce/Decay**: Ebbinghaus-style curve (recall strength vs. unused decay).
- **Compaction**: `librarian` jobs → structured facts, patterns, risks.
- **Extraction**: `inference-local-medium` → typed entity/relation triples at ingest.
