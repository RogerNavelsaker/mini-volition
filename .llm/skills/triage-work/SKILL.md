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
     sd update <issue-id> --status in_progress --assignee gemini
     ```

3. **Announce intent**:
   - Use `phloem` to signal to other agents:
     ```
     phloem send --to all --scope issue:<id> --body "Starting work on high-leverage foundation (ranked top by sd triage)."
     ```

## Rules

- Always check `sd blocked` if top triage results are blocked.
- If no tasks are ready, move to **Plan Space** (`scoping-changes`) to create new work.
- Triage is a continuous process. Re-triage after every 3-5 closed tasks.
