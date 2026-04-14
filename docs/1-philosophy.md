# philosophy

## project goal

Fleet is a local-first multi-agent runtime. It is a mini-volition: the same architecture — persistent agents with tiered memory, structured communication, and shared governance — scaled down to run as a directory inside a workspace rather than a cluster of LXC containers.

The goal is not a better task runner. It is an experiment in coordinated autonomous agents that share a codebase, communicate through a durable bus, accumulate memory across sessions, and operate under explicit protocols that the fleet itself can evolve.

## design principles

### local-first

Everything runs on one machine. The database is SQLite. The inference server is a local ONNX process. The session manager is Zellij. No cloud infrastructure is required beyond the LLM provider APIs that the agents themselves call.

### agents are peers, not servants

Each agent has its own identity, memory, and job queue. The harness mediates their interaction with the outside world, but agents decide what to do through their action envelope. The operator is a participant in the fleet, not a supervisor — communication flows through the same mail bus.

### harness owns transport, agents own reasoning

Agents never construct transport commands for normal replies. They return structured action envelopes. The harness validates, journals, and dispatches. This separation means transport rules (channel integrity, rate limiting, governor policy) can change without touching agent prompts.

### current-state only

No migrations, no backward compatibility, no legacy shims. The fleet schema is whatever the code says it is right now. If it changes, rebuild from clean state.

### memory is durable but lossy

Working memory is ephemeral. Episodic summaries compress experience. Archival lessons distill durable knowledge. Each tier is progressively more compact and less faithful to the original. This is a deliberate trade-off: the fleet prefers compact, retrievable lessons over exhaustive raw logs.

## relationship to volition

Fleet borrows directly from volition:

- 3-tier memory (working, episodic, archival) with promotion between tiers
- structured communication over a shared bus with transport layers
- governor/cooldown to prevent runaway agent loops
- fleet protocols as mutable social norms
- genesis as a deliberate initialization doctrine rather than a bootstrap script
- the principle that persistence is identity
- split-brain via ACP model/effort switching instead of volition's flash/pro model pair

Fleet diverges from volition:
- ACP over JSON-RPC instead of SSH + Redis
- SQLite instead of Redis for all durable state
- Bun-compiled TypeScript binaries instead of Python + asyncio
- local ONNX inference instead of Ollama + remote GPU workers
- Zellij terminal multiplexer instead of LXC containers
- no self-spawning yet — topology is operator-managed
