# schemas

## General Protocol Schemas

### AgentHarnessEvent

Standardized event schema for all wake sources (Mail, Internal Jobs, System Events).

```json
{
  "id": "evt-001",
  "type": "AgentHarnessEvent",
  "agent": "abe-03",
  "timestamp_event": "2026-01-02T09:59:59Z",
  "event_type": "NewInboxMessage | SocialDigest | TaskCompleted",
  "source": "inbox:agent | volition:social_digests | AgentHarness",
  "content": "...",
  "action_id": "optional-uuid"
}
```

## action envelope

The structured contract between agents and the harness.

```json
{
  "schema_version": 1,
  "summary": "short internal summary",
  "state": {
    "current_task": "optional current task description"
  },
  "actions": [
    { "type": "reply", "message": "...", "channel": "same" },
    { "type": "noop" },
    { "type": "note", "message": "..." },
    { "type": "sleep_until", "until": "2026-04-12T10:00:00Z" },
    { "type": "queue_task", "task": "...", "target_agent": "gemini", "priority": "high", "run_at": "2026-04-12T12:00:00Z" },
    { "type": "escalate", "message": "...", "channel": "urgent" },
    { "type": "scratchpad", "op": "append", "content": "new note here" },
    { "type": "scratchpad", "op": "replace", "content": "full replacement" },
    { "type": "scratchpad", "op": "clear" },
    { "type": "spawn_scribe", "name": "homer", "task": "extract entities from recent compaction output" }
  ]
}
```

Validation rules:

- `schema_version` — optional number
- `summary` — optional string
- `state` — optional object; only `current_task` (string) recognized
- `actions` — required array; each must match a known type exactly
- `scratchpad` — requires `op` (one of: append, replace, clear); `content` required for append/replace, ignored for clear
- `spawn_scribe` — requires `name` (one of: scribe, milo, homer, roamer, riker) and `task` (non-empty string); harness maps name to model tier and posts result back via agent-mail private layer
- unknown keys, unknown action types, or malformed values reject the entire envelope
- no actions execute if any action is invalid (fail-closed)

## SQLite tables

The runtime is now split across focused SQLite files:

- these files currently live under `runtime/`
- `runtime/agent-mail.db` — transport and mail claims
- `runtime/agent-jobs.db` — internal deferred work
- `runtime/agent-memory.db` — working / episodic / archival memory and retrieval artifacts
- `runtime/agent-state.db` — runtime state, action journal, turn journal
- `runtime/fleet.db` — governor/orchestration state
- `runtime/fleet-librarian.db` — maintenance journal

Authoritative durable rebuild packets now live under `state/`:

- `turns/<agent>.jsonl` — turn phases and checkpoints
- `actions/<agent>.jsonl` — action execution phases and replay policy
- `runtime/<agent>.jsonl` — runtime state transitions
- `jobs/<agent>.jsonl` — job lifecycle transitions
- `mail/<agent>.jsonl` — message send and claim lifecycle transitions
- `memory-source/working/<agent>.jsonl` — tier1 working-memory source rows
- `memory-source/episodic/<agent>.jsonl` — tier2 episodic source rows
- `memory-source/archival/<agent>.jsonl` — tier3 archival source rows
- `memory-source/digests/public.jsonl` — public digest source rows
- `memory/<agent>.jsonl` — derived memory snapshots for `agent_memory_*` state
- `fleet/governor.jsonl` — fleet-wide governor events
- `reviews/<agent>.md` — manual review and resolution notes

Current rebuild commands:

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

### fleet_comms

Message bus.

| column | type | notes |
|---|---|---|
| id | INTEGER PK | auto-increment |
| layer | TEXT | private, public, urgent |
| recipient | TEXT | agent name or "all" |
| sender | TEXT | agent name or "operator" |
| body | TEXT | message content |
| read_at | DATETIME | set when direct message is read |
| read_by | TEXT | pipe-delimited agent names for broadcasts |
| created_at | DATETIME | default CURRENT_TIMESTAMP |

### tier1_working

Per-agent working memory.

| column | type |
|---|---|
| id | INTEGER PK |
| agent_name | TEXT |
| role | TEXT |
| content | TEXT |
| timestamp | DATETIME |

### tier2_episodic

Per-agent episodic summaries.

| column | type |
|---|---|
| id | INTEGER PK |
| agent_name | TEXT |
| summary | TEXT |
| duration_asleep | INTEGER |
| actors | TEXT |
| timestamp | DATETIME |

### tier3_archival

Per-agent archival reflections.

| column | type |
|---|---|
| id | INTEGER PK |
| agent_name | TEXT |
| task_id | TEXT |
| result | TEXT |
| reflection | TEXT |
| timestamp | DATETIME |

### public_digests

Shared digest summaries.

| column | type |
|---|---|
| id | INTEGER PK |
| summary | TEXT |
| actors | TEXT |
| type | TEXT |
| timestamp | DATETIME |

### fleet_agent_state

Per-agent runtime state.

| column | type |
|---|---|
| agent_name | TEXT PK |
| status | TEXT |
| current_task | TEXT |
| wake_reason | TEXT |
| last_error | TEXT |
| cooldown_until | DATETIME |
| last_message_id | INTEGER |
| updated_at | DATETIME |

### fleet_agent_action_journal

Durable action execution log.

| column | type |
|---|---|
| id | INTEGER PK |
| agent_name | TEXT |
| message_id | INTEGER |
| action_index | INTEGER |
| action_type | TEXT |
| phase | TEXT |
| detail | TEXT |
| replay_disposition | TEXT |
| replay_reason | TEXT |
| created_at | DATETIME |

Execution phases currently used:

- `planned`
- `started`
- `completed`
- `failed`

Replay policy is now stored per action row instead of inferred only from action type at recovery time.

Recovery policy uses `action_type` plus these phases to determine whether an interrupted turn is safe to auto-replay.

### fleet_turn_journal

Durable turn execution log.

| column | type |
|---|---|
| id | INTEGER PK |
| agent_name | TEXT |
| turn_key | TEXT |
| wake_source | TEXT |
| wake_reason | TEXT |
| message_id | INTEGER |
| phase | TEXT |
| detail | TEXT |
| created_at | DATETIME |

Turn phases currently used:

- `started`
- `completed`
- `failed`
- `rate_limited`
- `interrupted_recovered`
- `interrupted_manual_review`

### fleet_turn_checkpoints

Durable per-turn checkpoint state.

| column | type |
|---|---|
| id | INTEGER PK |
| agent_name | TEXT |
| turn_key | TEXT |
| wake_source | TEXT |
| wake_reason | TEXT |
| wake_class | TEXT |
| wake_priority | INTEGER |
| message_id | INTEGER |
| sender | TEXT |
| layer | TEXT |
| burst_count | INTEGER |
| prompt_hash | TEXT |
| prompt_chars | INTEGER |
| envelope_status | TEXT |
| envelope_summary | TEXT |
| created_at | DATETIME |
| updated_at | DATETIME |

Recovery uses checkpoint state during replay classification. Current auto-replay-ready checkpoint statuses are:

- `prompt_built`
- `validated`
- `completed`
- `rate_limited`

### fleet_governor

Per-agent rate-limiting state.

| column | type |
|---|---|
| agent_name | TEXT PK |
| window_started_at | DATETIME |
| turn_count | INTEGER |
| forced_cooldown_until | DATETIME |
| last_reason | TEXT |
| updated_at | DATETIME |

### fleet_internal_jobs

Per-agent deferred work queue.

| column | type |
|---|---|
| id | INTEGER PK |
| target_agent | TEXT |
| sender | TEXT |
| body | TEXT |
| priority | TEXT |
| available_at | DATETIME |
| status | TEXT |
| claimed_at | DATETIME |
| claimed_by | TEXT |
| completed_at | DATETIME |
| last_error | TEXT |
| created_at | DATETIME |
| updated_at | DATETIME |

### agent_memory_artifacts

Per-agent indexed memory.

| column | type |
|---|---|
| id | INTEGER PK |
| agent_name | TEXT |
| source_kind | TEXT |
| source_table | TEXT |
| source_id | INTEGER |
| content | TEXT |
| content_hash | TEXT |
| embedding_json | TEXT |
| embedding_model | TEXT |
| importance | TEXT |
| strength | REAL |
| recall_count | INTEGER |
| last_recalled_at | DATETIME |
| decay_score | REAL |
| status | TEXT |
| created_at | DATETIME |
| updated_at | DATETIME |

### agent_memory_refresh_state

Per-agent memory freshness tracking.

| column | type |
|---|---|
| agent_name | TEXT PK |
| last_refresh_at | DATETIME |
| last_status | TEXT |
| last_error | TEXT |
| artifact_count | INTEGER |
| source | TEXT |
| error_streak | INTEGER |
| updated_at | DATETIME |

## inference protocol

Four dedicated workers, each on its own Unix socket. Protocol: newline-delimited JSON request/response over Unix socket.

| Worker | Socket | Env var |
|---|---|---|
| fleet-embed | `runtime/embed.sock` | `FLEET_EMBED_SOCKET` |
| fleet-rerank | `runtime/rerank.sock` | `FLEET_RERANK_SOCKET` |
| fleet-e2b | `runtime/e2b.sock` | `FLEET_E2B_SOCKET` |
| fleet-e4b | `runtime/e4b.sock` | `FLEET_E4B_SOCKET` |

### summarize (fleet-e2b)

```json
{"type": "summarize", "messages": [{"id": 1, "layer": "public", "recipient": "all", "sender": "claude", "body": "...", "created_at": "..."}]}
```

Response: `{"summary": "...", "decisions": ["..."], "source": "model-id"}`

### embed (fleet-embed)

```json
{"type": "embed", "texts": ["text1", "text2"], "normalize": true, "pooling": "mean"}
```

Response: `{"embeddings": [[...], [...]], "dims": 1024, "normalized": true, "pooling": "mean", "source": "model-id"}`

### rerank (fleet-rerank)

```json
{"type": "rerank", "query": "...", "passages": ["..."], "normalize": true, "top_k": 5}
```

Response: `{"results": [{"index": 0, "text": "...", "score": 0.95}], "normalized": true, "source": "model-id"}`

### compact (fleet-e4b)

```json
{"type": "compact", "entries": ["fragment 1", "fragment 2"], "goal": "optional compaction goal"}
```

Response: `{"summary": "...", "lessons": ["..."], "facts": ["..."], "decisions": ["..."], "patterns": ["..."], "open_risks": ["..."], "source": "model-id"}`

### choose_retrieval_mode (fleet-e2b)

```json
{"type": "choose_retrieval_mode", "source": "mail_burst", "layer": "private", "text": "turn text..."}
```

Response: `{"mode": "local|global|mix", "reason": "...", "source": "model-id"}`

### choose_turn_profile (fleet-e2b)

```json
{"type": "choose_turn_profile", "source": "mail_burst", "layer": "private", "text": "turn text..."}
```

Response: `{"profile": "light|full|max", "reason": "...", "source": "model-id"}`

### extract_entities (fleet-e4b)

```json
{"type": "extract_entities", "text": "raw memory content..."}
```

Response: `{"entities": [{"subject": "...", "predicate": "...", "object": "...", "description": "..."}], "source": "model-id"}`

Now wired into `agent-memory` compaction: entities are extracted via LLM at ingest time instead of regex heuristics. Falls back to regex `deriveFacts()` if the E4B worker is unavailable.

### hyde (fleet-e4b)

```json
{"type": "hyde", "query": "search query text..."}
```

Response: `{"hypothesis": "hypothetical answer document...", "source": "model-id"}`

Generates a hypothetical answer document for query expansion. The hypothesis is embedded instead of the literal query for vector search, improving semantic recall. Falls back to literal query embedding if unavailable.

### decompose_keywords (fleet-e2b)

```json
{"type": "decompose_keywords", "text": "turn text or query..."}
```

Response: `{"high_level": ["thematic keyword", ...], "low_level": ["specific entity", ...], "source": "model-id"}`

Decomposes a query into high-level (thematic, conceptual) and low-level (specific, entity-level) keywords for dual retrieval. HL keywords run separate FTS passes for global context, LL keywords run FTS passes for local precision. Results are fused with RRF alongside the primary query.

### scribe (fleet-e2b or fleet-e4b)

```json
{"type": "scribe", "name": "homer", "task": "summarize the last 3 compaction cycles"}
```

Response: `{"result": "...", "source": "model-id"}`

Scribe name determines which worker handles the request: `scribe`/`milo` → fleet-e2b, `homer`/`roamer`/`riker` → fleet-e4b.
