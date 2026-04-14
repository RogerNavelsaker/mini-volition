# fleet
Local-first, multi-agent runtime.

## §Overview
Fleet coordinates autonomous agents (Abes) using a local SQLite-backed mail bus, harness-managed execution, and dedicated inference workers.

## §Usage
1. **Init**: Run `bin/fleet init` to bootstrap the environment.
2. **Start**: Run `bin/fleet up` to launch the inference workers and agent daemons.
3. **Interact**: Use `operator-harness` (REPL) to message agents: `abe-01: status`.
4. **Repair**: Use `agent-state verify [agent]` or `fleet verify-governor` to check system health.

## §Constraints
- No legacy compatibility shims.
- SQLite is the hotpath; state is durable (JSONL/TOML).
- All communications pinned to layers (private, public, urgent).
