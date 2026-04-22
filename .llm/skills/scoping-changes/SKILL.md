---
name: scoping-changes
description: Turn requests into tracked seeds issues, trellis specs, and plans. Use when requests are ambiguous, cross boundaries, or require multi-step planning.
---
# Scoping changes
Shape work before coding. Combines seeds (tasks), mulch (prior art), trellis (specs/plans), and lean-ctx (impact analysis).

## Workflow
1. **Analyze**: Use `ctx_architecture(action: "overview" | "layers" | "cycles")` to understand the structural context.
2. **Impact**: Use `ctx_impact(action: "analyze", path: "...")` on files you intend to change to assess the blast radius.
3. **Define**: Use `tl spec create` and `tl spec update` for architectural resolution. Search `ml` for prior decisions.
   - **No Verbatim Copies**: Specs must focus on technical approach/constraints/acceptance. Do not duplicate the issue's problem statement.
4. **Track**: Use `sd create` for issues. Link using `sd dep add`.
   - **Issues**: Focus strictly on the goal/problem.
5. **Plan**: Use `tl plan create` for actionable steps (one logical change per commit).
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
