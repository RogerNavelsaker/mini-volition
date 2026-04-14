# Agent Operating Contract

Guidelines for LLM agents (Claude Code, Gemini CLI, etc.) performing development work within this repository.

## Identity

- **Project**: mini-volition
- **Language**: TypeScript (Bun runtime)
- **Build**: `bun run scripts/build.ts`
- **Test**: `bun test` (colocated `*.test.ts` files)

## Hard Rules

- Never modify SQLite databases directly. Use the owning service entrypoint (`agent-mail`, `agent-jobs`, `agent-state`, `agent-memory`, `fleet`).
- Never modify files under `state/` directly. These are append-first canonical records written by service code.
- Never introduce schema migrations or legacy compatibility shims. Update the current schema and rebuild from clean DB.
- Never reintroduce removed binaries (`am`, `harness`, `operator`, `reply`, `fleet-inference`, short-name aliases).
- Never inject content from `references/` into system prompts. References are read-only upstream notes.
- Never add implicit path aliases. All imports must be strict relative (`./`, `../`).
- All action envelopes must fail closed on malformed input. Unknown action types are rejected, not silently ignored.
- Keep ownership lines explicit: transport (`agent-mail`), state (`agent-state`), jobs (`agent-jobs`), memory (`agent-memory`), governance (`fleet`), upkeep (`fleet-librarian`).

## Workflow

1. Read `docs/ARCHITECTURE.md` for component overview before touching unfamiliar modules.
2. Read the relevant `src/<module>/main.ts` before proposing changes.
3. Make surgical, atomic edits. One logical change per commit.
4. Run `bun run scripts/build.ts` after source changes to verify compilation.
5. Prefix commits with type: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`.
6. Update the relevant `docs/` file when behavior changes materially.

## Architecture Boundaries

- `agent-*` commands own per-agent domain state. `fleet*` commands own shared coordination.
- Per-agent recovery/review flows belong under `agent-state`, not `fleet`.
- `fleet-librarian` schedules upkeep over `agent-memory` state. It is not a separate memory store.
- `fleet-librarian` queues maintenance through `agent-jobs`. `agent-harness` executes those jobs.
- Inference workers (`fleet-embed`, `fleet-rerank`, `fleet-light`, `fleet-heavy`) are stateless socket servers. Callers connect directly.
- Provider workers (`fleet-claude`, `fleet-gemini`, `fleet-openai`, `fleet-openrouter`) manage per-provider rate limits and retry logic.
- `operator-harness` is the human operator surface. Escalation routes through `agent-mail` to recipient `operator`.

## Code Style

- Entrypoints at `src/<module>/main.ts`. Helpers in the same directory.
- kebab-case filenames. PascalCase types. camelCase functions.
- No unused abstractions. No speculative generalization.
- Prefer deterministic fallbacks: local model first, weaker fallback second, deterministic last-resort.
- Compact JSON for agent I/O. No unnecessary whitespace in wire formats.

## Documentation

- `docs/*.md` and `prompts/*.md` are the source material for system prompts. Treat as authoritative.
- `references/*.md` are upstream behavior notes. Read-only, never committed to prompts.
- `TODO.md` is the active development roadmap. `DONE.md` is the historical archive.
- If `AGENTS.md` conflicts with `README.md`, this file wins for agent behavior.

## Communication Protocol

- When uncertain, state assumptions explicitly before acting.
- When a task is ambiguous, pick the most conservative interpretation.
- When blocked, report what is blocking and stop. Do not guess.
