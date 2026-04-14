# §CompletedWork

## §Governance
- **Refractory Scheduler**: Two-group (Hot/Refractory) wake throttling; 10-30s cooldowns.
- **Dynamic Subscriptions**: Agent awareness management via transport channel subscription.
- **Focus Protocol**: Auto-suspend noise channels during deep-work.
- **Multi-Scribe Compute**: Autonomous roster (roamer, riker, scribe, milo, homer).
- **Immutable Audit Log**: Append-only `state/audit.jsonl` for dispatch decisions.

## §Architecture & Memory
- **SQLite-backed Scratchpad**: Persistent agent-managed notepad in `agent-state.db`.
- **Config Durability**: Canonical `config/fleet.toml` + `config.db` projection.
- **Identity Injection**: Database-backed agent identity (vs static system prompt files).
- **Inference Workers**: Four-process split-brain model architecture.
- **Scribe Delegation**: `spawn_scribe` fire-and-forget logic.
- **Retrieval Enhancement**: HyDE expansion, dual-keyword decomposition, link-graph search.

## §Recovery
- **Replay/Resume**: Durable turn checkpoints + row-level verify drift detection.
- **Light→Full Re-run**: Complexity-mismatch detection & re-queue logic.

## §Historical Context
*(Archived from TODO.md current state, execution contracts, and feature history)*
- Previous implementation of ACP-mode-only agents.
- Initial transport via focused SQLite databases (mail, jobs, state, memory, governor, librarian).
- Split-brain model profile selection (light|full|max) per turn.
- Harness-owned turn loop, envelope validation, and action dispatch.
- Implementation of one-process-per-model for inference workers (embed, rerank, e2b, e4b).
- LLM entity extraction at ingest, dual-keyword decomposition, and HyDE query expansion.
