---
name: closing-sessions
description: Finalizes a work session — routes the feature branch through tier-1 local merge into integration or tier-2 GitHub PR, completes plans, closes issues, records learnings, and verifies clean state. Use before declaring "done", before context compaction, or before a handoff.
---

# Closing sessions

Leave the repo in a state the next agent can resume without archaeology. Combines git, `gh`, trellis, seeds, mulch, and canopy. Pick tier 1 or tier 2 based on whether the change needs external review.

## Tier selection

- **Tier 1 — local integration merge (default).** Inter-agent work, no external review needed yet.
- **Tier 2 — GitHub PR.** External review, human sign-off, or CI required before landing.

When in doubt, prefer tier 1. Promotion from `integration` to `main` happens at an explicit publish boundary and is where tier-2 review can still intervene.

## Prerequisites (both tiers)

- Build passes: `bun run scripts/build.ts`.
- Tests pass for touched modules: `bun test`.
- Branch has been reviewed (`reviewing-branches`), self- or peer-.
- Working directory clean: `git status` shows nothing unexpected.

## Tier 1 — local merge into integration

```
Tier 1 Close:
- [ ] 1. Complete plan:         tl plan complete <slug> --summary "<outcome>"
- [ ] 2. Record new learnings:  see `capturing-knowledge`
- [ ] 3. Switch to integration worktree:
         cd worktrees/integration
- [ ] 4. Fast-forward integration from origin (if shared):
         git fetch origin && git merge --ff-only origin/integration    # only if remote exists
- [ ] 5. Merge the feature (preserve branch shape):
         git merge --no-ff <slug> -m "merge: <slug> (#<issue-id>)"
- [ ] 6. Verify post-merge:     bun run scripts/build.ts && bun test
- [ ] 7. Close the issue:       sd close <issue-id>
- [ ] 8. Sync state dirs:       sd sync && ml sync && tl sync && cn sync
- [ ] 9. Retire the feature worktree:
         cd <main-worktree>
         git worktree remove worktrees/<slug>
         git branch -d <slug>           # -d only; never -D on unmerged work
```

`tl sync` stages and commits any pending `.trellis/` changes with a generated body listing what moved — use it rather than `git add .trellis/` to keep the message consistent.

### Rollback (tier 1)

Before `main` has advanced, a bad merge on `integration` is cheap to undo:

```
git revert -m 1 <merge-sha>       # preserves history, safe for shared integration
# or, if integration is strictly local and unpushed:
git reset --hard <merge-sha>^     # destructive; only when you are sure
```

## Tier 2 — GitHub PR

```
Tier 2 Close:
- [ ] 1. Complete plan:         tl plan complete <slug> --summary "<outcome>"
- [ ] 2. Record new learnings:  see `capturing-knowledge`
- [ ] 3. Push the branch:       git push -u origin <slug>
- [ ] 4. Open the PR:           gh pr create --base main --head <slug> \
                                   --title "<type>: <summary>" \
                                   --body-file <(tl plan show <slug>)
- [ ] 5. Link PR to issue:      sd update <issue-id> --body "PR: $(gh pr view <slug> --json url -q .url)"
- [ ] 6. Check CI:              gh pr checks <slug>
- [ ] 7. Park pending review — do not merge. Await operator or reviewer sign-off.
```

### Landing a tier-2 PR (operator sign-off only)

- `gh pr merge <n> --squash --delete-branch` — only with explicit user approval.
- After merge: `git worktree remove worktrees/<slug>` locally; `git fetch origin` to update `main`.

## Publishing integration to main

At a milestone or when tier-2 external visibility is wanted:

```
cd <main-worktree>
git checkout main
git merge --ff-only integration    # main only ever fast-forwards
git push origin main
```

If `--ff-only` fails, `main` diverged — investigate before forcing anything.

## Hard rules (both tiers)

- Always `git commit` for new commits. Never `--amend` a pushed commit. Never `--no-verify`. Never force-push a shared branch.
- Never `git worktree remove --force` without verifying no unpushed or uncommitted work remains.
- Do not use `agent-mail`, `agent-state`, `fleet*`, or any runtime binary during close. Those are build outputs, not dev tools.
- Do not commit files under `state/` or SQLite DBs. They are gitignored — if they appear untracked, investigate.
- If build or tests fail, you are not closing. Fix or park as a blocker and report.

## Handoff (if parking, not finishing)

- `tl handoff append <slug> --to <agent> --summary "current step N; next action; open questions"`.
- `sd update <issue-id> --body "handoff to <agent>, branch <slug>"`.
- Do **not** merge to integration on behalf of an unfinished handoff. The receiving agent finishes the close.
