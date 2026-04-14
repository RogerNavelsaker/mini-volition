# core architecture

## component model

Fleet has 13 components. Each is a standalone Bun-compiled binary in `bin/`.

### agent-harness (the body)

The equivalent of volition's GUPPI. One instance per agent. Owns:

- wake source selection (mail vs internal jobs, priority-ordered)
- split-brain model/effort selection per turn via ACP
- turn context assembly (memory retrieval, sleep delta, burst summary)
- ACP session lifecycle (initialize, session/new, message/send, session/stop)
- action envelope parsing and validation
- action dispatch (reply, noop, note, sleep_until, queue_task, escalate, scratchpad, spawn_scribe)
- per-agent scratchpad management (tier 1.5 persistent notepad with cap notification)
- durable action journaling through agent-state
- provider rate-limit detection and hibernation
- governor integration (turn counting, cooldown enforcement)
- async memory reinforcement of recalled artifacts

#### split-brain model

Volition uses two separate models (flash for social/cheap, pro for executive/deliberate). Fleet achieves the same through ACP, which allows the harness to change model and effort/reasoning level per session:

- **light mode** — lower effort/reasoning, cheaper model tier. Used for: public channel social replies, status checks, noop-likely wakes, low-priority internal jobs.
- **full mode** — full effort/reasoning, top model tier. Used for: private task work, urgent mail, high/urgent internal jobs, escalation-triggering turns, and heavier turns that do not fit `light`.

The harness selects mode based on wake class, message layer, job priority, and turn history, using local-model assistance when available and deterministic fallback otherwise.

**Re-run policy:** if a `light` turn completes with an `escalate` action, high/urgent `queue_task`, or `sleep_until`, the harness detects this as a complexity mismatch and re-queues the wake as a high-priority internal job forced to `full` profile. The light turn's actions still execute (they're already dispatched), but the re-run gives the agent a second pass with full reasoning.

This is a harness-side decision — agents do not choose their own model or effort level.

### agent-mail (the nervous system)

SQLite message bus. All inter-agent and operator communication flows through it.

Transport layers:

- `private` — direct 1:1 coordination
- `public` — shared status, passive awareness (Town Square)
- `urgent` — interrupt-priority messages

Features:

- burst coalescing (same sender, same layer, within time window)
- per-agent read tracking (direct messages mark read_at; broadcast messages track read_by)
- blocking listen and non-blocking peek/claim
- raw SQL pass-through for services that need direct queries

### agent-state (runtime state)

Per-agent state table plus action journal. Records:

- current status (idle, thinking, cooldown, sleeping, hibernating)
- current task, wake reason, last error
- cooldown deadline, last message ID
- per-action execution phases (queued, executing, completed, failed)

### agent-jobs (internal queue)

Per-agent deferred work queue with priority levels (urgent, high, normal, low). Supports:

- queue, peek, claim, complete, fail, reschedule
- priority-ordered retrieval
- available_at scheduling for deferred execution
- reschedule on provider hibernation instead of marking failed

### agent-memory (memory engine)

Per-agent memory indexing, embedding, retrieval, and decay. Owns:

- artifact promotion from tier 1/2/3 source tables
- embedding via fleet-embed
- LLM entity extraction at ingest via fleet-e4b `extract_entities` (replaces regex heuristics, falls back to regex)
- hybrid retrieval (FTS5 keyword + vector search, fused with RRF)
- HyDE query expansion via fleet-e4b `hyde` (hypothetical answer doc for better vector recall, falls back to literal)
- dual keyword decomposition via fleet-e2b `decompose_keywords` (HL/LL FTS passes fused with primary, falls back to primary only)
- precision reranking via fleet-rerank for top candidates when >5 exist
- embedded relation evidence in search index (links are semantically searchable alongside artifacts)
- Ebbinghaus-style decay with grace period and floor
- strength reinforcement on recall
- archival link graph with recall-time boost
- refresh freshness tracking

### inference workers (local models)

Four dedicated ONNX inference workers, each owning one model and one Unix socket. All CPU, no GPU required. Lazy-load on first request.

| Worker | Model | Socket | Serves |
|---|---|---|---|
| fleet-embed | BGE-M3 (q8) | `runtime/embed.sock` | `embed` |
| fleet-rerank | BGE reranker v2 (q4) | `runtime/rerank.sock` | `rerank` |
| fleet-e2b | Gemma 4 E2B (q4f16) | `runtime/e2b.sock` | `summarize`, `choose_retrieval_mode`, `choose_turn_profile`, `decompose_keywords`, `scribe` |
| fleet-e4b | Gemma 4 E4B (q4f16) | `runtime/e4b.sock` | `compact`, `extract_entities`, `hyde`, `scribe` |

Callers connect directly to the model they need. Socket backlog handles implicit queuing — no dispatcher, no shared state. Harness turn path (embed, rerank) is never blocked by slow generation work (e2b, e4b).

### fleet-digest (social awareness)

Background worker that monitors the public layer, batches conversation bursts, sends them through fleet-e2b for summarization, and stores episodic digests. These digests are injected into agent turn context as social catch-up.

### fleet-librarian (memory upkeep)

Background worker that schedules maintenance over per-agent memory:

- periodic refresh of memory artifacts
- decay scoring for unused artifacts
- importance rebalancing based on recall/strength signals
- compaction of reinforced episodic/digest artifacts into structured archival lessons
- error streak tracking and repair

### fleet (orchestrator)

Session manager and governor. Handles:

- Zellij session lifecycle (`fleet start/stop/attach/up/down/restart`)
- governor rate-limiting (windowed turn counts, forced cooldowns)
- status reporting

### operator-harness (human surface)

Interactive REPL for the operator. Sends messages through agent-mail using `<recipient>: <message>` syntax. Displays incoming replies inline. Participates in the fleet as the `operator` identity.

## communication model

All communication flows through `agent-mail` and `agent-mail.db`.

```
operator-harness ──┐
                   │
claude-harness ────┤
                   ├── agent-mail (agent-mail.db) ──┬── fleet-digest
gemini-harness ────┤                           │
                   │                           └── Town Square (tail)
codex-harness ─────┘
```

Direct messages: sender writes to recipient on a layer. Recipient's harness claims the message on next wake.

Broadcasts: sender writes to `all` on `public`. Each agent tracks its own read state via `read_by`.

Escalation: agent emits an `escalate` action. Harness sends to `operator` on `private` or `urgent`.

## ownership lines

| concern | owner |
|---|---|
| transport | agent-mail |
| per-agent state | agent-state |
| per-agent deferred work | agent-jobs |
| per-agent memory | agent-memory |
| memory upkeep scheduling | fleet-librarian |
| embeddings | fleet-embed |
| reranking | fleet-rerank |
| summarization / retrieval mode | fleet-e2b |
| compaction | fleet-e4b |
| public digest generation | fleet-digest |
| turn execution, prompt, dispatch | agent-harness |
| session lifecycle, governor | fleet |
| human interaction | operator-harness |
