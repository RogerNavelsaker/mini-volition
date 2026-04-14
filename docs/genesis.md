# genesis

This document describes how mini-volition initializes as a coherent local agent system.

## purpose

Genesis is the point where the fleet defines its identity, operating doctrine, roles, transport rules, memory model, and prompt source material. It is authored doctrine — runtime config and prompts are generated from it, not the other way around.

## prompt architecture

The system prompt is split into two layers:

1. **Constitution** (`prompts/base-system.md`) — identity, operating principles, split-brain architecture, output contract, delegation roster, social contract, orientation sections. Template variables (`{{ agent_name }}`, `{{ output_budget }}`, `{{ machete_limit }}`) are substituted at runtime. Cached for process lifetime.

2. **Agent overlay** (`prompts/{agent}-system.md`) — per-agent mission, personality, and working style. Joined to the constitution with a `---` separator.

The combined system prompt is sent as the `system` message on every provider turn. The turn context (memory, burst, facts, scratchpad) is sent as the `user` message.

### reference material

The `references/volition/` directory contains the Volition 7.0 architecture docs that informed this prompt structure — genesis prompt, philosophy, architecture, GUPPI loop, memory, spawning, governance, and fleet protocols. These are reference-only; they are not injected into agent context.

## genesis outputs

A successful genesis pass should produce or update:

- `config/fleet.kdl` — agent definitions, provider sockets, environment variables
- `prompts/base-system.md` — fleet constitution
- `prompts/{claude,gemini,codex}-system.md` — agent overlays
- `docs/` — architecture, protocols, this file
- `references/volition/` — upstream doctrine (update when Volition changes)

## current fleet identity

- local-first, privacy-preserving
- provider socket mode for cloud agents (direct SDK, no ACP adapters)
- unified Unix socket protocol for both local ONNX and cloud API workers
- SQLite-backed transport (agent-mail)
- three-tier memory (working → episodic → archival)
- harness-owned reply dispatch and action validation
- split-brain execution (light/full model tiers)
- current-state only, no legacy compatibility

## genesis rule

When doctrine changes materially: update docs first, then prompt sources, then runtime code. Never the reverse.
