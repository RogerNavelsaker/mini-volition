---
name: executing-plans
description: Drive a plan step-by-step to completion with validation.
---

# Executing plans

Turn approved plans into commits. Combines trellis (state), seeds (issues), mulch (prior art), and the build/test loop.

## Workflow

- **Verify**: Confirm state with `tl plan show <slug>` and `sd show <issue-id>`.
- **Isolate**: Ensure you are in the plan's feature worktree.
- **Run**:
    1. Mark active: `tl plan start <slug>`
    2. Iterate:
        - Edit
        - Build: `bun run scripts/build.ts`
        - Test: `bun test`
        - Commit: `git commit -m "<msg>"`
        - Record: `tl plan update <slug> --step-note "<step-id>: done"`
    3. Complete: `tl plan complete <slug> --summary "<outcome>"`
    4. Close: `sd close <issue-id>`

## Rules
- One commit per plan step. No squashing.
- Never advance past failing build/test.
- Use CLIs for state (`sd`, `tl`). Never modify or read storage directories directly.
- Record surprises in `ml` immediately.
