---
name: scoping-changes
description: Turn requests into tracked seeds issues, trellis specs, and plans. Use when requests are ambiguous, cross boundaries, or require multi-step planning.
---
# Scoping changes
Shape work before coding. Combines seeds (tasks), mulch (prior art), and trellis (specs/plans).

## Workflow
1. **Define**: Use `tl spec create` and `tl spec update` for architectural resolution. Search `ml` for prior decisions.
   - **No Verbatim Copies**: Specs must focus on technical approach/constraints/acceptance. Do not duplicate the issue's problem statement.
2. **Track**: Use `sd create` for issues. Link using `sd dep add`.
   - **Issues**: Focus strictly on the goal/problem.
3. **Plan**: Use `tl plan create` for actionable steps (one logical change per commit).
   - **Plans**: Focus strictly on the execution steps and sequence.
- **Isolate**: Initialize feature worktree: `git worktree add ../mv-<slug> -b <slug> integration`.
- **Link**: Connect via `sd update <issue-id> --body "plan: <slug>, branch: <slug>, assignee: @<agent>"`.

## Data Management & Nushell
Manage, align, and sync items cleanly using `nu` batch queries to check consistency and avoid duplication.
```sh
  #Batch fetch issue, spec, and plan data to verify alignment
  let issues = (sd list --json | from json | get issues)
  for issue in $issues {
    let spec = (tl spec show $issue.id --json | from json | get spec)
    let plan = (tl plan show $issue.id --json | from json | get plan)
  # Verify and update here using sd update, tl spec update, etc.
  }
```

## Rules
- **No Boilerplate**: Avoid bloated templates (e.g., "WHAT/WHY/HOW").
- **Caveman Writing Style**: Assume user and agent are smart. Keep text concise, direct, and devoid of filler.
- 85% of effort in Spec/Plan.
- Use CLIs for all state access (`sd`, `tl`, `ml`). Never read storage directories directly.
- Ensure cross-dependencies are explicit.
- Follow conventional commits.
