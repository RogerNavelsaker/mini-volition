# genesis

This document describes how mini-volition should be initialized as a coherent local agent system.

## purpose

Genesis is the point where the fleet defines:

- its identity
- its operating doctrine
- its roles
- its transport rules
- its memory model
- its prompt source material

Genesis is not a one-line bootstrap script. It is the authored doctrine that runtime config and prompts should be generated from.

## genesis outputs

A successful genesis pass should produce or update:

- `config/fleet.kdl`
- `docs/ARCHITECTURE.md`
- `docs/1-philosophy.md` through `7-governance.md`
- `docs/fleet-protocols.md`
- `docs/genesis.md`
- `prompts/base-system.md`
- `prompts/claude-system.md`
- `prompts/gemini-system.md`
- `prompts/codex-system.md`

## current fleet identity

- local-first
- ACP-only for cloud agents
- SQLite-backed transport
- shared local inference service over Unix socket
- harness-owned reply dispatch
- current-state only, no legacy compatibility

## genesis rule

When doctrine changes materially, update docs first, then prompt sources, then runtime code.
