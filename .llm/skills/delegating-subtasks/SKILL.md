---
name: delegating-subtasks
description: Spawns a sub-agent using the host CLI's native sub-agent tool (Claude Code's Task/Agent, Gemini CLI's equivalent, Codex CLI's equivalent) with a pinned prompt loaded from canopy. Use to keep the primary agent's context clean, to parallelize independent queries, or when a cheaper/faster model is enough for a bounded subtask.
---

# Delegating subtasks

Hand off a bounded subtask to a sub-agent of the host CLI, using a canopy-managed prompt so the prompt text (and its model binding) is version-controlled. Canopy does **not** spawn — it stores the prompt; the host CLI launches the sub-agent.

## When to trigger

- Subtask is well-defined with a clear input/output contract.
- Heavy context is local to the subtask and should not pollute the main conversation.
- Running multiple independent queries that can proceed in parallel.
- A cheaper or faster model is sufficient (extraction, summarization, classification, routine refactors).

## When NOT to trigger

- Task requires orchestration across ownership boundaries — stay in the main agent.
- Task needs to commit, push, message operators, or mutate durable state without review.
- Scope is under-specified. Scope first (`scoping-changes`), then delegate.
- The subtask's ideal model is the same class the main agent is already using — no win.

## Flow

1. **Find or author a prompt** in canopy:
   ```
   cn list
   cn show <name>
   ```
   If no suitable prompt exists:
   ```
   cn create --name <gerund-slug> --tag <domain> \
             --section "role=..." --section "task=..." --section "output=..."
   ```
   Pin the target model in the prompt body or frontmatter, not at the call site.

2. **Validate the prompt's schema** (if one is assigned):
   ```
   cn validate <name>
   ```

3. **Render the prompt text**:
   ```
   cn render <name>
   ```
   Capture the rendered text. This is what you pass to the sub-agent tool.

4. **Launch the sub-agent via the host CLI's own tool**:
   - Claude Code: the `Task` / `Agent` tool, with the rendered prompt as the task description.
   - Gemini CLI: the equivalent sub-agent call.
   - Codex CLI: likewise.
   The host CLI is the *only* thing that actually spawns. Canopy, seeds, trellis, and mulch don't spawn anything.

5. **Validate output** — check the sub-agent's result against the contract before acting on it. Sub-agents propose; the main agent decides.

6. **Track** — if the subtask maps to an open seeds issue, note the delegation:
   ```
   sd update <issue-id> --body "delegated <name>@<model> → <1-line result>"
   ```

## Model selection

- **Fast/cheap** (haiku-class, or a local cheap model): routine extraction, summarization, formatting.
- **Balanced** (sonnet-class): targeted refactors, scoped code review passes.
- **Heavy**: reconsider delegation. If the sub-agent needs a heavy model, the main agent probably should handle it.

## Rules

- One prompt per task shape. Don't reuse prompts across unrelated work.
- Pin the model in the prompt. Don't let callers silently upgrade.
- Sub-agents return results. They don't commit, push, or escalate.
- Notable prompt revisions are decisions — record via `capturing-knowledge` (`ml record ... --type decision`).
- Never read `.canopy/*.jsonl` directly — use `cn show` / `cn render` / `cn history`.
