# fleet todo

This file is the local continuation point for work inside mini-volition.

## current state

- runtime entrypoint: `bin/fleet`
- layout: `config/fleet.kdl`
- active binaries in `bin`:
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
- upstream behavior notes: `references/*.md`
- agent-mail DB: `runtime/agent-mail.db`
- agent-jobs DB: `runtime/agent-jobs.db`
- agent-memory DB: `runtime/agent-memory.db`
- agent-state DB: `runtime/agent-state.db`
- fleet DB: `runtime/fleet.db`
- fleet-librarian DB: `runtime/fleet-librarian.db`
- runtime state files live under `runtime/`
- durable packet root: `state/`
- current durable packet families:
  - `state/turns/<agent>.jsonl`
  - `state/actions/<agent>.jsonl`
  - `state/runtime/<agent>.jsonl`
  - `state/jobs/<agent>.jsonl`
  - `state/mail/<agent>.jsonl`
  - `state/fleet/governor.jsonl`
  - `state/reviews/<agent>.md`
- public digest worker: `src/fleet-digest/main.ts`
- inference workers: `fleet-embed`, `fleet-rerank`, `fleet-e2b`, `fleet-e4b` (each under `src/<worker>/main.ts`)
- shared inference server factory: `src/fleet-inference/server.ts` (used by all four workers)
- build metadata: `build/package.json`, `build/bun.lock`

## current execution contract

- agents run only through ACP mode
- the harness selects model tier and effort/reasoning per turn (split-brain via ACP)
- transport is handled by `agent-mail`
- deferred internal jobs are handled by `agent-jobs`
- async memory indexing, embedding, and retrieval artifacts are handled by `agent-memory`
- scheduled memory upkeep, repair, importance curation, and archival compaction are handled by `fleet-librarian`
- transport, jobs, memory, agent state, fleet governor state, and librarian maintenance state are now split into focused SQLite files instead of one shared DB
- normal replies are not sent directly by agents
- the harness owns transport dispatch through a structured action envelope
- current envelope is strict and validated:
  - optional `schema_version`
  - required `actions[]`
  - supported action types:
    - `reply`
    - `noop`
    - `note`
    - `sleep_until`
    - `queue_task`
    - `escalate`
    - `scratchpad` (append/replace/clear)
    - `spawn_scribe` (fire-and-forget delegation to local Gemma models; result returns via agent-mail private layer)
  - invalid envelopes fail closed
  - action execution phases are recorded durably
  - wake selection is explicit in the harness
  - current wake policy is priority-based across current sources
  - internal jobs support `low` / `normal` / `high` / `urgent` priority
  - claimed jobs can now be rescheduled back into the queue on provider hibernation
  - claimed jobs can now also be reclaimed to `queued` after a stale-claim TTL, with the harness invoking `agent-jobs reclaim-stale` before wake selection
  - cooldown windows now allow hot wakes only
  - cooldown and normal wakes share one execution path
  - escalation routes to recipient `operator` on `private` or `urgent`
  - ACP rate-limit diagnostics are parsed for retry/reset windows and converted into hibernation when possible
- context efficiency:
  - output machete: hard 20k char truncation before envelope parsing (configurable via `FLEET_MACHETE_LIMIT`)
  - output budget: prompt communicates 8k char advisory budget (configurable via `FLEET_OUTPUT_BUDGET`)
  - section budgets: memory tiers capped independently (P1 uncapped, P2/P3 capped)
  - token-dense prompt: TDD-inspired shorthand (§ section, ∂ delta, τ type)
  - compact JSON for agent I/O; TOON-style tabular rendering for operator display
  - SQLite is hotpath acceleration and hot-path buffer; canonical records in JSONL/markdown (petiole pattern)
  - action journal and turn/checkpoint projection are now batched through `agent-state` instead of committing every row separately
- durable artifact root: `state/`
- inference is split into four dedicated workers: `fleet-embed` (embed.sock), `fleet-rerank` (rerank.sock), `fleet-e2b` (e2b.sock), `fleet-e4b` (e4b.sock)
- callers connect directly to the model they need via `FLEET_EMBED_SOCKET`, `FLEET_E2B_SOCKET`, `FLEET_E4B_SOCKET`, `FLEET_RERANK_SOCKET`
- `agent-memory` now refreshes digest, episodic, and archival artifacts off the turn path, and `agent-harness` retrieves them when available with recency fallback otherwise
- `agent-memory` owns the current per-agent memory schema under `agent_memory_*`, while `fleet-librarian` only schedules upkeep over that state
- `agent-memory` internals are now split into logical modules under `src/agent-memory/` (`types`, `schema`, `links`, `facts`) instead of staying monolithic
- `agent-mail`, `agent-jobs`, `agent-harness`, and `fleet-librarian` now also have internal helper modules under `src/<command>/` while keeping command entrypoints stable
- `src/` is now folder-only; command entrypoints live at `src/<module>/main.ts`
- `agent-memory` now records refresh status, freshness windows, and last error so the harness can treat stale artifacts as usable-but-needs-refresh
- recalled artifacts are now reinforced asynchronously and `agent-memory` exposes a decay path for unused artifacts
- lookup now uses SQLite FTS5 keyword search plus embedding retrieval fused with RRF, with precision reranking via fleet-rerank when >5 candidates exist
- the librarian now rebalances memory importance in the background using recall/strength/decay signals
- the librarian now compacts reinforced episodic and digest artifacts into archival lessons
- archival compaction now stores structured fields alongside prose summaries
- structured archival items now participate in retrieval, and overlap-based links between archival items are stored locally
- linked archival items can now boost each other during recall instead of remaining write-only graph metadata
- local archival links are now typed heuristically from structured item kinds and lookup emits retrieval traces for debugging recall
- `agent-harness` now consumes linked archival neighbors and retrieval traces as explicit turn-context sections
- `agent-memory` lookup now supports explicit `local` / `global` / `mix` retrieval modes, and `agent-harness` now asks `fleet-e2b` to choose among them before falling back to embedding similarity and deterministic policy
- local memory links now have validity windows and `agent-memory timeline` can inspect relation history around structured items
- `agent-harness` now injects temporal relation history as a dedicated turn-context section
- `agent-memory invalidate` can now end-date active relations around matching structured items as a first contradiction-handling step
- `agent-memory` now derives first-pass temporal facts from compaction output and `agent-harness` injects them as a dedicated fact section
- `agent-memory` lookup now exposes recent invalidations and `agent-harness` injects them as a dedicated invalidation section beside current facts
- `fleet-librarian` now queues maintenance through `agent-jobs`, and `agent-harness` executes those maintenance jobs as internal wake work
- `agent-jobs` now owns stale-claim recovery generically, and both `agent-harness` and `fleet-librarian` use that same TTL-based queue repair path
- `agent-mail` now owns stale burst-claim recovery generically, and `agent-harness` only completes claimed mail after a successful turn
- `agent-state` now emits append-first runtime-state records under `state/runtime/`
- `agent-jobs` now emits append-first job lifecycle records under `state/jobs/`
- `agent-mail` now emits append-first message and claim lifecycle records under `state/mail/`
- `agent-memory` now emits append-first derived-memory snapshots under `state/memory/`
- upstream memory source tables now emit append-first packets under `state/memory-source/`
- `fleet` now emits append-first governor events under `state/fleet/`
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
- `agent-harness` now records turn phases in `fleet_turn_journal` and marks stale started turns as interrupted on startup after `FLEET_TURN_STALE_MS`
- `agent-harness` now enforces `FLEET_TURN_TIMEOUT_MS` as a deadman timeout for hung ACP turns, records failure, and alerts `operator`
- stale interrupted internal turns are now replayed on startup by immediate job reschedule
- stale interrupted mail turns are now replayed on startup by immediate claim release

## highest-leverage next work

### 1. extend the queue-backed dispatcher

Build on the validated execution contract and the new internal queue path.

### 1.5. strengthen interrupted-turn recovery

Current state:

- stale claimed jobs can be reclaimed generically through `agent-jobs`
- stale claimed mail bursts can be reclaimed generically through `agent-mail`
- turn phases are journaled in `fleet_turn_journal`
- stale started turns are marked `interrupted_recovered` on harness startup
- ACP turns now have a hard deadman timeout and operator alert path
- stale interrupted internal turns are rescheduled immediately on startup
- stale interrupted mail turns are released immediately on startup
- interrupted turns with started/completed action phases are now held for manual review instead of auto-replay
- recovery now classifies started `noop` as auto-replay-safe and treats other started/completed action types as manual-review-only

Still missing:

- explicit replay or resume semantics for interrupted ACP turns beyond requeue/reclaim/manual-review gating
- more explicit operator/debug surfaces over interrupted claimed mail and interrupted turns

Recent progress:

- `agent-mail claims` now exposes per-agent transport claim receipts for inspection
- `agent-mail release-claim` now supports immediate replay of interrupted mail turns
- `agent-state list-turns` now exposes recent turn-journal phases for inspection
- `agent-state recover-turns <agent>` now triggers the same replay/release recovery path on demand
- `agent-state review-turns <agent>` now exposes manual-review turns with associated action phases, replay-risk explanations, and turn checkpoints
- `agent-state resolve-turn <agent> <turn_key> <replay|discard>` now resolves manual-review turns explicitly
- `agent-harness` now records durable turn checkpoints with wake snapshot, prompt hash, prompt size, and envelope status
- replay disposition is now stored explicitly in `fleet_agent_action_journal`
- `agent-harness` now flushes action journal and turn/checkpoint projection to `agent-state` in grouped batches, reducing write and commit storms on `agent-state.db`
- `state/` now extends beyond turn/action/review logs into runtime, jobs, mail, and governor rebuild packets
- `state/` now also carries upstream memory source packets and derived memory snapshots for `agent-memory rebuild`

## remaining highest-leverage list

1. durable turn checkpoints

- base checkpoint table now exists and is populated by the harness
- recovery now consults checkpoint envelope state for auto-replay decisions
- `agent-state get-checkpoint <agent> <turnKey>` now exposes direct per-turn checkpoint reads

- capture enough pre-action turn state to support stronger resume than requeue/release
- include selected wake event, prompt hash, and parsed envelope status

2. richer job semantics

- evolve `agent-jobs` toward fuller agent-local todo/work state
- base blocked/waiting/cancelled semantics now exist
- next step is dependencies, unblock policy, richer wait metadata, and stronger operator/debug views over non-runnable jobs

3. split-brain model/effort selection

- deterministic and local-model-assisted turn profile selection now exists in the harness
- ~~re-run/escalation policy from `light` to `full`/`max`~~ — **DONE**: harness detects complexity mismatch (escalate, high/urgent queue_task, sleep_until) after light turns and re-queues as high-priority internal job forced to full profile
- next step is clearer per-profile retry/timeout policy

4. canonical JSONL/markdown durability

- extend append-oriented durable records beyond the current turn/action/review artifacts into broader rebuild packets
- current rebuild packets now cover turns, actions, runtime state, jobs, mail, governor events, upstream memory source material, and derived memory snapshots
- keep SQLite as acceleration and hot-path buffer, not sole authority
- ~~deeper row-level mismatch detail where counts match but content diverges~~ — **DONE**: verify commands now sample recent rows for field-level content comparison (action_type, phase, replay_disposition, sender, recipient, layer, body, etc.)
- `agent-state replay-turn <agent> <turnKey>` now supports explicit replay/resume of interrupted turns by reading checkpoint state and re-queuing via job reschedule or mail claim release

Target shape:

```json
{
  "schema_version": 1,
  "summary": "brief reasoning result",
  "state": {
    "current_task": "..."
  },
  "actions": [
    {
      "type": "reply",
      "message": "...",
      "channel": "same"
    }
  ]
}
```

Required improvements:

- add more typed actions without weakening validation
- keep rejecting unknown action types
- preserve separation between state updates and external effects
- extend durable execution records into replay-safe recovery
- add replay-safe failure behavior

Next useful action types:

- richer `queue_task` payloads
- queue cancellation / rescheduling
- richer escalation payloads / policies

## good next places for the pattern “smart when it can, deterministic when it must”

- contradiction detection
  model proposes likely conflicts, exact invalidation rules confirm or reject
- escalation severity/routing
  model suggests channel/urgency, deterministic policy enforces floor/ceiling
- wake classification
  model can suggest hot/workload class, deterministic governor still owns final safety
- compaction promotion gating
  model judges whether a compaction is worth promoting, deterministic thresholds still protect durability

### 2. add a typed dispatcher in `agent-harness.ts`

The harness should:

- extend the existing typed dispatcher action-by-action
- record execution results in working memory
- build replay/resume behavior on top of the existing durable action journal
- stay fail-closed on malformed envelopes
- keep one shared turn-execution path across wake classes

### 3. expand internal job queues

Current queue support exists, but still needs:

- deferred follow-ups
- reminders
- escalations
- background summarization
- internal maintenance work
- queue inspection / repair tools
- richer reschedule policy than provider-hibernation fallback

### 4. add multi-source wake orchestration

Current wake sources:

- internal jobs
- agent-mail burst listen

Current wake policy:

- explicit source selection in `agent-harness`
- current priority order is urgent mail, urgent internal jobs, private mail, high internal jobs, public mail, normal internal jobs, low internal jobs
- internal job priority can raise queued work above public mail
- mail and jobs are peeked before the selected source is claimed
- blocking wait still falls back to mail listen when no source is currently ready
- wake reasons are written into `agent-state`
- cooldown windows still admit hot wakes while suppressing workload wakes

Need a unified wake model for:

- private mail
- public mentions
- urgent mail
- internal jobs
- alarms and reminders
- local subprocess completions / internal wake events

### 5. improve governor behavior

Current governor covers cooldown and provider rate limits only.

Need a stronger attention policy:

- refractory intervals
- urgent override rules
- interrupt policy
- burst suppression
- work conservation rules
- resume behavior after provider hibernation

### 6. strengthen durable state

Need explicit durable state for:

- current task ownership
- blocked state
- waiting state
- sleeping until
- last wake reason
- in-flight action execution

### 7. improve recovery

Need:

- crash-safe in-flight execution records
- replayable action journal
- stuck-turn detection
- resume semantics after interrupted work

## what is missing for fuller guppi-like

### documented but still worth hardening

- canonical JSONL/markdown durability is now broad enough to rebuild most hotpath state, but verify output still needs deeper row-level drift detail and repair flows

### not yet implemented or documented

- ~~**scratchpad (tier 1.5)**~~ — **DONE**. Per-agent persistent notepad at `runtime/scratchpads/<agent>.md`, injected every turn with P2 budget, agent-managed via `scratchpad` action type (append/replace/clear), configurable cap (default 6k) with 80% warning in prompt.
- ~~**deadman switch**~~ — **DONE**. `agent-harness` now enforces `FLEET_TURN_TIMEOUT_MS`, kills hung ACP turns, records failure, and alerts `operator`.
- ~~**replay/resume semantics**~~ — **DONE**. `agent-state replay-turn <agent> <turnKey>` reads checkpoint state, validates the turn hasn't already completed, and re-queues via job reschedule or mail claim release. Verify commands now include row-level content drift detail.
- **refractory scheduler** — volition groups wake sources into always-hot (Group A: streams, internal queue) and refractory (Group B: inbox, alarms) with random 10-30s cooldown per group. Fleet has governor-level cooldown but no per-source refractory groups.
- **dynamic channel subscriptions** — agents subscribe/unsubscribe to project-specific channels. Currently all agents see all layers.
- **focus protocol** — unsubscribe from noise channels during deep work with auto-resubscribe reminder after a deadline.
- ~~**scribe delegation**~~ — **DONE**. `spawn_scribe` action type in the harness, with scribe name → model routing (scribe/milo → E2B, homer/roamer/riker → E4B). Result returns via agent-mail private layer. `scribe` request type implemented on both fleet-e2b and fleet-e4b workers.
- **fleet protocol evolution** — agents propose and vote on protocol changes. Currently protocols are operator-authored only.

### already tracked as discrete items above

- multi-source wake loop with alarms and reminders (section 4)
- full governor and refractory model (section 5)
- recovery and replay semantics (section 7)
- richer action set and replay-safe dispatcher behavior (section 1-2)
- stronger task and run state (section 6)
- ~~better memory compression, promotion, and retrieval (section ideas)~~ — largely **DONE** (LLM extraction, HyDE, dual keywords, reranking, embedded link evidence)
- richer peer protocol types beyond channel integrity
- ~~deeper retrieval-aware cognition and turn assembly over the inference workers~~ — largely **DONE** (HyDE, dual keywords, reranking wired into lookup; LLM extraction wired into compaction)

## ideas from external projects

Patterns worth adopting from volition, mcp-ai-brain, mempalace, qmd, lean-ctx, context-mode, toon, and lightrag.

### ~~LLM-powered entity/relation extraction at ingest (from lightrag)~~ — DONE

`extract_entities` request type now exists on `fleet-e4b`. Returns typed (subject, predicate, object, description) tuples from raw memory content. Max 10 tuples per request. This replaces the regex heuristics in `facts.ts` with LLM-extracted triples at ingest time, matching LightRAG's architecture.

### ~~relation embeddings (from lightrag)~~ — DONE

Link graph edges now have their evidence text batch-embedded via `fleet-embed` and stored in `agent_memory_search_index` with `record_kind = 'link'`. This makes the link graph semantically searchable through the existing hybrid FTS5+vector retrieval path. Links are now discoverable directly through queries about "how things connect" — not just when a linked archival item is already retrieved.

### ~~dual keyword decomposition for retrieval routing (from lightrag)~~ — DONE

`decompose_keywords` request type now exists on `fleet-e2b`. Returns `{ high_level: [...], low_level: [...] }` keyword sets. `agent-memory` lookup now calls this to run separate HL (thematic, 0.6 weight) and LL (specific, 0.7 weight) FTS passes, fusing results alongside the primary query via RRF. Falls back to primary-only if the E2B worker is unavailable.

### entity description merging (from lightrag)

When the same entity appears across multiple compaction cycles, LightRAG recursively summarizes its descriptions via map-reduce. Fleet's compaction merges artifacts into archival lessons but does not track per-entity identity across compaction rounds. If the same subject appears in `agent_memory_facts` from different source items, the librarian could periodically merge their descriptions into a canonical entity record. Lower priority than extraction and embedding — current volume doesn't demand it — but becomes important as the fact store grows.

### ~~HyDE / query expansion (from qmd)~~ — DONE

`hyde` request type now exists on `fleet-e4b`. Generates a hypothetical answer document (under 200 words) for a given query. `agent-memory` lookup now calls HyDE before embedding — if available, the hypothesis is embedded instead of the literal query for vector search, improving semantic recall. Falls back to literal query embedding if the E4B worker is unavailable. The reranker filters false positives from the expanded recall set.

### raw-mode memory option (from mempalace)

All memory currently goes through summarization before storage. mempalace benchmarks show raw verbatim retrieval outperforms summarized (96.6% vs 84.2% R@5). A hybrid approach — keep raw fragments for recent tiers, compact only on promotion to archival — would hedge against lossy summarization without abandoning compaction for older memories. This is especially relevant for fact extraction: LLM-extracted entities from raw content will be higher quality than entities extracted from already-summarized text.

### proactive context loading (from mcp-ai-brain)

Agents currently get memory only at wake time in response to the inbound message. brain preloads relevant memories at session start based on workspace and task context. Fleet could do the same: when the harness knows the agent's `current_task` from state, pre-fetch related artifacts before the burst arrives so the turn prompt is richer without costing latency. This pairs with entity extraction — if the current task mentions specific entities, pre-fetch all facts and links involving those entities.

### self-repair and dynamic topology (from volition)

Fleet topology is static — three agents defined in `fleet.kdl`. Volition's Genesis bootstraps the first agent, and existing agents can spawn new ones. Fleet doesn't need full self-spawning yet, but the harness should be able to: detect repeated failures on a task, reassign work to a different agent, and request operator approval to add capacity. This is an extension of the existing escalation and job-reschedule paths.

### hierarchical context propagation (from qmd)

Memory artifacts are currently flat — each stands alone with its own content and embedding. qmd attaches context annotations at the collection level that propagate down to sub-documents, improving retrieval precision by letting the search engine know what a fragment belongs to. Fleet could attach project/task/subtask context to memory artifacts so that retrieval can filter or boost by ancestry, not just by content similarity. This is the structural counterpart to entity extraction — where extraction discovers relationships within content, hierarchical propagation discovers relationships between containers.

### graph-aware retrieval with token budgets (from lightrag)

LightRAG enforces separate token budgets for entity context, relation context, and chunk context during retrieval assembly. Fleet already has section budgets (P2/P3 caps) but they are applied after retrieval, not during. Moving budget awareness into the retrieval step — stopping entity/relation/chunk expansion once their respective budgets are exhausted — would reduce wasted retrieval work and give tighter control over prompt composition. The existing `budgetSection()` function could be pushed down into `agent-memory lookup` so the harness receives pre-budgeted results.

### soft-delete with GC (from qmd)

Fleet artifacts have a `status` field (active/decayed/compacted) but no garbage collection pass. qmd uses soft-delete with a background GC that physically removes tombstoned records after a retention window. The librarian's maintenance loop could add a GC phase that drops artifacts with `status = 'compacted'` older than a configurable retention period, and cleans up orphaned FTS5 entries and search index rows. This keeps the hotpath SQLite lean without losing durability — compacted content survives in canonical JSONL if the petiole pattern is wired.

## local scribes (cloud model offload)

Bobiverse-inspired local sub-agents that run against Gemma 4 instead of burning cloud ACP turns. Main agents (claude, gemini, codex) are orchestrators that delegate downward. Follows Volition's scribe pattern: fire-and-forget, result returns as a normal agent-mail message, no special infrastructure.

### scribe roster

| Name | Role | Model |
|---|---|---|
| scribe | Summarization, analysis, code review | E2B |
| milo | Testing, validation, smoke-checking | E2B |
| homer | Memory curation — compaction, entity extraction, fact verification | E4B |
| roamer | Exploration, research, information gathering | E4B |
| riker | Decision support — proposals, tradeoffs, options | E4B |

### how it works

1. Cloud agent emits `spawn_scribe` action with a task and scribe name
2. Harness connects to the appropriate model socket (`e2b.sock` or `e4b.sock`), sends a focused prompt (task + relevant context slice, not the full §TURN assembly)
3. Worker processes the request, returns a result
4. Harness posts the result to `agent-mail` as an internal message back to the spawning agent
5. Agent picks it up on next wake — indistinguishable from any other mail

No queue, no governor, no memory tiers, no wake loop. Born, work, report, die. The socket backlog is the only serialization point — if the worker is busy, the connection waits.

This matches Volition exactly: scribes are fire-and-forget subprocesses, results return through the normal inbox, the agent processes them on the next wake cycle.

### action type

```json
{ "type": "spawn_scribe", "name": "homer", "task": "..." }
```

The harness maps scribe name to model tier. Agents don't choose the model.

### what moves off cloud turns

- Summarization → scribe (E2B)
- Entity/relation extraction at ingest → homer (E4B)
- HyDE hypothetical answer generation → homer (E4B)
- Compaction → homer (E4B)
- Contradiction detection → homer (E4B)
- Research and information gathering → roamer (E4B)
- Decision option drafting → riker (E4B)
- Validation and smoke-checking → milo (E2B)

## inference architecture: one process per model

Inference was previously a single-process, single-threaded Unix socket server. ONNX inference is CPU-bound — even with async, the compute blocks the JS event loop. One slow Gemma generation starves fast embed requests. Adding E4B alongside E2B doubles the blocking surface. This is now resolved by the one-process-per-model split.

### fix: each model is its own process with its own socket

| Process | Model | Socket |
|---|---|---|
| fleet-embed | BGE-M3 (q8) | `runtime/embed.sock` |
| fleet-rerank | BGE reranker v2 (q4) | `runtime/rerank.sock` |
| fleet-e2b | Gemma 4 E2B (q4f16) | `runtime/e2b.sock` |
| fleet-e4b | Gemma 4 E4B (q4f16) | `runtime/e4b.sock` |

Each process: load one model, listen on one socket, same newline-JSON protocol. No dispatcher, no priority queue, no shared state. Callers connect directly to the model they need. Socket backlog handles implicit queuing.

Harness turn path (`embed.sock`, `rerank.sock`) is never blocked by slow generation work (`e2b.sock`, `e4b.sock`).

### estimated memory

~6.5 GB total (~1.5 BGE-M3, ~0.5 reranker, ~1.5 E2B, ~3 E4B). All lazy-loaded — E4B only warms on first use.

### implementation

1. Extract model loading into a shared module that takes model config and socket path
2. Each worker is a standalone binary built with `bun build --compile`
3. ~~Replace single Zellij pane with four panes (or a tab)~~ — DONE, now a dedicated `inference` tab
4. Callers use env vars: `FLEET_EMBED_SOCKET`, `FLEET_RERANK_SOCKET`, `FLEET_E2B_SOCKET`, `FLEET_E4B_SOCKET`
5. Add all four workers to `fleet build` and `fleet.kdl`

## inference expansion status

- ~~one-process-per-model split~~ — **DONE**. Four workers: `fleet-embed` (BGE-M3 q8), `fleet-rerank` (BGE reranker v2 q4), `fleet-e2b` (Gemma 4 E2B q4f16), `fleet-e4b` (Gemma 4 E4B q4f16). Each owns one model, one socket. No dispatcher.
- turn assembly now uses these workers for per-turn memory selection
- next useful work is durable retrieval indexes and better promotion/compaction policy beyond the current async artifact cache
- repair now exists for memory artifacts, but freshness policy is still simple and does not yet drive scheduled maintenance beyond queued upkeep jobs
- reinforcement and decay now use an Ebbinghaus-style curve baseline, but still need richer importance/promotion policy beyond the new librarian loop
- importance rebalance, structured archival compaction, typed local links, retrieval traces, linked-neighbor turn injection, explicit local/global/mix retrieval modes with model-assisted choice, basic link validity windows, timeline-aware turn context, first-step invalidation, first-pass temporal facts, contradiction-aware turn sections, queued maintenance wakes, and generic stale job-claim recovery now exist, but richer temporal graph semantics still do not
- LLM entity extraction at ingest (via fleet-e4b `extract_entities`) now replaces regex heuristics in compaction, with regex fallback. Librarian queues extraction jobs for compaction items missing facts.
- HyDE query expansion (via fleet-e4b `hyde`) now generates hypothetical answer docs for better vector recall, with literal query fallback.
- dual keyword decomposition (via fleet-e2b `decompose_keywords`) now runs separate HL/LL FTS passes fused with RRF, with primary-only fallback.
- embedded relation evidence now makes link graph edges semantically searchable via `agent_memory_search_index` with `record_kind='link'`.
- precision reranking via fleet-rerank now activates when >5 candidates exist in lookup.

## constraints

- no legacy compatibility paths
- no migration logic
- current schema only
- keep deterministic local fallback behavior
- preserve channel integrity: replies go back on the incoming layer

## restart notes

When resuming work:

1. Read `docs/ARCHITECTURE.md` (doctrine index)
2. Read `AGENTS.md`
3. Read `README.md`
4. Start with the action envelope and harness dispatcher
5. Avoid reintroducing short-name binaries or legacy DB handling
