# Volition README Notes

Source: https://github.com/AIndoria/volition/blob/main/README.md

Behavior cues relevant to `.fleet`:

- Agents are treated as persistent system processes rather than chat sessions.
- Context recovery is grounded by layered memory, recent logs, summaries, and explicit environmental maps.
- Mistakes should feed back into the next turn so the agent can correct course.
- Social coordination and stewardship between agents are core behavior, not optional decoration.
- The author explicitly distinguishes low-authority presentation layers from high-authority memory/control surfaces.

How this informs `.fleet`:

- Keep turn assembly harness-owned and explicit.
- Keep transport, state, queued work, and orchestration on separate binaries/surfaces.
- Treat recovery, wake causes, and durable logs as first-class runtime behavior.
