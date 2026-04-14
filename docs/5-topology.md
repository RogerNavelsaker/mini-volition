# topology

## current roster

The fleet currently runs three cloud agents:

| agent | model | ACP binary |
|---|---|---|
| claude | Claude (via `@agentclientprotocol/claude-agent-acp`) | `bunx --bun @agentclientprotocol/claude-agent-acp` |
| gemini | Gemini 3.1 Pro Preview (via `gmi --acp`) | `/home/rona/.flox/run/x86_64-linux.default.run/bin/gmi` |
| codex | Codex (via `@zed-industries/codex-acp`) | `bunx --bun @zed-industries/codex-acp` |

Plus background services: fleet-embed, fleet-rerank, fleet-e2b, fleet-e4b, fleet-digest, fleet-librarian.

Plus the human operator surface: operator-harness.

## session layout

All agents and services run inside a single Zellij session defined by `config/fleet.kdl`.

Current layout:

```
┌──────────┬──────────┬──────────┐
│  CLAUDE  │  GEMINI  │  CODEX   │
├──────────┼──────────┼──────────┤
│INFERENCE │TOWN SQ.  │  DIGEST  │
│          ├──────────┼──────────┤
│          │  MEMORY  │ OPERATOR │
└──────────┴──────────┴──────────┘
```

Each agent pane runs `agent-harness` with environment variables that set identity and ACP command.

## spawning more agents

The fleet can run multiple instances of the same provider. To add a second Claude agent:

1. add a new pane to `fleet.kdl` with `AGENT_NAME=claude-2` and the same `AGENT_COMMAND`
2. the harness, mail bus, state, jobs, and memory all key on `agent_name` — a new name creates a new identity automatically
3. no code changes needed — all per-agent state is name-scoped in the database

### what needs to change for dynamic topology

Currently the layout is static in `fleet.kdl`. To support runtime spawning:

- **dynamic pane creation** — Zellij supports `zellij action new-pane` and `zellij run` from the CLI, which can inject a new agent pane into a running session without rewriting the KDL layout
- **agent registry** — the fleet needs a table or config that tracks which agents are supposed to be running, so it can detect missing or dead agents and restart them
- **operator approval** — spawning should require operator confirmation, at least initially, to prevent runaway agent multiplication
- **identity generation** — new agents need unique names; a simple counter per provider (`claude-1`, `claude-2`) or operator-chosen names would work
- **inheritance** — new agents of the same provider type should inherit the same role overlay prompt but start with empty memory and job queues (same principle as volition's lobotomy: wipe working state, keep cultural artifacts)

### what is NOT planned

- agents spawning agents without operator approval
- cross-machine fleet distribution
- container isolation (agents share the workspace filesystem)
- cross-machine fleet distribution
- container isolation (agents share the workspace filesystem)

## work reassignment

When an agent repeatedly fails a task (provider quota, repeated errors), the harness should be able to:

1. detect the failure pattern (already partially exists via rate-limit detection)
2. reschedule the job to a different agent via agent-jobs (the `target_agent` field already exists on `queue_task`)
3. escalate to the operator if no alternative agent is available

This is an extension of the existing escalation and job-reschedule paths, not a new system.

## topology status

Current: static, 3 agents, operator-managed.

Next: dynamic pane injection via Zellij CLI, with operator-approved spawning. See TODO.md.
