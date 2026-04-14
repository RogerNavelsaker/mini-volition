# fleet architecture

Index of the current fleet documentation set.

## root docs

- [README.md](../README.md) — project overview, command surface, current model
- [TODO.md](../TODO.md) — continuation point, next work, open gaps
- [AGENTS.md](../AGENTS.md) — agent operating guide, behavioral rules, editing guidance

## doctrine (docs/)

| doc | covers |
|---|---|
| [1-philosophy.md](1-philosophy.md) | project goals, design principles, relationship to volition |
| [2-core-architecture.md](2-core-architecture.md) | component roles, comms model, ownership lines |
| [3-turn-loop.md](3-turn-loop.md) | harness wake/think/execute cycle, ACP protocol, governor |
| [4-memory.md](4-memory.md) | memory tiers, retrieval, decay, compaction, librarian |
| [5-topology.md](5-topology.md) | agent roster, spawning, dynamic layout, inheritance |
| [6-schemas.md](6-schemas.md) | action envelope, SQLite tables, inference protocol |
| [7-governance.md](7-governance.md) | operator surface, governor, escalation, fleet protocols |
| [genesis.md](genesis.md) | fleet initialization doctrine |

## prompt sources

- [prompts/base-system.md](../prompts/base-system.md) — shared fleet rules
- [prompts/claude-system.md](../prompts/claude-system.md) — claude role overlay
- [prompts/gemini-system.md](../prompts/gemini-system.md) — gemini role overlay
- [prompts/codex-system.md](../prompts/codex-system.md) — codex role overlay

## references

- [references/volition-readme-notes.md](../references/volition-readme-notes.md)
- [references/volition-guppi-loop-notes.md](../references/volition-guppi-loop-notes.md)
- [references/volition-fleet-protocols-notes.md](../references/volition-fleet-protocols-notes.md)
