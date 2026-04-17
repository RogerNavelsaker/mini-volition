---
name: capturing-knowledge
description: Records durable knowledge — patterns, conventions, decisions, failures, references, guides — into mulch so it survives the current session. Use immediately when a non-obvious choice is made, a bug shape is diagnosed, a convention solidifies, or an external reference becomes load-bearing.
---

# Capturing knowledge

Write facts that outlive the task. Primary tool: `ml`.

## When to trigger

- A non-obvious decision was made between alternatives.
- A failure was diagnosed and resolved — capture the *shape* so it isn't rediscovered.
- A convention has now been applied twice or more across the repo.
- An external reference (spec, dashboard, upstream doc) is now load-bearing for some code.
- A pinned prompt revision in canopy materially changed a sub-agent's behavior.

## When NOT to trigger

- The fact is derivable from code or `git log`.
- The fact is already in `docs/` or `AGENTS.md`.
- It's ephemeral task state. Put it on the seeds issue with `sd update` instead.

## Flow

1. **Check for duplicates** — `ml search "<keywords>"`. Update an existing record rather than adding a near-duplicate; use `ml edit <domain> <id>` or `ml outcome <domain> <id>`.
2. **Classify** — pick exactly one type (see below).
3. **Record** — syntax depends on type (required fields differ). Include evidence where available:
   ```
   ml record <domain> --type pattern     --name "..." --description "..." [--evidence-commit <sha>]
   ml record <domain> --type convention  --description "..." [--files a.ts,b.ts]
   ml record <domain> --type decision    --title "..." --rationale "..." [--relates-to <id>]
   ml record <domain> --type failure     --description "..." --resolution "..." [--evidence-commit <sha>]
   ml record <domain> --type reference   --name "..." --description "..."
   ml record <domain> --type guide       --name "..." --description "..."
   ```
4. **For prompt-revision decisions** — note the canopy prompt name in the rationale so `cn history <name>` stays linked.

## Record types

- **pattern** — a recurring design or code shape worth following. State shape + why.
- **convention** — a repo-wide rule (naming, layout, style). State rule + scope.
- **decision** — a choice between alternatives. Rationale required; note rejected options.
- **failure** — a past bug, regression, or dead-end. Description + resolution required.
- **reference** — pointer to external material. State locator + why it matters + which code depends on it.
- **guide** — how-to / procedural note. Name + description.

## Rules

- Lead with the fact. Follow with *why* and *how to apply*.
- One record = one fact. Don't bundle.
- Update or delete stale records. `ml doctor` flags decay — treat its output as work, not noise.
- If a `failure` record's resolution is now enforced by code or CI, note that and consider `ml delete` after `--evidence-commit` is linked.
- Never open the expertise JSONL files directly. Query via `ml search` / `ml query` / `ml ready`.
