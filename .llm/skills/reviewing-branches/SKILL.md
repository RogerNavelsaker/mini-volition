---
name: reviewing-branches
description: Peer-reviews a feature branch locally using git, standard Linux tools, and the seeds/mulch/trellis CLIs before it merges to integration or opens as a PR. Use when asked to review another agent's work, before tier-1 local merge, or as a self-check pass before `gh pr create`.
---

# Reviewing branches

Read the diff, verify the claims, run the gates. No GitHub round-trip required.

## When to trigger

- Another agent (or your prior self) finished a feature branch and asks for review.
- About to merge tier-1 (`git merge --no-ff <slug>` into `integration`).
- About to open tier-2 (`gh pr create`) — run this first as a self-check.

## Prerequisites

- Session primed (`priming-context`).
- The feature branch exists locally. If it was handed off from another worktree, check it out in a dedicated review worktree:
  ```
  git worktree add worktrees/<slug>-review <slug>
  cd worktrees/<slug>-review
  ```

## Review checklist

```
Branch Review (<slug>):
- [ ] 1. Locate scope artifacts:
        - Seeds issue:   sd show <issue-id>
        - Plan:          tl plan show <slug>
        - Spec:          tl spec show <slug>        (if present)
- [ ] 2. Confirm commit log matches the plan:
        git log --oneline integration..<slug>
        One commit per plan step; conventional prefixes; no `--amend` traces.
- [ ] 3. Read the diff end-to-end:
        - `ctx_read(path: "...", mode: "diff")` for each changed file to see the surgical impact.
        - `ctx_impact(action: "analyze", path: "...")` on critical files to verify no regression in importers.
- [ ] 4. Check scope discipline:
        `git diff integration...<slug> --stat`
        Are touched files justified by the plan? Flag surprises.
- [ ] 5. Cross-reference prior art:
        ml search "<keywords from diff>"            (any relevant decisions/failures?)
- [ ] 6. Run the gates locally:
        bun run scripts/build.ts
        bun test
- [ ] 7. Boundary checks (grep the diff):
        - No direct edits to state/ or SQLite DB files
        - No new path aliases; imports are strict relative
        - No migrations, no legacy shims
        - No references to runtime binaries (agent-*, fleet-*) added to dev docs/skills
- [ ] 8. Verdict: approve / request-changes / block
```

## Useful commands (standard tools only)

- `git log --oneline --graph integration..<slug>` — commit shape.
- `git log -p integration..<slug> -- <path>` — per-file change history on the branch.
- `git diff integration...<slug>` — net change (three-dot compares against merge base).
- `git request-pull integration origin <slug>` — text summary of what the branch adds.
- `git show <sha>` — full view of any single commit.
- `git diff integration...<slug> -- <path>` vs `git show <slug>:<path>` — compare single file at two revs (`<(...)` process substitution unsupported in Nu/ctx_shell).
- `git diff integration...<slug> | ^grep -nE 'agent-|fleet-'` — catch runtime-binary leakage (prefix `^grep` to invoke system grep in Nu).
- `sd show <issue-id>` / `sd show <issue-id> --json` — inspect the linked issue.
- `ml query <domain> --type failure --json` — scan prior failure shapes in one domain.

## Review outcome

Post the verdict through the channel the author used to hand off:
- Append to the plan's handoff log: `tl handoff append <slug> --to <author> --summary "<verdict>: ..."`.
- Or note on the issue: `sd update <issue-id> --body "review: <verdict> — <details>"`.

Do **not** invent a review channel using runtime binaries — `agent-mail` is not available during development.

- **Approve** → author proceeds to `closing-sessions` (tier-1 merge or tier-2 PR).
- **Request changes** → specific, cite commits by sha and files by path. Author loops back into `executing-plans`.
- **Block** → structural problem (wrong scope, boundary violation, missing spec). Recommend re-scoping.

## Rules

- Read the whole diff before forming an opinion. Skimming produces bad reviews.
- Never merge someone else's branch without explicit approval on the issue or in the handoff log.
- If gates fail on your machine but the author claims they passed, investigate — do not assume flake.
- Never query seeds/mulch/trellis by reading their state directories. Always go through the CLIs.
