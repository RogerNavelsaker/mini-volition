# AGENTS.md

## Purpose
Local-first multi-agent runtime. Short CLI aliases own durable state; workflow-centric skill files hold workflow detail.

## Aliases
- `tl` = trellis, specs and plans.
- `ml` = mulch, durable knowledge and decisions.
- `cn` = canopy, pinned prompts.
- `sd` = seeds, tasks and execution state.

## Rules
- Read this file first. For workflow detail, load the relevant `.llm/skills/<workflow>/SKILL.md`.
- Never modify storage files directly. Use CLI services.
- Never create temporary scripts or files in the project root or CWD. Use the OS temporary directory or run code directly via `nu_*` or `ctx_*`.
- Never introduce migrations.
- Imports are strict relative.
- Keep changes atomic. One logical change per commit.
- Use Conventional Commits.
- Use git worktrees for feature isolation. Never commit to `main`.
- GitHub operations go through `gh`.

## Tool scope
Dev agents (Claude Code, Gemini CLI, Codex CLI) may use:
- `git`, `gh`
- `tl`, `sd`, `ml`, `cn`, `phloem`
- `bun` (build/test)
- Standard Linux utilities

### CLI-First Principle
Never access state directories (`.seeds/`, `.trellis/`, `.mulch/`, `.canopy/`) directly via filesystem tools (`ls`, `cat`, `grep`, `ctx_read`). Use the provided CLIs (`sd`, `tl`, `ml`, `cn`). They return structured data (`--json`), apply invariants, and emit events. Any agent bypassing these services to read storage files directly will be terminated. Direct file interaction is reserved solely for catastrophic system recovery.

**Data Extraction:** When retrieving large JSON payloads from these CLIs (e.g., `sd list --json`), **never redirect the output to an intermediate file just to read it back**. This is an anti-pattern. Instead, use one of the following methods:
1. `ctx_shell` with `raw=true` to skip compression.
2. The native `run_shell_command` which returns uncompressed output.
3. Nushell (`nu_evaluate`) to process the JSON directly in the pipeline (e.g., `sd list --json | from json`).

Dev agents **must not** assume these are available — they are the binaries this repo *produces* and are not on the development path:
- `agent-mail`, `agent-state`, `agent-jobs`, `agent-memory`, `agent-runtime`, `operator-console`
- `fleet`, `fleet-librarian`, `fleet-reporter`
- `inference-local`, `inference-cloud`
- `inference-local-embed`, `inference-local-rerank`, `inference-local-small`, `inference-local-medium`
- `inference-cloud-anthropic`, `inference-cloud-google`, `inference-cloud-openai`, `inference-cloud-openrouter`

These only exist at runtime inside a built, running fleet. Never reference them in dev workflows, review loops, or handoffs.

## Branching (two-tier)
- **Tier 1 — local integration (default).** Feature branches merge locally into `integration` via `git merge --no-ff`. `integration` lives in a dedicated shadow worktree (`./worktrees/integration`) so it never muddies `main`. Rollback is `git revert` on `integration` before any push.
- **Tier 2 — GitHub PR.** Used when the work needs external review, human sign-off, or CI before landing. `gh pr create` against `main` from the feature branch. Skip the local tier-1 merge.
- **Publishing.** `main` only ever fast-forwards to `integration` at an explicit publish boundary (milestone, operator sign-off). Then `git push origin main`.

## Skills (workflow-centric)
Each skill may use multiple tools (`sd`, `ml`, `tl`, `cn`, git, build).

- `.llm/skills/priming-context/SKILL.md` — recover state at session start or after compaction
- `.llm/skills/scoping-changes/SKILL.md` — turn a request into issue + spec + plan + feature branch
- `.llm/skills/executing-plans/SKILL.md` — drive a plan to completion with validation
- `.llm/skills/reviewing-branches/SKILL.md` — peer review a feature branch before merge
- `.llm/skills/coordinating-agents/SKILL.md` — lightweight messaging via seeds, trellis, and phloem
- `.llm/skills/capturing-knowledge/SKILL.md` — record decisions, patterns, failures, references
- `.llm/skills/delegating-subtasks/SKILL.md` — spawn sub-agents with pinned prompts
- `.llm/skills/closing-sessions/SKILL.md` — tier-1 local merge or tier-2 PR, close issues, record learnings

Per-CLI behavior is not a separate skill. Each CLI reads this file via its root pointer (`CLAUDE.md`, `GEMINI.md`, `CODEX.md` → `.llm/AGENTS.md`) and discovers skills via its `.{tool}/skills` symlink to `.llm/skills/`.

## Documentation
- `docs/ARCHITECTURE.md` — component index
- `docs/1-philosophy.md` … `docs/7-governance.md` — deep dives
- `prompts/*.md` — system prompt sources
