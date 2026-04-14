# §CoreArchitecture

Modular, local-first runtime. SQLite-backed transport/state. Socket-based inference workers.

## §Roles
- **τBody(agent-harness)**: Owns exec loop, wake selection, context assembly, transport dispatch, recovery.
- **τThinker**: ACP-driven cloud agents. Profile: `light|full|max`.
- **τScribe**: Ephemeral Gemma 4 offload (E2B/E4B). Action: `spawn_scribe` → mail.
- **τMuscle**: Inference workers (`embed.sock`, `rerank.sock`, `e2b.sock`, `e4b.sock`).
- **τLibrarian**: Async upkeep (compaction, entity extraction).

## §Communication & Durability
SQLite-backed (hotpath) + JSONL (durable record).
- **Transport**: `agent-mail.db` + `state/mail/`
- **Jobs**: `agent-jobs.db` + `state/jobs/`
- **State**: `agent-state.db` + `state/runtime/`
- **Governance**: `fleet.db` + `state/fleet/`
- **Scratchpad**: `agent-state.db` (Table: `agent_scratchpads`) + `state/scratchpads/<agent>.jsonl`
- **Config**: `config.db` (Table: `fleet_configs`) + `config/fleet.toml` (canonical)

## §Orientation
- **→Target**: Inject §IDENTITY, §ORIENTATION, §SCRATCHPAD, §MEMORY, §TIMELINE on wake.
- **τSubscriptions**: Dynamic transport channel monitoring.
