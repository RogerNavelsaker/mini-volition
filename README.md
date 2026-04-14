# fleet

mini-volition is a local ACP-based fleet runtime for coordinating multiple cloud agents with SQLite-backed messaging and a shared local inference service.

## structure

- `bin/`
  - compiled command surface
- `build/`
  - bun metadata, dependencies, generated support bundles
- `config/`
  - runtime configuration
- `docs/`
  - doctrine, protocols, restart notes
- `references/`
  - upstream behavior notes and external design references
- `prompts/`
  - source prompt overlays
- `src/`
  - implementation code, folder-only; each command now lives under `src/<module>/main.ts`

## command surface

- `agent-*` commands own per-agent transport, state, jobs, memory, and harness behavior
- `fleet*` commands own shared orchestration, inference, digesting, and librarian services
- per-agent recovery/review flows now live under `agent-state`, not `fleet`
- `fleet`
- `agent-mail`
- `agent-harness`
- `agent-state`
- `agent-jobs`
- `agent-memory`
- `operator-harness`
- `fleet-digest`
- `fleet-librarian`
- `fleet-embed`
- `fleet-rerank`
- `fleet-e2b`
- `fleet-e4b`

## runtime files

- entrypoint: `bin/fleet`
- layout: `config/fleet.kdl`
- build metadata: `build/package.json`, `build/bun.lock`
- agent-mail DB: `runtime/agent-mail.db`
- agent-jobs DB: `runtime/agent-jobs.db`
- agent-memory DB: `runtime/agent-memory.db`
- agent-state DB: `runtime/agent-state.db`
- fleet DB: `runtime/fleet.db`
- fleet-librarian DB: `runtime/fleet-librarian.db`
- embed socket: `runtime/embed.sock`
- rerank socket: `runtime/rerank.sock`
- e2b socket: `runtime/e2b.sock`
- e4b socket: `runtime/e4b.sock`
- runtime state files live under `runtime/`
- durable append artifacts live under `state/`
- current durable packet families:
  - `state/turns/<agent>.jsonl`
  - `state/actions/<agent>.jsonl`
  - `state/runtime/<agent>.jsonl`
  - `state/jobs/<agent>.jsonl`
  - `state/mail/<agent>.jsonl`
  - `state/fleet/governor.jsonl`
  - `state/reviews/<agent>.md`

## current model

- agents receive work from `agent-mail`
- `agent-mail` now owns only transport state in `agent-mail.db`
- `agent-mail` now also writes append-first message and claim lifecycle records under `state/mail/`
- per-agent queued work is owned by `agent-jobs`
- `agent-jobs` now owns only deferred job state in `agent-jobs.db`
- `agent-jobs` now also writes append-first job lifecycle records under `state/jobs/`
- `agent-jobs` now supports `waiting`, `blocked`, and `cancelled` states in addition to queued/claimed/completed/failed
- async per-agent memory promotion, embedding, retrieval, and link storage are owned by `agent-memory`
- `agent-memory` now owns memory tiers and retrieval artifacts in `agent-memory.db`
- `agent-state` owns per-agent runtime state, action journal, and turn journal in `agent-state.db`
- `agent-state` now also writes append-first runtime-state records under `state/runtime/`
- `fleet` owns governor/orchestration state in `fleet.db`
- `fleet` now also writes append-first governor events under `state/fleet/`
- `agent-memory` now writes append-first memory snapshots under `state/memory/` for derived memory state (`agent_memory_*`)
- upstream memory inputs are now also append-first under `state/memory-source/`:
  - `working/<agent>.jsonl`
  - `episodic/<agent>.jsonl`
  - `archival/<agent>.jsonl`
  - `digests/public.jsonl`
- rebuild commands now exist in the owning domains:
  - `agent-state rebuild [agent]`
  - `agent-state verify [agent]`
  - `agent-jobs rebuild [agent]`
  - `agent-jobs verify [agent]`
  - `agent-mail rebuild`
  - `agent-mail verify`
  - `agent-memory rebuild [agent]`
  - `agent-memory verify [agent]`
  - `fleet rebuild-governor`
  - `fleet verify-governor`
- verify commands now report drift issues plus the exact owner-local rebuild command to repair projection drift
- verify commands now include row-level content drift detail (sampling recent rows for field-level comparison, not just count matching)
- `agent-state replay-turn <agent> <turnKey>` now supports explicit replay/resume of interrupted turns by reading checkpoint state and re-queuing via job reschedule or mail claim release
- `fleet-librarian` owns maintenance journaling in `fleet-librarian.db`
- `agent-memory` persists its current-state schema under `agent_memory_*`
- `agent-memory` is now split into logical internal modules under `src/agent-memory/` (`types`, `schema`, `links`, `facts`) instead of keeping all memory logic in one file
- `agent-jobs` is now split into `src/agent-jobs/` helpers while keeping the `agent-jobs` command surface stable
- `agent-mail` is now split into `src/agent-mail/` helpers while keeping the `agent-mail` command surface stable
- `agent-harness` now has internal recovery helpers under `src/agent-harness/`
- `fleet-librarian` now has internal maintenance helpers under `src/fleet-librarian/`
- `fleet-librarian` schedules upkeep over per-agent memory state; it is not a separate fleet-memory store
- `fleet-librarian` now queues maintenance through `agent-jobs`, and `agent-harness` executes those maintenance jobs directly as internal wake work
- `agent-jobs` now supports stale-claim recovery with a TTL, and `agent-harness` invokes it before wake selection so interrupted claimed work can return to the queue
- `fleet-librarian` now uses that same stale-claim recovery path for maintenance jobs instead of maintaining a separate queue-repair rule
- `agent-harness` builds wake context, selects model/effort per turn (split-brain), and parses action envelopes
- split-brain turn selection is now live: the harness asks the local model for a `light|full|max` turn profile when possible, falls back to deterministic wake/layer policy, and records the chosen profile in turn context
- split-brain re-run policy: if a `light` turn completes with an `escalate` action, high/urgent `queue_task`, or `sleep_until`, the harness detects complexity mismatch and re-queues the wake as a high-priority internal job forced to `full` profile
- the harness arbitrates between internal jobs and mail bursts with explicit priorities and wake reasons
- the harness now journals turn phases durably in `fleet_turn_journal` and marks stale in-progress turns as interrupted on startup after `FLEET_TURN_STALE_MS`
- interrupted stale internal turns are now actively replayed on startup by rescheduling their claimed job immediately
- interrupted stale mail turns are now actively replayed on startup by releasing their specific mail claim immediately
- interrupted turns with started/completed action phases are now held for manual review instead of being auto-replayed blindly
- current replay policy is explicit per action type and stored in the action journal: `noop` and `note` are replay-safe, while `reply`, `queue_task`, `escalate`, `scratchpad`, and `sleep_until` require manual review
- `agent-state recover-turns <agent>` now triggers the same recovery path on demand without restarting the harness
- `agent-state review-turns <agent>` now shows manual-review turns with associated action phases, replay-risk explanations, and turn checkpoints
- `agent-state resolve-turn <agent> <turn_key> <replay|discard>` now lets the operator explicitly resolve a manual-review turn
- recovery now consults checkpoint envelope state as well as action replay policy; turns with missing or weak checkpoint evidence are held for manual review instead of auto-replayed
- `agent-harness` now records durable turn checkpoints with selected wake details, prompt hash, prompt size, and envelope status in `fleet_turn_checkpoints`
- the harness now enforces a deadman timeout on ACP turn execution with `FLEET_TURN_TIMEOUT_MS`, kills hung turns, records failure, and alerts `operator`
- `agent-mail` now claims bursts through per-agent claim receipts, and the harness only completes those claims after a successful turn
- `agent-mail` now supports stale mail-claim recovery with `FLEET_MAIL_CLAIM_TTL_MS`, and the harness invokes it before wake selection
- the harness now treats urgent mail and high-priority internal jobs as hot wakes during cooldown
- normal and cooldown wakes now run through one shared turn-execution path
- ACP rate-limit responses are parsed for retry/reset windows and the harness hibernates until the provider window opens again
- rate-limited internal jobs are rescheduled instead of being marked failed
- the harness dispatches normal replies
- `agent-memory` prepares memory artifacts off the turn path, and `agent-harness` retrieves them if available instead of relying only on fixed recency slices
- `agent-memory` now tracks refresh freshness and error state, and `agent-harness` requests background refresh when artifacts are stale or missing
- recalled memory artifacts are now reinforced asynchronously, and `agent-memory` supports decay so old unused memories weaken over time
- memory lookup now uses hybrid retrieval: SQLite FTS5 keyword search plus embedding search fused with RRF, with precision reranking via fleet-rerank when >5 candidates exist, and linked archival items able to boost each other
- memory lookup now uses HyDE query expansion via fleet-e4b (hypothetical answer embedding for better vector recall, falls back to literal query)
- memory lookup now uses dual keyword decomposition via fleet-e2b (high-level thematic + low-level specific FTS passes fused with RRF, falls back to primary query only)
- embedded relation evidence: link graph edges now have their evidence text embedded and indexed in `agent_memory_search_index` with `record_kind='link'`, making the link graph semantically searchable through the existing hybrid retrieval path
- structured archival links are now typed heuristically (`informs_decision`, `summarizes_pattern`, `risk_for_decision`, `repeats_*`, etc.) instead of only undifferentiated overlap links
- memory lookup now returns retrieval traces so recall can be inspected instead of treated as opaque ranking
- `fleet-librarian` now rebalances memory importance in the background instead of leaving importance fixed at ingest time
- `fleet-librarian` now also compacts reinforced episodic and digest artifacts into archival lessons off the turn path
- archival compaction now stores both prose and structured fields (`facts`, `decisions`, `patterns`, `open_risks`)
- retrieval now includes structured archival items through a unified search index, and compaction items can be linked to related archival items
- `agent-harness` now injects linked archival neighbors and compact retrieval traces as explicit turn sections instead of flattening memory into only digest/episodic/archival buckets
- `agent-memory` lookup now supports explicit retrieval modes: `local`, `global`, and `mix`
- `agent-harness` now asks `fleet-e2b` to choose retrieval mode with the Gemma model when available, falls back to embedding similarity if needed, and only then falls back to deterministic policy
- local memory links now carry validity windows (`valid_from`, `valid_to`) so recall follows currently-valid relations by default
- `agent-memory timeline` now exposes relation history for matching structured memory items
- `agent-harness` now injects a compact temporal `§TIMELINE` section so turn assembly can see recent relation history, not just current ranking
- `agent-memory invalidate` can now end-date active relations around matching structured memory items instead of silently overwriting contradictions
- `agent-memory` now derives first-pass temporal facts from structured compaction output, stores them durably, and exposes current valid facts in lookup
- `agent-memory` compaction now uses LLM entity extraction via fleet-e4b at ingest time instead of regex heuristics, falling back to regex `deriveFacts()` if the E4B worker is unavailable
- `fleet-librarian` now queues entity extraction maintenance jobs for compaction items missing associated facts
- `agent-harness` now injects a dedicated `§FACTS` section so current fact-like truth is visible during turn assembly
- `agent-memory` lookup now also exposes recent invalidations, and `agent-harness` injects them as `§INVALIDATED` so superseded truth stays visible but separate
- the preferred control pattern is now: local model when available, optional weaker fallback, deterministic last-resort fallback
- public traffic is summarized by `fleet-digest`
- inference is split into four dedicated workers, each with its own process and Unix socket
- `fleet-embed` serves embeddings via `embed.sock` using `Xenova/bge-m3` (dtype `q8`)
- `fleet-rerank` serves reranking via `rerank.sock` using `onnx-community/bge-reranker-v2-m3-ONNX` (dtype `q4`)
- `fleet-e2b` serves summarization, retrieval mode selection, turn profile selection, keyword decomposition, and scribe via `e2b.sock` using Gemma 4 E2B (`onnx-community/gemma-4-E2B-it-ONNX`, dtype `q4f16`)
- `fleet-e4b` serves compaction, entity extraction, HyDE query expansion, and scribe via `e4b.sock` using Gemma 4 E4B (`onnx-community/gemma-4-E4B-it-ONNX`, dtype `q4f16`)
- each agent has a persistent scratchpad (tier 1.5) at `runtime/scratchpads/<agent>.md`, injected every turn, agent-managed via `scratchpad` action type, with cap and prune notification

## context efficiency

- output machete: hard 20k char truncation on agent response before envelope parsing
- output budget directive: prompt communicates 8k char advisory budget to agents
- section budgets: memory tiers are capped independently (P1 uncapped, P2/P3 capped per section)
- token-dense prompt: TDD-inspired shorthand reduces structural token overhead
- compact JSON for all agent I/O; TOON-style tabular rendering for operator display
- SQLite is the hotpath acceleration layer and hot-path buffer; canonical records live in JSONL/markdown under `state/` (petiole pattern)
- action and turn/checkpoint projection are now flushed in grouped batches through `agent-state`, instead of committing every journal row separately

## current action envelope

The current envelope is now strict and validated:

- optional `schema_version`
- required `actions[]`
- current supported action types:
  - `reply`
  - `noop`
  - `note`
  - `sleep_until`
  - `queue_task`
  - `escalate`
  - `scratchpad` (append/replace/clear)
  - `spawn_scribe` (fire-and-forget delegation to local Gemma models; result returns via agent-mail)
- invalid envelopes fail closed and no actions are executed
- action execution is journaled durably through `agent-state`
- deferred internal work is queued durably through `agent-jobs`
- queued internal work now supports `low` / `normal` / `high` / `urgent` priority
- `agent-jobs` now supports rescheduling claimed work back into the queue
- `agent-jobs` now supports `reclaim-stale <agent> [ttlMs]`, with `FLEET_JOB_CLAIM_TTL_MS` as the default TTL used by the harness
- `agent-mail` now supports `complete-burst <messageId...>` and `reclaim-stale [ttlMs]` so claimed mail is not treated as consumed until the turn succeeds
- `agent-mail` now supports `release-claim <messageId...>` so startup recovery can replay interrupted mail turns immediately without waiting for the generic stale-claim TTL
- `agent-mail` now also supports `claims [limit]` to inspect outstanding or completed transport claim receipts for the current agent
- `agent-state` now supports `list-turns <agent> [limit]` to inspect recent turn-journal phases directly
- escalation routes to the existing `operator` recipient on `private` or `urgent`

## references

Behavior references saved locally:

- `references/volition-readme-notes.md`
- `references/volition-guppi-loop-notes.md`
- `references/volition-fleet-protocols-notes.md`

This keeps transport under harness control and establishes the base execution contract for broader action support.

## next step

Immediate:

- extend the newly wired `state/` JSONL/markdown artifacts beyond turns/actions/runtime/jobs/mail/governor into broader rebuild packets
- use the new owner-local rebuild commands to repopulate hot-path SQLite state from `state/`
- `agent-memory rebuild [agent]` now restores both upstream memory source tables and derived `agent_memory_*` state from disk
- ~~add replay/resume semantics on top of the new turn and transport journals~~ — **DONE** (`agent-state replay-turn`)

Then:

- refractory scheduler (per-source cooldown groups)
- multi-source wake orchestration (alarms, reminders, subprocess completions)
- dynamic channel subscriptions and focus protocol
- ~~scribe delegation (fire-and-forget single-shot workers)~~ — **DONE** (`spawn_scribe` action type)
- fleet protocol evolution by agent proposal
- ~~recovery and replay semantics~~ — **DONE** (replay-turn, row-level verify, light→full re-run)
- ~~stronger retrieval-aware memory promotion and compaction~~ — **DONE** (LLM extraction, HyDE, dual keywords, reranking, embedded link evidence)

## doctrine set

- `AGENTS.md`
- `TODO.md`
- `docs/ARCHITECTURE.md` — index
- `docs/1-philosophy.md`
- `docs/2-core-architecture.md`
- `docs/3-turn-loop.md`
- `docs/4-memory.md`
- `docs/5-topology.md`
- `docs/6-schemas.md`
- `docs/7-governance.md`
- `docs/genesis.md`
- `docs/fleet-protocols.md`

## non-goals

This folder no longer carries:

- legacy DB names
- migration code
- short-name command aliases
- standalone reply helper binaries
