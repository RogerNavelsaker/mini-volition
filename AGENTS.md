# .fleet agents guide

This file is the local operating guide for agent work inside mini-volition.

## scope

mini-volition is a local multi-agent runtime scaffold for ACP-driven agents.

It currently includes:

- message transport via SQLite
- a harness around cloud ACP agents
- a per-agent internal job queue
- an async per-agent memory indexing surface
- local reference notes derived from upstream Volition docs
- operator harness CLI
- public digest worker
- local inference split into dedicated per-model workers over Unix sockets

## canonical local surfaces

- entrypoint: `bin/fleet`
- fleet launcher in PATH: `bin/fleet`
- layout: `config/fleet.kdl`
- source: `src`
- `src/` is folder-only; command entrypoints live at `src/<module>/main.ts`
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
- current durable packet families are:
  - `turns/<agent>.jsonl`
  - `actions/<agent>.jsonl`
  - `runtime/<agent>.jsonl`
  - `jobs/<agent>.jsonl`
  - `mail/<agent>.jsonl`
  - `fleet/governor.jsonl`
  - `reviews/<agent>.md`

## binary surface

Only these binaries are part of the intended surface:

- `agent-*` commands are per-agent domain surfaces
- `fleet*` commands are fleet-wide coordination or shared service surfaces
- per-agent recovery/review flows belong under `agent-state`, not `fleet`
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

Do not reintroduce:

- `am`
- `harness`
- `operator`
- `reply`
- `fleet-*` wrapper commands
- `fleet-inference` (replaced by dedicated per-model workers)
- `messages.db`
- `inference.sock`

## current behavioral rules

- agents run only in ACP mode
- the harness owns prompting, envelope parsing, and normal reply dispatch
- the harness owns wake selection across current sources
- the harness selects model tier and effort/reasoning level per turn (split-brain via ACP), using local-model assistance when available and deterministic fallback otherwise
- split-brain re-run policy: if a `light` turn completes with an `escalate` action, high/urgent `queue_task`, or `sleep_until`, the harness detects complexity mismatch and re-queues the wake as a high-priority internal job forced to `full` profile
- agents should not construct transport commands for normal replies
- `agent-mail` is transport only
- `agent-mail` now uses per-agent burst claim receipts so claimed mail is only completed after a successful turn
- `agent-mail` owns `agent-mail.db`
- `agent-mail` also emits append-first message and claim lifecycle records under `state/mail/`
- `agent-state` is per-agent runtime state
- `agent-state` owns `agent-state.db` state records and turn/action journals
- `agent-state` also emits append-first runtime-state records under `state/runtime/`
- `agent-jobs` owns deferred per-agent work
- `agent-jobs` owns `agent-jobs.db`
- `agent-jobs` also emits append-first job lifecycle records under `state/jobs/`
- `agent-jobs` now also owns stale-claim recovery for deferred work through a queue TTL; `agent-harness` calls that path before wake selection
- `agent-jobs` now supports explicit `waiting`, `blocked`, and `cancelled` states in addition to queued/claimed/completed/failed
- `agent-memory` owns async per-agent memory indexing, embedding, retrieval artifacts, and local memory links
- `agent-memory` owns `agent-memory.db`
- `agent-memory` persists its current-state schema under `agent_memory_*`
- `agent-memory` also emits append-first memory snapshots under `state/memory/` for derived memory state (`agent_memory_*`)
- upstream memory source tables are now append-first under `state/memory-source/` (`working/`, `episodic/`, `archival/`, `digests/`)
- `agent-memory` implementation is now split into logical modules under `src/agent-memory/`, including `facts`
- `agent-jobs` implementation is now split into helpers under `src/agent-jobs/`
- `agent-mail` implementation is now split into helpers under `src/agent-mail/`
- `agent-harness` implementation is now split into helpers under `src/agent-harness/`
- `fleet-librarian` owns scheduled background upkeep over per-agent memory state; it is not a second memory store
- `fleet-librarian` owns `fleet-librarian.db` maintenance journaling only
- `fleet-librarian` implementation is now split into helpers under `src/fleet-librarian/`
- `fleet-librarian` now queues maintenance into `agent-jobs`, and `agent-harness` executes those maintenance tasks directly without ACP turns
- `fleet-librarian` now uses the same `agent-jobs` stale-claim TTL path for maintenance recovery so queue repair stays in one place
- `agent-harness` now journals turn phases in `fleet_turn_journal` and marks stale started turns as interrupted on startup using `FLEET_TURN_STALE_MS`
- `agent-harness` now enforces `FLEET_TURN_TIMEOUT_MS` as a deadman timeout for hung ACP turns and alerts `operator` on timeout
- stale interrupted internal turns are now replayed on startup by immediate job reschedule
- stale interrupted mail turns are now replayed on startup by immediate claim release
- interrupted turns that may already have started actions are now held for manual review instead of auto-replay
- current recovery policy is explicit per action type and stored in the action journal: `noop`, `note`, and `spawn_scribe` are replay-safe, while `reply`, `queue_task`, `escalate`, `scratchpad`, and `sleep_until` require manual review
- `agent-state recover-turns <agent>` can now trigger the same recovery path on demand
- `agent-state review-turns <agent>` can now inspect manual-review turns with associated action phases, replay-risk explanations, and turn checkpoints
- `agent-state resolve-turn <agent> <turn_key> <replay|discard>` can now resolve a manual-review turn explicitly
- `agent-state list-checkpoints <agent> [limit]` can now inspect durable turn checkpoints directly
- recovery now consults checkpoint envelope state as well as action replay policy; weak or missing checkpoint evidence forces manual review
- `fleet` is fleet-level orchestration and governor control
- `fleet` owns `fleet.db` for governor/orchestration state only
- `fleet` also emits append-first governor events under `state/fleet/`
- rebuild stays with the owner command:
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
- `agent-memory rebuild [agent]` now rebuilds both upstream memory source tables and derived `agent_memory_*` state
- verify commands should return actionable drift summaries and the exact owner-local rebuild command to run
- verify commands now include row-level content drift detail (sampling recent rows for field-level comparison, not just count matching)
- `agent-state replay-turn <agent> <turnKey>` now supports explicit replay/resume of interrupted turns by reading checkpoint state and re-queuing via job reschedule or mail claim release
- `operator-harness` is the human operator surface
- escalation currently routes through `agent-mail` to recipient `operator`
- provider rate limits are treated as hibernation windows, not generic failures
- claimed internal jobs that hit provider limits should be rescheduled through `agent-jobs`
- stale claimed mail bursts are recovered through `agent-mail reclaim-stale`, and `agent-harness` calls that before wake selection
- `agent-mail release-claim` can now immediately replay interrupted mail turns without waiting for stale-claim TTL recovery
- `agent-mail claims` can now inspect per-agent transport claim receipts when debugging interrupted mail turns
- `agent-state list-turns` can now inspect recent turn-journal phases when debugging interrupted turns
- inference is split into four dedicated workers, each owning one model and one Unix socket:
  - `fleet-embed` — `Xenova/bge-m3` (q8) on `embed.sock` — serves `embed`
  - `fleet-rerank` — `onnx-community/bge-reranker-v2-m3-ONNX` (q4) on `rerank.sock` — serves `rerank`
  - `fleet-e2b` — Gemma 4 E2B (q4f16) on `e2b.sock` — serves `summarize`, `choose_retrieval_mode`, `choose_turn_profile`, `decompose_keywords`, `scribe`
  - `fleet-e4b` — Gemma 4 E4B (q4f16) on `e4b.sock` — serves `compact`, `extract_entities`, `hyde`, `scribe`
- callers connect directly to the model they need via `FLEET_EMBED_SOCKET`, `FLEET_RERANK_SOCKET`, `FLEET_E2B_SOCKET`, `FLEET_E4B_SOCKET`
- socket backlog handles implicit queuing — no application-level task queue between callers and workers
- `agent-memory` refreshes artifacts off the turn path, and `agent-harness` falls back to deterministic recency when those artifacts are unavailable
- `agent-memory` now records refresh freshness and last error, and stale artifacts trigger background refresh instead of blocking turns
- `agent-harness` now reinforces the memory artifacts it actually injects, and `agent-memory` can decay unused artifacts over time
- `agent-memory` lookup now uses hybrid FTS5 and vector retrieval fused with RRF, with precision reranking via fleet-rerank when >5 candidates exist, and linked archival items can boost each other during recall
- `agent-memory` lookup now uses HyDE query expansion via fleet-e4b (hypothetical answer embedding for better vector recall, falls back to literal query)
- `agent-memory` lookup now uses dual keyword decomposition via fleet-e2b (high-level thematic + low-level specific FTS passes fused with RRF, falls back to primary query only)
- embedded relation evidence: link graph edges now have their evidence text embedded and indexed in `agent_memory_search_index` with `record_kind='link'`, making the link graph semantically searchable
- archival links are now typed heuristically from structured item kinds rather than stored only as generic overlap edges
- `agent-memory` lookup now emits retrieval traces for inspectability
- `agent-harness` now injects linked archival neighbors and trace summaries as explicit prompt sections
- `agent-memory` lookup now exposes explicit `local` / `global` / `mix` retrieval modes
- `agent-harness` now asks `fleet-e2b` to choose retrieval mode when possible, falls back to embedding similarity, and only then falls back to deterministic policy
- local memory links now have temporal validity windows, and default recall only follows currently-valid relations
- `agent-memory` now exposes a `timeline` read path for inspecting relation history around matching memory items
- `agent-harness` now injects temporal relation history as its own prompt section instead of treating time only as hidden retrieval metadata
- `agent-memory` now also exposes `invalidate` so contradiction handling can end-date active relations rather than overwrite them
- `agent-memory` now derives and stores first-pass temporal facts from compaction output
- `agent-memory` compaction now uses LLM entity extraction via fleet-e4b at ingest time instead of regex heuristics, falling back to regex `deriveFacts()` if the E4B worker is unavailable
- `fleet-librarian` now queues entity extraction maintenance jobs for compaction items missing associated facts
- `agent-harness` now injects current facts as their own prompt section
- `agent-memory` now also exposes recent invalidations, and `agent-harness` injects them separately from current facts
- when optional intelligence is useful, prefer: local model first, weaker optional fallback second, deterministic fallback last
- `fleet-librarian` now rebalances memory importance in the background based on recall and decay signals
- `fleet-librarian` now compacts reinforced episodic and digest artifacts into archival lessons
- archival compaction now produces structured long-term fields in addition to prose reflections
- structured archival items now participate in retrieval directly, and related items can be linked in a local graph-like table
- each agent has a persistent scratchpad (tier 1.5) at `runtime/scratchpads/<agent>.md`
- scratchpad is injected every turn with its own P2 section budget
- agents manage their scratchpad via the `scratchpad` action type (ops: `append`, `replace`, `clear`)
- scratchpad has a configurable char cap (default 6k) and agents are warned in the prompt when it's near full (80%) so they prune proactively
- scratchpad files are canonical markdown (not in SQLite) — the agent's own persistent notepad across wake cycles

## context efficiency rules

- output machete: agent responses are hard-truncated at 20k chars (configurable via `FLEET_MACHETE_LIMIT`) before envelope parsing
- output budget: prompt tells agents their response budget (default 8k chars, configurable via `FLEET_OUTPUT_BUDGET`)
- section budgets: each memory tier is capped independently (P1 uncapped, P2/P3 capped)
- token-dense prompt: TDD-inspired shorthand (§ section, ∂ delta, τ type) reduces structural overhead
- agent I/O is compact JSON — no prose outside the envelope, no unnecessary whitespace
- operator display uses TOON-style tabular rendering for action summaries
- durable storage: JSONL for structured records, markdown for doctrine
- SQLite is the hotpath acceleration layer and hot-path buffer, not the source of truth (petiole pattern)
- action journal and turn/checkpoint projection should prefer grouped flushes over row-by-row commit storms

## schema and compatibility rule

This folder is current-state only.

Do not add:

- schema migrations
- legacy DB compatibility
- old binary aliases
- fallback paths for removed names

If schema changes are needed, update the current schema directly and rebuild from a clean DB when necessary.

## design direction

Primary next targets:

- ~~replay/resume semantics over current turn, mail-claim, and job journals~~ — **DONE** (`agent-state replay-turn`, row-level verify drift, light→full re-run)
- canonical JSONL/markdown durable storage is now broadly wired under `state/`, with owner-local rebuild and verify commands

Current wake policy:

- explicit wake selection exists in `agent-harness`
- current sources are `agent-jobs` and `agent-mail`
- current priority order is urgent mail, urgent internal jobs, private mail, high internal jobs, public mail, normal internal jobs, low internal jobs
- during cooldown, only hot wakes are processed
- both cooldown and normal wakes use the same turn-execution path
- wake reasons are recorded in `agent-state`
- ACP rate-limit diagnostics are scraped for reset or retry timing and converted into hibernation windows when possible

Secondary targets:

- refractory scheduler (per-source cooldown groups, not just global governor)
- multi-source wake orchestration (alarms, reminders, subprocess completions)
- dynamic channel subscriptions and focus protocol
- ~~scribe delegation (fire-and-forget single-shot workers)~~ — **DONE** (`spawn_scribe` action type)
- fleet protocol evolution by agent proposal
- ~~stronger governor, recovery, and replay semantics~~ — **DONE** (replay-turn, row-level verify, light→full re-run)
- ~~retrieval-aware memory promotion and compaction~~ — **DONE** (LLM extraction, HyDE, dual keywords, reranking, embedded link evidence)
- stronger async memory workers and repair flows

## prompt source rule

Treat `docs/*.md` and `prompts/*.md` as the source material for generated system prompts.

Use `references/*.md` for upstream behavior notes and external design references.

Do not bury durable fleet doctrine only inside code strings when it should live in docs or prompt source files.

## editing guidance

- keep ownership lines explicit
- keep transport, state, orchestration, and inference separated
- prefer current explicit behavior over compatibility shims
- keep local docs in mini-volition aligned when behavior changes materially
