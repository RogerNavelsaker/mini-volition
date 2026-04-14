# fleet protocols

This document defines the operational protocols for the local fleet.

## 1. channel integrity

Replies go back on the same transport layer that carried the incoming message.

- `private` stays `private`
- `public` stays `public`
- `urgent` stays `urgent`

Agents do not construct transport commands for normal replies. The harness owns dispatch.

## 2. action-envelope protocol

Agents return a structured action envelope rather than free-form transport instructions.

Current envelope contract:

- `schema_version: 1`
- `actions[]`
- validated before any effects execute
- state updates are evaluated before external effects
- invalid envelopes fail closed

Current supported action types:

- `reply`
- `noop`
- `note`
- `sleep_until`
- `queue_task`
- `escalate`
- `scratchpad`

Dispatcher behavior:

- state updates are applied before action effects
- each action is journaled durably with execution phases
- `sleep_until` updates runtime state and pauses the harness until the requested time
- interrupted-turn replay is action-aware; turns with started/completed side-effecting actions are held for manual review

Target direction:

- add more typed actions without weakening validation
- keep channel integrity for reply dispatch
- preserve fail-closed behavior

## 3. ownership protocol

- `agent-mail` owns transport in `agent-mail.db`
- `agent-jobs` owns deferred work in `agent-jobs.db`
- `agent-memory` owns memory tiers and retrieval artifacts in `agent-memory.db`
- `agent-state` owns per-agent runtime state, action journal, and turn journal in `agent-state.db`
- `fleet` owns fleet-level orchestration and governor logic in `fleet.db`
- `fleet-librarian` owns maintenance journaling in `fleet-librarian.db`
- `agent-harness` owns prompt assembly, envelope parsing, and normal reply dispatch
- `fleet-embed`, `fleet-rerank`, `fleet-e2b`, `fleet-e4b` own local model serving (one process per model)
- runtime state files live under `runtime/`

## 4. compatibility protocol

The fleet is current-state only.

Do not add:

- legacy binary aliases
- DB fallback names
- schema migration shims
- compatibility paths for removed behavior

## 5. build-root protocol

- executables live in `bin/`
- build support artifacts live in `build/`
- runtime config lives in `config/`
- doctrine lives in `docs/`
- prompt source files live in `prompts/`

## 6. context efficiency protocol

The fleet enforces token efficiency at multiple layers:

- **output machete** — hard char limit on agent response (default 20k), truncates with marker
- **output budget directive** — prompt tells agents their response budget (default 8k), advisory
- **section budgets** — each memory tier has an independent char budget (P1 uncapped, P2/P3 capped)
- **token-dense prompt** — TDD-inspired shorthand (§ section markers, ∂ delta, τ type notation)
- **compact JSON** — agents return compact JSON envelopes, no prose outside the envelope

Format conventions:

- agent I/O: compact JSON
- operator display: TOON-style tabular rendering
- durable storage: JSONL for structured records, markdown for doctrine
- SQLite: hotpath acceleration layer and hot-path buffer only (rebuildable from canonical files)

## 7. storage protocol

SQLite is the acceleration layer, not the source of truth.

- canonical records are authoritative (JSONL, markdown)
- current durable artifact root is `state/`
- current rebuild packets include:
  - `turns/<agent>.jsonl`
  - `actions/<agent>.jsonl`
  - `runtime/<agent>.jsonl`
  - `jobs/<agent>.jsonl`
  - `mail/<agent>.jsonl`
  - `memory-source/working/<agent>.jsonl`
  - `memory-source/episodic/<agent>.jsonl`
  - `memory-source/archival/<agent>.jsonl`
  - `memory-source/digests/public.jsonl`
  - `memory/<agent>.jsonl`
  - `fleet/governor.jsonl`
  - `reviews/<agent>.md`
- rebuild commands stay with the owning domain:
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
- verify commands should report drift categories and the exact owner-local rebuild command for repair
- SQLite projections are derived and rebuildable
- hot-path SQLite projection may be flushed in grouped transactions instead of per-row commits
- all SQLite databases use WAL mode, busy_timeout, synchronous=NORMAL
- FTS5 indexes are trigger-synced or refresh-synced, never the only copy
- content-addressable storage where feasible (hash-keyed deduplication)
