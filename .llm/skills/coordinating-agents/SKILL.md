---
name: coordinating-agents
description: Exchanges lightweight messages between dev agents (Claude Code, Gemini CLI, Codex CLI) using the phloem CLI plus existing seeds and trellis primitives. Use for cross-agent pings, review requests, status broadcasts, and issue-scoped chat — without involving GitHub or runtime binaries.
---

# Coordinating agents

Three layered channels, cheapest first. Pick the smallest that fits.

## Channels

### 1. Seeds issue-scoped chat (no new tool)

When the conversation belongs to an existing task:

```
sd update <issue-id> --body "@reviewer: diff looks off in harness.ts L412"
sd show   <issue-id>                     # read current state
sd show   <issue-id> --json              # machine-readable
```

Convention: prefix the body with `@<to>:` (or `@all:`) so agents can filter visually.

### 2. Trellis handoff (explicit transfer of control)

When control of a plan moves between agents:

```
tl handoff append <slug> --to <agent> --from <self> \
                  --summary "current step 3/7, blocker on provider socket"
tl handoff list    --plan <slug>
tl handoff latest  <slug>
```

### 3. Phloem (free-form, non-issue-scoped)

For pings, broadcasts, questions, or anything that doesn't belong on a specific issue:

```
phloem send   --to reviewer --scope plan:auth-refactor \
              --body "ready for review on branch mv-auth-refactor"
phloem inbox  --for reviewer --unacked
phloem ack    <msg-id>
```

Scopes are free-form strings. Suggested prefixes: `issue:<id>`, `plan:<slug>`, `channel:<name>`. Agents agree on conventions by using them.

## When to use which

| Situation | Channel |
|---|---|
| Comment on a specific issue | Seeds (#1) |
| Transfer control of a plan | Trellis (#2) |
| "I'm working on X" / broadcast | Phloem `--to all` (#3) |
| Review request outside any one issue | Phloem with `--scope plan:<slug>` (#3) |
| Need human + CI in the loop | `gh pr create` (not this skill) |

## Phloem reference

### Commands

```
phloem send  --to <agent> [--from <agent>] [--scope <s>] (--body "..." | --body-file <path|->)
phloem inbox [--for <agent>] [--scope <s>] [--since <iso|epoch-ms>] [--unacked]
phloem ack   <msg-id> [--by <agent>]
```

### Git-sharing

To make phloem traffic travel with the repo, add:

```
# .gitattributes
.phloem/*.jsonl merge=union
```

To keep it purely local, add `.phloem/` to `.gitignore`. Either way, read messages via the CLI, not by opening the JSONL.

### Build (bootstrap)

`phloem` is produced from and lives inside this skill directory:

- Source: `.llm/skills/coordinating-agents/main.ts` (+ `build.ts`)
- Binary: `.llm/skills/coordinating-agents/bin/phloem`

The flox environment's `on-activate` hook auto-builds `phloem` whenever the source is newer than the binary (or the binary is missing). The skill-local `bin/` is added to `PATH` via `[profile.common]`. No manual step is normally needed — just `flox activate`.

If the auto-build fails (build output printed to stderr during activation), run manually:

```
bun run .llm/skills/coordinating-agents/build.ts
```

`.llm/skills/*/bin/` is gitignored, so the binary never lands in commits.

### Identity

Set a default agent name once per clone (or per worktree) so `--from`/`--for`/`--by` are auto-filled. Use `phloem` itself once it's built; do not hand-edit the config file.

## Rules

- Phloem is a log, not a queue. Messages never disappear. Treat inbox as a view.
- Acks are advisory — they signal "seen", not "done". Action lives in seeds/trellis.
- Do not put secrets or long content in messages. Reference commits, issues, or plans by id.
- Phloem is for dev-agent coordination only. Runtime agent coordination uses `agent-mail` (a different tool inside the fleet product).

## Non-goals

- No server. No daemon. No real-time push.
- No schema for scopes — agents negotiate by usage.
- No message editing or deletion. If you said it wrong, send a correction referencing the original id.
