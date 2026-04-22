---
name: capturing-knowledge
description: Records durable knowledge — patterns, conventions, decisions, failures, references, guides — into mulch so it survives the current session. Use immediately when a non-obvious choice is made, a bug shape is diagnosed, a convention solidifies, or an external reference becomes load-bearing.
---

# Capturing knowledge

Write facts that outlive the task. Primary tools: `ml` (mulch) and `ctx_knowledge` (lean-ctx).

## When to trigger

- A non-obvious decision was made between alternatives.
- A failure was diagnosed and resolved — capture the *shape* so it isn't rediscovered.
- A convention has now been applied twice or more across the repo.
- An external reference (spec, dashboard, upstream doc) is now load-bearing for some code.
- A pinned prompt revision in canopy materially changed a sub-agent's behavior.

## Recording

### 1. Persistent project knowledge (mulch)
Use for durable, repo-wide facts.

1. **Check for duplicates** — `ml search "<keywords>"`. Update an existing record rather than adding a near-duplicate; use `ml edit <domain> <id>` or `ml outcome <domain> <id>`.
2. **Classify** — pick exactly one type: `pattern`, `convention`, `decision`, `failure`, `reference`, `guide`.
3. **Record**:
   ```
   ml record <domain> --type <type> --name "..." --description "..." [--evidence-commit <sha>]
   ```

### 2. Fast knowledge capture (lean-ctx)
Use for quick capture during a session or for facts that might be consolidated later.

```typescript
ctx_knowledge({
  action: "remember",
  category: "architecture" | "api" | "testing" | "deployment" | "conventions" | "dependencies",
  key: "unique-key",
  value: "The durable fact or pattern description",
  confidence: 0.9
})
```
- `action: "consolidate"`: Extract all findings from the current session.
- `action: "gotcha"`: Record a bug/mistake and its trigger/resolution to never repeat it.

## When NOT to trigger
...
## Rules

- Lead with the fact. Follow with *why* and *how to apply*.
- One record = one fact. Don't bundle.
- Update or delete stale records. `ml doctor` flags decay — treat its output as work, not noise.
- If a `failure` record's resolution is now enforced by code or CI, note that and consider `ml delete` after `--evidence-commit` is linked.
- Never open the expertise JSONL files directly. Query via `ml search` / `ml query` / `ml ready`.
