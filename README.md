# mini-volition

Local-first multi-agent runtime coordinating cloud LLM agents with SQLite-backed messaging, harness-managed execution, and dedicated local inference workers.

## Architecture

- **Runtime**: Bun (TypeScript)
- **Build**: `bun run scripts/build.ts` compiles `src/` to standalone binaries in `bin/`
- **Orchestration**: Zellij multiplexer sessions via `config/fleet.kdl`
- **Data**: SQLite (hotpath acceleration) + JSONL/markdown (durable canonical state)
- **Inference**: ONNX models over Unix sockets (embed, rerank, light, heavy)
- **Providers**: Cloud APIs over Unix sockets (Claude, Gemini, OpenAI, OpenRouter)

## Directory Layout

```
bin/                    # compiled runtime binaries
lib/                    # runtime shared libraries needed by compiled inference workers
config/                 # fleet.kdl (zellij layout), fleet.json (agent roster)
docs/                   # doctrine (architecture, protocols, schemas)
prompts/                # system prompt sources (base + per-agent overlays)
references/             # upstream behavior notes (read-only)
runtime/                # SQLite DBs, Unix sockets, scratchpads (gitignored)
scripts/                # build.ts, bootstrap, status
src/
  agent-runtime/        # turn execution, wake selection, context assembly, recovery
  agent-jobs/           # per-agent deferred work queue
  agent-mail/           # message transport (SQLite + claim receipts)
  agent-memory/         # memory indexing, embedding, retrieval, facts, links
  agent-state/          # per-agent runtime state, turn/action journals
  fleet/                # orchestrator (genesis/terminus, governor, build, KDL gen)
  inference-cloud-anthropic/ # Anthropic API provider worker
  inference-cloud-google/    # Google AI API provider worker
  inference-cloud-openai/    # OpenAI API provider worker
  inference-cloud-openrouter/ # OpenRouter API provider worker
  fleet-reporter/       # public channel reporting from shared gossip
  inference-local-embed/ # BGE-M3 embedding worker (embed.sock)
  inference-local-medium/ # medium local model worker (heavy.sock)
  inference-local/      # shared Unix socket server factory
  fleet-librarian/      # background memory upkeep (compaction, extraction)
  inference-local-small/ # small local model worker (light.sock)
  inference-cloud/      # shared provider socket server factory
  inference-local-rerank/ # BGE reranker worker (rerank.sock)
  operator-console/     # human operator REPL
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
bun install --frozen-lockfile     # install exact deps from bun.lock
bun run scripts/build.ts          # compile all runtime binaries to bin/

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
agent-state subscription-list <agent>
agent-state subscription-get <agent> <channel>
agent-state subscription-set <agent> <channel> <subscribed|unsubscribed> [resumeAt] [note]
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
| `INFERENCE_CLOUD_SOCKET` | Cloud provider Unix socket path |
| `INFERENCE_CLOUD_MODEL` | Cloud model ID |
| `INFERENCE_LOCAL_EMBED_SOCKET` | Embedding worker socket |
| `INFERENCE_LOCAL_SMALL_SOCKET` | Small inference worker socket |
| `INFERENCE_LOCAL_MEDIUM_SOCKET` | Medium inference worker socket |
| `INFERENCE_LOCAL_RERANK_SOCKET` | Reranker worker socket |
| `INFERENCE_TURN_TIMEOUT_MS` | Global turn timeout fallback for all profiles |
| `INFERENCE_LOCAL_SMALL_TIMEOUT_MS` | Small-profile turn timeout override |
| `INFERENCE_CLOUD_TIMEOUT_MS` | Cloud full-profile turn timeout override |
| `INFERENCE_CLOUD_MAX_TIMEOUT_MS` | Cloud max-profile turn timeout override |
| `AGENT_MAIL_DB` | Transport database path |
| `AGENT_JOBS_DB` | Job queue database path |
| `AGENT_MEMORY_DB` | Memory database path |
| `AGENT_STATE_DB` | Agent state database path |

## Project Tooling

Two distinct tool surfaces — do not confuse them:

### Dev tools (used to build and evolve this repo)
Provisioned via flox flakes. Available on the development path:

- **`sd`** (seeds) -- issue tracker under `./.seeds/`
- **`ml`** (mulch) -- durable knowledge records under `./.mulch/`
- **`tl`** (trellis) -- specs, plans, handoffs under `./.trellis/`
- **`cn`** (canopy) -- prompt management and sub-agent spawning under `./.canopy/`
- **`fx`** (flox env) -- env manifest and lock under `./.flox/env/`
- **`phloem`** -- minimal inter-agent message log under `./.phloem/` (source: `.llm/skills/coordinating-agents/`)
- `git`, `gh`, `bun`, plus standard Linux (`diff`, `patch`, `grep`/`rg`, `find`, `jq`, `awk`, `sed`)

### Runtime binaries (produced by this repo, used at runtime by a running fleet)
Not available during development and must not be referenced by dev workflows:

- `agent-mail`, `agent-state`, `agent-jobs`, `agent-memory`, `agent-runtime`, `operator-console`
- `fleet`, `fleet-librarian`, `inference-cloud-anthropic`, `inference-cloud-google`, `inference-cloud-openai`, `inference-cloud-openrouter`
- `inference-local-embed`, `inference-local-rerank`, `inference-local-small`, `inference-local-medium`, `fleet-reporter`

Agent behavior contract: `AGENTS.md` (symlinked as `CLAUDE.md`, `GEMINI.md`, `CODEX.md` → `.llm/AGENTS.md`).
Workflow runbooks: `.llm/skills/<workflow>/SKILL.md` (surfaced to each CLI via `.claude/skills`, `.gemini/skills`, `.codex/skills` symlinks).

## Branching model

Two-tier, with a local shadow branch so `main` stays clean.

- **`main`** — matches `origin/main`. Only ever fast-forwards. Never accumulates merge commits locally.
- **`integration`** — long-lived local shadow branch in its own worktree (`worktrees/integration`). Feature branches merge here via `git merge --no-ff`. Revertable without touching `main`.
- **`<slug>`** — feature branch per seeds issue, lives in `worktrees/<slug>`.

### Tier 1: local merge (default)
Feature branch → `integration` via `git merge --no-ff`. Inter-agent review via branch checkout + diff, no GitHub round-trip. Rollback is `git revert` on `integration`.

### Tier 2: GitHub PR
When external review / CI / human sign-off is required: `gh pr create` against `main`, skip the tier-1 merge. Land via `gh pr merge --squash --delete-branch` on operator approval.

### Publishing
`integration` promotes to `main` via `git merge --ff-only integration` at a milestone. Push `main` to publish.

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
