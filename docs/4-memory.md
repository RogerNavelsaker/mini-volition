# memory

## authority split

- source memory tables such as `tier1_working`, `tier2_episodic`, `tier3_archival`, and `public_digests` remain the upstream inputs that feed memory refresh and compaction
- those upstream inputs are now also append-first under `state/memory-source/`
- derived memory state under `agent_memory_*` is now snapshotted append-first under `state/memory/<agent>.jsonl`
- `agent-memory rebuild [agent]` rebuilds both the upstream source tables and the derived `agent_memory_*` state and search indexes from those durable packets

## tier model

Fleet uses three memory tiers, a scratchpad, public digests, and an artifact cache.

### tier 1: working memory

Table: `tier1_working`

Turn-local context. The harness writes inbound messages and agent responses here. Last 5 entries are injected into the turn prompt. Ephemeral — not promoted, not embedded.

### tier 1.5: scratchpad

File: `scratchpads/<agent>.md`

Per-agent persistent notepad. Unlike working memory, the scratchpad survives across wake cycles and is fully agent-managed. The agent writes to it via `scratchpad` action type (ops: append, replace, clear). Injected every turn as a P2-budgeted section. Has a configurable char cap (default 6k) — agents are warned in the prompt at 80% so they can prune proactively. Canonical storage is the markdown file (petiole pattern — not in SQLite).

### tier 2: episodic memory

Table: `tier2_episodic`

Per-agent summaries of wake events. Each turn generates an episodic entry recording: what happened, how long the agent was asleep, and who was involved. Used for recent context assembly and as a source for archival compaction.

### tier 3: archival memory

Table: `tier3_archival`

Durable lessons. Produced by the librarian's compaction pass from reinforced episodic and digest artifacts. Stores both a prose reflection and structured fields (facts, decisions, patterns, open risks). Archival items participate directly in retrieval.

### public digests

Table: `public_digests`

Summaries of public channel traffic produced by fleet-digest. Shared across all agents as social awareness context. Not per-agent — all agents see the same digests.

### artifact cache

Table: `agent_memory_artifacts`

The indexed memory store owned by agent-memory. Each artifact:

- is sourced from a tier table (digest, episodic, or archival)
- has a content hash for deduplication
- has an embedding vector (from fleet-embed)
- has an FTS5 full-text index entry
- tracks importance (normal/elevated/critical), strength, recall count, decay score
- has a status (active, decayed, compacted)

## retrieval

Memory lookup uses hybrid search:

1. **FTS5 keyword search** — SQLite full-text search over artifact content
2. **Vector search** — cosine similarity over BGE-M3 embeddings
3. **RRF fusion** — Reciprocal Rank Fusion combines both ranked lists (k=60)
4. **Link boost** — if a retrieved archival item has links to other archival items, linked items get a score boost during recall

The harness calls `agent-memory lookup <agent> <query> <limit>` at turn assembly time. If prepared artifacts are unavailable or stale, it falls back to deterministic recency queries against the source tier tables.

## reinforcement and decay

**Reinforcement**: after each turn, the harness sends the IDs of all memory artifacts that were actually injected into the prompt. agent-memory increments their recall count, resets their last-recalled timestamp, and bumps their strength.

**Decay**: artifacts that are not recalled weaken over time following an Ebbinghaus-inspired curve:

- grace period (default 7 days) — no decay
- after grace, score decreases toward a floor (default 0.1)
- critical-importance artifacts never decay
- recall resets the grace period clock

## compaction

The librarian runs periodic compaction:

1. select reinforced episodic and digest artifacts above a strength threshold
2. batch them (up to 8 entries)
3. send to fleet-e4b `compact` endpoint
4. receive structured output: summary, lessons, facts, decisions, patterns, open_risks
5. store as a new archival entry with structured fields
6. link the new archival item to related existing archival items based on content overlap

Compacted source artifacts are marked as `compacted` status and excluded from future retrieval.

## librarian upkeep cycle

The fleet-librarian runs in a loop (default 60s interval) and performs:

1. **refresh** — re-index new source records into the artifact cache
2. **decay** — apply decay scoring to all active artifacts
3. **rebalance** — adjust importance based on recall frequency and strength signals
4. **repair** — if an agent's refresh has failed repeatedly, attempt a full re-index
5. **compact** — promote reinforced artifacts into archival lessons

## freshness

agent-memory tracks per-agent refresh state:

- last refresh timestamp
- last status (ok/error)
- last error message
- artifact count
- error streak counter

The harness checks freshness at turn assembly time. Stale or errored state triggers an async background refresh without blocking the turn.

## missing pieces

See TODO.md for planned improvements:

- HyDE / query expansion for retrieval
- raw-mode option for recent tiers
- proactive context loading based on current task
- hierarchical context propagation (project/task ancestry on artifacts)
