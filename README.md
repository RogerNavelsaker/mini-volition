# mini-volition

Local-first multi-agent runtime coordinating cloud LLM agents with SQLite-backed messaging, harness-managed execution, and dedicated local inference workers.

## Architecture

- **Runtime**: Bun (TypeScript)
- **Build**: `bun run scripts/build.ts` compiles `src/` to `bin/`
- **Orchestration**: Zellij multiplexer sessions via `config/fleet.kdl`
- **Data**: SQLite (hotpath acceleration) + JSONL/markdown (durable canonical state)
- **Inference**: ONNX models over Unix sockets (embed, rerank, light, heavy)
- **Providers**: Cloud APIs over Unix sockets (Claude, Gemini, OpenAI, OpenRouter)

## Directory Layout

```
bin/                    # compiled binaries
build/                  # bun metadata, node_modules
config/                 # fleet.kdl (zellij layout), fleet.json (agent roster)
docs/                   # doctrine (architecture, protocols, schemas)
prompts/                # system prompt sources (base + per-agent overlays)
references/             # upstream behavior notes (read-only)
runtime/                # SQLite DBs, Unix sockets, scratchpads (gitignored)
scripts/                # build.ts, bootstrap, status
src/
  agent-harness/        # turn execution, wake selection, context assembly, recovery
  agent-jobs/           # per-agent deferred work queue
  agent-mail/           # message transport (SQLite + claim receipts)
  agent-memory/         # memory indexing, embedding, retrieval, facts, links
  agent-state/          # per-agent runtime state, turn/action journals
  fleet/                # orchestrator (genesis/terminus, governor, build, KDL gen)
  fleet-claude/         # Anthropic API provider worker
  fleet-gemini/         # Google AI API provider worker
  fleet-openai/         # OpenAI API provider worker
  fleet-openrouter/     # OpenRouter API provider worker
  fleet-digest/         # public channel summarization
  fleet-embed/          # BGE-M3 embedding worker (embed.sock)
  fleet-heavy/          # large local model worker (heavy.sock)
  fleet-inference/      # shared Unix socket server factory
  fleet-librarian/      # background memory upkeep (compaction, extraction)
  fleet-light/          # small local model worker (light.sock)
  fleet-provider/       # shared provider socket server factory
  fleet-rerank/         # BGE reranker worker (rerank.sock)
  operator-harness/     # human operator REPL
  state-artifacts/      # append-first JSONL writer
state/                  # durable canonical records (gitignored)
  turns/                # <agent>.jsonl
  actions/              # <agent>.jsonl
  runtime/              # <agent>.jsonl
  jobs/                 # <agent>.jsonl
  mail/                 # <agent>.jsonl
  fleet/                # governor.jsonl
  reviews/              # <agent>.md
```

## Commands

```bash
# build
bun run scripts/build.ts          # compile all binaries to bin/

# session management
fleet genesis                      # start zellij session with all panes
fleet terminus                     # stop session and clean sockets
fleet attach                       # attach to running session
fleet detach                       # detach from session
fleet restart                      # terminus + genesis

# operations
fleet status                       # show binary/db/socket readiness
fleet governor-status              # show per-agent governor state
fleet verify-governor              # check governor projection drift

# per-domain inspection/repair
agent-state verify [agent]         # check turn/action projection drift
agent-state rebuild [agent]        # rebuild from state/ JSONL
agent-jobs verify [agent]          # check job projection drift
agent-mail verify                  # check transport projection drift
agent-memory verify [agent]        # check memory projection drift
```

## Conventions

- **Files**: kebab-case, entrypoints at `src/<module>/main.ts`
- **Imports**: strict relative (`./`, `../`), no path aliases
- **Commits**: conventional (`feat:`, `fix:`, `docs:`, `refactor:`)
- **Schema**: current-state only, no migrations, rebuild from clean DB
- **Durability**: SQLite is hotpath buffer, JSONL under `state/` is canonical (petiole pattern)
- **Envelopes**: strict JSON action envelopes, fail-closed on malformed input

## Environment

Key env vars (all have defaults):

| Variable | Purpose |
|---|---|
| `AGENT_NAME` | Agent identity |
| `FLEET_PROVIDER_SOCKET` | Cloud provider Unix socket path |
| `FLEET_PROVIDER_MODEL` | Cloud model ID |
| `FLEET_EMBED_SOCKET` | Embedding worker socket |
| `FLEET_LIGHT_SOCKET` | Light inference worker socket |
| `FLEET_HEAVY_SOCKET` | Heavy inference worker socket |
| `FLEET_RERANK_SOCKET` | Reranker worker socket |
| `AGENT_MAIL_DB` | Transport database path |
| `AGENT_JOBS_DB` | Job queue database path |
| `AGENT_MEMORY_DB` | Memory database path |
| `AGENT_STATE_DB` | Agent state database path |

## Documentation

Deep dives in `docs/`:
- `ARCHITECTURE.md` -- component index
- `1-philosophy.md` -- design principles
- `2-core-architecture.md` -- roles, communication, durability
- `3-turn-loop.md` -- wake selection, turn execution, recovery
- `4-memory.md` -- tiers, retrieval, upkeep
- `5-topology.md` -- roster, expansion
- `6-schemas.md` -- database schemas, socket protocols
- `7-governance.md` -- governor, cooldown, escalation
