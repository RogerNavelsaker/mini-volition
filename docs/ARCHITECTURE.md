# §Architecture
Fleet architecture: hotpath (SQLite) + durable (JSONL/TOML).

## §Components
- **τHarness**: Execution loop, wake selection, context assembly, recovery.
- **τThinker**: ACP cloud agents (Gemini/Claude/OpenAI).
- **τScribe**: Gemma 4 offload (E2B/E4B).
- **τMuscle**: Inference workers.
- **τLibrarian**: Async upkeep (compaction, entity extraction).

## §Durability
- **Transport**: `agent-mail.db` + `state/mail/`
- **Jobs**: `agent-jobs.db` + `state/jobs/`
- **State**: `agent-state.db` + `state/runtime/`
- **Governance**: `fleet.db` + `state/fleet/`
- **Scratchpad**: `agent-state.db` (Table: `agent_scratchpads`) + `state/scratchpads/<agent>.jsonl`
- **Config**: `config.db` (Table: `fleet_configs`) + `config/fleet.toml` (canonical)
