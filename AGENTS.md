# Agent Development Guide

Operating guide for building and maintaining the Mini-Volition runtime.

## Scope
This guide documents the architecture, communication patterns, and development standards for the Mini-Volition codebase.

## Identity & Prompting
- Agent definitions are stored in `fleet_agent_identity`.
- System prompts are dynamically assembled at runtime: Constitution (canonical docs in `docs/`) + identity record (DB).

## Behavioral Rules
- **Envelope Protocol**: Agents must output valid JSON envelopes. The system fails closed on invalidation.
- **Scribe Delegation**: Use the `spawn_scribe` action for fire-and-forget sub-task execution.
- **Scratchpad**: Persistent agent state is stored in `runtime/scratchpads/`.
- **Recovery**: Replay-safe actions (noop, note) resume automatically; side-effects require manual resolution via `agent-state resolve-turn`.

## Documentation Handling
- **Canonical**: `docs/*.md` is the source of truth for the system architecture.
- **References**: `references/` is for context, never inject into prompts.

## Development Surface
- **Entrypoint**: `bin/fleet`
- **State**: `runtime/*.db` (hotpath) + `state/*.jsonl` (durable).
- **Inference**: Socket-bound workers (`embed.sock`, etc.).
