# Completed Work

## Transport & Messaging
- SQLite-backed message transport (`agent-mail`) with per-agent burst claim receipts.
- Stale mail-claim recovery with configurable TTL.
- Append-first message and claim lifecycle records under `state/mail/`.
- `agent-mail rebuild` and `agent-mail verify` for projection drift detection and repair.

## Turn Execution
- Harness-owned turn loop with structured action envelope (strict validation, fail-closed).
- Supported action types: `reply`, `noop`, `note`, `sleep_until`, `queue_task`, `escalate`, `scratchpad`, `spawn_scribe`.
- Split-brain turn profile selection (`light|full|max`) via local model assistance with deterministic fallback.
- Light-to-full re-run: harness detects complexity mismatch after light turns and re-queues as high-priority full profile.
- Output machete (20k char hard truncation) and output budget (8k char advisory) for context efficiency.
- Section budgets: memory tiers capped independently (P1 uncapped, P2/P3 capped).
- Token-dense prompt format (TDD shorthand).

## Wake Selection
- Priority-based wake selection across internal jobs and agent-mail bursts.
- Priority order: urgent mail > urgent jobs > private mail > high jobs > public mail > normal jobs > low jobs.
- Cooldown windows admit hot wakes while suppressing workload wakes.
- Shared turn-execution path for cooldown and normal wakes.
- ACP rate-limit diagnostics parsed for retry/reset windows; converted to hibernation.
- Rate-limited internal jobs rescheduled instead of failed.

## Job Queue
- Per-agent deferred work queue (`agent-jobs`) with `low|normal|high|urgent` priority.
- Job states: `queued`, `claimed`, `completed`, `failed`, `waiting`, `blocked`, `cancelled`.
- Stale-claim recovery with configurable TTL.
- Claimed jobs can be rescheduled back into the queue.
- Append-first job lifecycle records under `state/jobs/`.
- `agent-jobs rebuild` and `agent-jobs verify` with row-level content drift detail.

## Recovery
- Durable turn phase journaling in `fleet_turn_journal`.
- Durable turn checkpoints with wake snapshot, prompt hash, prompt size, envelope status.
- Stale started turns marked `interrupted_recovered` on startup after configurable TTL.
- Interrupted internal turns replayed on startup via immediate job reschedule.
- Interrupted mail turns replayed on startup via immediate claim release.
- Interrupted turns with started/completed action phases held for manual review.
- Per-action replay disposition: `noop`, `note`, `spawn_scribe` are replay-safe; others require manual review.
- `agent-state replay-turn <agent> <turnKey>` for explicit replay/resume from checkpoint state.
- `agent-state recover-turns <agent>` for on-demand recovery without restart.
- `agent-state review-turns <agent>` for inspecting manual-review turns with action phases and risk explanations.
- `agent-state resolve-turn <agent> <turn_key> <replay|discard>` for explicit resolution.
- Deadman timeout (`FLEET_TURN_TIMEOUT_MS`) kills hung turns and alerts operator.

## Memory
- Tiered memory: working, episodic, archival, digests.
- Hybrid retrieval: SQLite FTS5 keyword search + vector embedding search fused with RRF.
- Precision reranking via `fleet-rerank` when >5 candidates.
- HyDE query expansion via `fleet-heavy` (hypothetical answer embedding, falls back to literal query).
- Dual keyword decomposition via `fleet-light` (HL thematic + LL specific FTS passes fused with RRF).
- LLM entity extraction at ingest via `fleet-heavy` (typed subject/predicate/object tuples, falls back to regex).
- Embedded relation evidence: link graph edges semantically searchable via `agent_memory_search_index`.
- Typed archival links (heuristic: `informs_decision`, `summarizes_pattern`, `risk_for_decision`, etc.).
- Link validity windows (`valid_from`, `valid_to`) with default recall following currently-valid relations.
- Retrieval traces emitted for inspectability.
- Explicit retrieval modes (`local|global|mix`) with model-assisted selection via `fleet-light`.
- Timeline read path for relation history around structured memory items.
- First-pass temporal facts derived from compaction output.
- Invalidation: end-date active relations instead of overwriting contradictions.
- Recent invalidations exposed alongside current facts in turn assembly.
- Reinforcement and decay (Ebbinghaus-style curve baseline).
- Per-agent scratchpad at `runtime/scratchpads/<agent>.md` (6k cap, 80% warning, managed via `scratchpad` action).
- Append-first memory snapshots under `state/memory/` and upstream source packets under `state/memory-source/`.
- `agent-memory rebuild` and `agent-memory verify` for projection drift detection and repair.
- Memory internals split into logical modules (`types`, `schema`, `links`, `facts`).

## Librarian
- Background importance rebalancing using recall/strength/decay signals.
- Compaction of reinforced episodic and digest artifacts into archival lessons.
- Structured archival fields alongside prose summaries (facts, decisions, patterns, open_risks).
- Entity extraction maintenance jobs queued for compaction items missing associated facts.
- Maintenance queued through `agent-jobs`; harness executes as internal wake work.
- Stale-claim recovery shares the generic `agent-jobs` TTL path.

## Inference
- One-process-per-model architecture: `fleet-embed` (BGE-M3 q8), `fleet-rerank` (BGE reranker v2 q4), `fleet-light` (q4f16), `fleet-heavy` (q4f16).
- Each worker: one model, one Unix socket, newline-JSON protocol.
- Socket backlog handles implicit queuing. No application-level task queue.
- `fleet-light` serves: `summarize`, `choose_retrieval_mode`, `choose_turn_profile`, `decompose_keywords`, `scribe`.
- `fleet-heavy` serves: `compact`, `extract_entities`, `hyde`, `scribe`.

## Providers
- Cloud provider workers: `fleet-claude`, `fleet-gemini`, `fleet-openai`, `fleet-openrouter`.
- Unified Unix socket protocol (`fleet-provider/server.ts`).
- Per-provider rate limits, quotas, and retry logic.
- Harness communicates with cloud models via provider sockets, not ACP CLI adapters.

## Scribe Delegation
- `spawn_scribe` action type: fire-and-forget delegation to local models.
- Scribe name to model routing: `scribe`/`milo` to `fleet-light`, `homer`/`roamer`/`riker` to `fleet-heavy`.
- Result returns via `agent-mail` private layer. Agent processes on next wake.

## Orchestration
- Zellij-based session management (`fleet genesis`, `fleet terminus`, `fleet restart`).
- Dynamic KDL layout generation from agent config (`config/fleet.json` or defaults).
- Governor with per-agent cooldown tracking and rate-limit-aware hibernation.
- Append-first governor events under `state/fleet/`.
- `fleet rebuild-governor` and `fleet verify-governor`.

## Durability
- Petiole pattern: SQLite is hotpath buffer, JSONL under `state/` is canonical.
- Append-first JSONL families: turns, actions, runtime, jobs, mail, governor, reviews.
- Upstream memory source packets: `state/memory-source/` (working, episodic, archival, digests).
- Derived memory snapshots: `state/memory/`.
- Action journal and turn/checkpoint projection batched through `agent-state`.
- Row-level content drift detail in verify commands (field-level comparison, not just count).

## Prompts
- System prompt split into base constitution (`prompts/base-system.md`) + per-agent overlays (`prompts/claude-system.md`, etc.).
- Provider-agnostic inference worker naming (`fleet-light`/`fleet-heavy`).

## Digest
- `fleet-digest` monitors public layer, batches conversation bursts, summarizes via `fleet-light`.
- Episodic digests stored and injected into agent turn context.
