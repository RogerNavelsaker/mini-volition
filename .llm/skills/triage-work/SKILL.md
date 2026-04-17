---
name: triage-work
description: Selects the highest-leverage task from the project graph. Replaces graph-theory triage tools (BV) by analyzing Seeds dependencies, priorities, and labels to identify the "ready" work that unblocks the most downstream tasks.
---

# Triage work

Operate "one layer up" by analyzing the work frontier. Don't just pick the first task; use the graph-based ranking to identify the highest-leverage task that spins the flywheel fastest.

## Flow

1. **Analyze the frontier**:
   ```
   sd triage --limit 5
   ```
   This ranks "ready" tasks by PageRank + betweenness + critical path score.

2. **Select and Claim**:
   - Pick the top-ranked task.
   - Transition to `in_progress`:
     ```
     sd update <issue-id> --status in_progress --assignee <agent>
     ```

3. **Announce intent** (multi-agent only — skip in solo sessions):
   - Use `phloem` to signal to other agents:
     ```
     phloem send --to all --scope issue:<id> --body "Starting work on high-leverage foundation (ranked top by sd triage)."
     ```

4. **After closing a task**, unblock its dependents:
   ```
   sd close <issue-id>
   sd unblock <dependent-id> --from <issue-id>   # repeat for each downstream issue
   ```
   Then re-triage — scores shift when blockers clear.

## Rules

- Always check `sd blocked` if top triage results are blocked.
- If no tasks are ready, move to **Plan Space** (`scoping-changes`) to create new work.
- Re-triage after every 3–5 closed tasks; closing a blocker can move previously low-ranked tasks to the top.
- `sd unblock --all` removes all closed blockers in one call if you don't need per-blocker control.
