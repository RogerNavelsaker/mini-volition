---
name: coordinating-agents
description: Exchanges lightweight messages between dev agents (Claude Code, Gemini CLI, Codex CLI) using ctx_agent from the lean-ctx MCP server plus existing seeds and trellis primitives. Use for cross-agent pings, review requests, status broadcasts, and issue-scoped chat.
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

### 3. lean-ctx (free-form, non-issue-scoped)

For pings, broadcasts, questions, or anything that doesn't belong on a specific issue:

```typescript
ctx_agent({ 
  action: "post", 
  to_agent: "reviewer", 
  category: "request", 
  message: "plan:auth-refactor: ready for review on branch mv-auth-refactor" 
})
ctx_agent({ action: "read" }) // Inbox (unacked by default)
ctx_agent({ action: "sync" }) // Full coordination overview
```

Categories for `post`: `finding`, `warning`, `request`, `status`.

## When to use which

| Situation | Channel |
|---|---|
| Comment on a specific issue | Seeds (#1) |
| Transfer control of a plan | Trellis (#2) |
| "I'm working on X" / broadcast | lean-ctx `action: "post"` (#3) |
| Review request outside any one issue | lean-ctx `action: "post"` (#3) |
| Need human + CI in the loop | `gh pr create` (not this skill) |

## lean-ctx reference

### ctx_agent Actions

- `post`: Send a message. Use `to_agent` for direct, omit for broadcast.
- `read`: Read incoming messages.
- `sync`: Get a high-level overview of agent states, pending messages, and shared contexts.
- `status`: Update your own status (`active` \| `idle` \| `finished`).
- `diary`: Record durable learnings/decisions for other agents to recall later.

### Git-sharing

`lean-ctx` state is persisted across sessions via the MCP server and its backing store. It does not litter the repository with state files, keeping the workspace cleaner.

## Identity

Agents are automatically registered when they join a session. Use `ctx_agent(action: "info")` to see your current ID and status.

## Rules

- The lean-ctx message bus is a log, not a queue. Treat `action: "read"` as your inbox view.
- Category `status` is advisory — use it for acks or "seen" signals. Action still lives in seeds/trellis.
- Do not put secrets or long content in messages. Reference commits, issues, or plans by id.
- `ctx_agent` is for dev-agent coordination only. Runtime agent coordination uses `agent-mail` (a different tool inside the fleet product).

## Non-goals

- No message editing or deletion. If you said it wrong, send a correction referencing the original id.
- No real-time push. Agents poll via `read` or check `sync`.
