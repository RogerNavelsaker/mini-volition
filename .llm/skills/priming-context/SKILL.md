---
name: priming-context
description: Loads durable project state at session start or to answer status questions — open issues, prior decisions, active specs/plans/handoffs, and pinned prompts — by calling the `sd` / `ml` / `tl` / `cn` primes. Use at session start, after `/compact` or `/clear`, when the agent seems to have lost context, or when the user asks "what's next", "what's open", "current tasks", "active plans", or "backlog".
---

# Priming context

Run at session start, and any time the user asks what work is open or in flight. Every command is cheap; output is structured.

## When to trigger

- Start of a new conversation in this repo.
- After `/compact`, `/clear`, or detectable context loss.
- User asks about status: "what's next", "what's open", "current tasks", "plans", "backlog", "what's in flight".
- Before any non-trivial change, to confirm no existing issue/plan already owns it.

## Flow

1. `ctx_overview(task: "...")` — get a task-relevant project map and high-signal starting point.
2. `sd list --status open --json` — open issues and task state.
3. `ml prime --context` — knowledge records relevant to git-changed files.
4. `tl list --status active --json` — active specs, active plans.
5. `cn list` — available pinned prompts.
6. `ctx_preload(task: "...")` — proactively cache task-relevant files with L-curve-optimized summaries.

Run in order. Each step answers a different question; skipping one risks duplicate work or rediscovering a known failure.

## After priming

- Is there an open issue matching the request? If not, go to `scoping-changes`.
- Did `ml prime --context` surface a prior decision or failure touching the target files? Read it before acting.
- Is a plan already active for this area? Go to `executing-plans`.

## Rules

- Do not try to answer "what's next" by reading state directories or files. Use the CLIs — they're the only source of truth.
- Do not skip priming to "save tokens." Output is compact by design.
- If a prime command errors, stop and report. Do not guess state.
