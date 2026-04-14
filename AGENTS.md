# §AgentDevGuide
Guidelines for LLM agents (Claude Code, Gemini CLI, etc.) performing development work within this repository.

## §Scope
This guide provides mandatory behavioral constraints and architectural patterns for agents modifying this codebase. 

## §Development Protocol
1. **Constitution-First**: All system logic must adhere to the TDD-formatted specifications in `docs/`.
2. **Atomic Edits**: Use surgical edits (e.g., `replace` tool) to modify the codebase.
3. **State Integrity**: Never modify SQLite hot-path data directly. Use provided service entrypoints (`agent-mail`, `agent-jobs`, etc.) and append-first `state/` records.
4. **No Bloat**: Avoid shims, legacy compatibility, or unused abstractions. Keep implementation minimal and aligned with current-state projections.

## §Behavioral Rules
- **τEnvelope**: Agents interacting with the runtime must return valid JSON envelopes.
- **§Scribe**: Offload fire-and-forget tasks (summarization, extraction, validation) to local workers (`spawn_scribe` → mail).
- **§Recovery**: Replay-safe actions (noop, note) resume automatically; side-effects require manual resolution.

## §Documentation Handling
- **Canonical**: `docs/*.md` is the source of truth for architectural constraints.
- **Updates**: Material changes to system behavior MUST be documented in the relevant `docs/` file using TDD-formatted markers.
- **No References**: Never inject content from `references/` into the system prompt.

## §BestPractices
- **Language/Runtime**: TypeScript (latest stable), Bun (runtime + test runner).
- **Conventions**:
    - **Filenames**: kebab-case.
    - **Folder Structure**: `src/<module>/main.ts` for entrypoints, helpers in subfolders.
    - **Imports**: Strict relative imports (`./`, `../`). No implicit path aliases.
- **Git**: 
    - **Commits**: Focused, atomic commits per sub-task.
    - **Messages**: Prefix with type (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`).
- **Testing**: 1:1 test parity. All feature code MUST have a corresponding `*.test.ts` file.
- **Safety**: Fail-closed logic. Validate all schemas at runtime boundary.
EOF

## §References
- **`docs/`**: Source of truth for system architecture and protocols. MUST be consulted before implementation.
- **`TODO.md`**: Current active development roadmap. Implement items in priority order.
- **`DONE.md`**: Historical archive of completed features and architectural evolution.
- **`docs/STYLE.md`**: Mandatory TDD (Token Dense Dialect) styling guide for all doc updates.
- **`docs/HISTORY.md`**: Contextual archive for deprecated/theoretical narratives.
