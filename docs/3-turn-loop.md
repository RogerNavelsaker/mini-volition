# turn loop

The agent-harness runs one turn loop per agent. This document describes the cycle.

## phase 1: wake and select

The harness blocks until a wake source is ready.

Wake sources, in priority order:

1. urgent mail (priority 100)
2. urgent internal jobs (priority 90)
3. private mail (priority 80)
4. high internal jobs (priority 70)
5. public mail (priority 60)
6. normal internal jobs (priority 50)
7. low internal jobs (priority 30)

Selection logic:

- peek both mail and job queues without claiming
- compare priorities; highest wins
- claim the winner atomically
- if nothing is ready and the agent is not in cooldown, block on mail listen
- during cooldown, only hot wakes (urgent mail, urgent/high jobs) are processed

The selected source produces a `WakeEvent` with: source type, wake reason, priority, wake class (hot vs workload), and the claimed burst.

## phase 2: model selection (split-brain)

The harness selects model tier and effort/reasoning level for this turn based on the wake event.

| signal | mode |
|---|---|
| public mail, low-priority job, status check | light (lower effort, cheaper model) |
| private mail, normal job | full (standard effort) |
| urgent mail, high/urgent job, escalation | max (maximum effort/reasoning) |

ACP allows configuring model and effort per session. The harness sets these before sending the prompt.

The harness now selects `light`, `full`, or `max` before `session/new`, using the local model when available and deterministic fallback otherwise. Automatic re-run/escalation from `light` to `full`/`max` is a follow-on policy step, not yet automatic.

## phase 3: governor check

Before executing a turn, the harness checks the governor.

The governor tracks per-agent:

- turn count within a sliding window
- forced cooldown deadline
- last reason for cooldown

If the agent has exceeded its turn limit for the window, the governor forces a cooldown. During cooldown, only hot wakes proceed.

After each completed turn, the harness bumps the governor turn counter.

## phase 4: context assembly

The harness builds a `TurnAssembly`:

- **sleep delta** — seconds since the agent's last recorded action
- **inbound burst text** — formatted messages from the claimed burst
- **long-term memory** — archival reflections (from agent-memory if available, recency fallback otherwise)
- **recent memory** — episodic summaries and social digests
- **working memory** — last 5 tier-1 working log entries
- **memory selection** — description of how memory was assembled (hybrid retrieval vs recency fallback)

If prepared memory artifacts are stale or missing, the harness fires an async refresh.

Recalled artifact IDs are collected for post-turn reinforcement.

## phase 5: prompt rendering

The harness renders a token-dense prompt using TDD-inspired shorthand (§ section, ∂ delta, τ type, → target, ↑ escalate). Each memory section is independently budget-capped by priority tier before injection.

### section budgets (priority-tiered)

| tier | sections | behavior |
|---|---|---|
| P1 (critical) | inbound burst, action envelope schema | uncapped — always included in full |
| P2 (high) | archival reflections, working memory | capped (default 3000 chars each) |
| P3 (normal) | episodic summaries, public digests | capped (default 2000/1500 chars) |

Budgets are applied per-section, not as a global limit. Items that don't fit within a section's budget are truncated with `…`. This prevents one verbose archival entry from starving episodic context.

### output budget directive (CEP-inspired)

The prompt tells the agent its response budget (default 8000 chars). This is advisory — the agent should self-regulate for conciseness. The machete (phase 7.5) enforces the hard limit.

### prompt structure

```
§TURN agent=<name>
§LTM                    — archival reflections (P2 budget)
§CTX ∂sleep=Ns ...      — context line: sleep delta, queue state, memory selection
§DIGEST                 — public digest summaries (P3 budget)
§EPISODIC               — personal episodic memories (P3 budget)
§SCRATCHPAD N/cap       — agent's persistent notepad (P2 budget), with cap warning
§WM                     — working memory log (P2 budget)
§POLICY                 — statelessness, recency override, output budget
§ENVELOPE               — compact JSON schema, τ-prefixed action types, rules
§BURST                  — the actual inbound messages (P1, uncapped)
```

### format conventions

- Agent input: compact JSON (no unnecessary whitespace)
- Agent output: compact JSON envelope
- Operator display: TOON-style tabular rendering for action summaries
- Durable storage: JSONL for structured records, markdown for human-readable doctrine
- SQLite: acceleration layer / hot-path buffer only (petiole pattern — canonical files are authoritative)
- current durable artifact root: `state/`
- action journal and turn/checkpoint projection are flushed in grouped batches through `agent-state` to avoid per-row commit storms

## phase 6: ACP execution

The harness spawns the agent process and communicates via ACP (JSON-RPC over stdin/stdout):

1. `initialize` — protocol handshake
2. `session/new` — create session with cwd, model/effort selection
3. `message/send` — send the rendered prompt
4. stream `session/update` chunks as the agent responds
5. `session/stop` — close session

Stderr and non-JSON stdout are captured as diagnostic buffer. The harness monitors this buffer in real time for provider rate-limit signatures.

### rate-limit handling

If the diagnostic buffer matches a rate-limit pattern (429, quota exhausted, capacity unavailable), the harness:

1. kills the agent process immediately
2. extracts the retry/reset window from the limit message
3. parses both relative durations ("retry after 2h 30m") and absolute times ("resets 5pm (US/Eastern)")
4. forces the governor into hibernation until the parsed window
5. if the wake source was an internal job, reschedules it instead of marking it failed

### deadman handling

ACP execution is also bounded by a hard deadman timeout (`FLEET_TURN_TIMEOUT_MS`).

If a turn exceeds that timeout, the harness:

1. kills the ACP client process
2. records the turn as failed in `fleet_turn_journal`
3. updates runtime state to error
4. alerts `operator`

## phase 7: output machete

Before envelope parsing, the harness applies a hard character limit (default 20000 chars, configurable via `FLEET_MACHETE_LIMIT`). If the agent's response exceeds this limit:

1. truncate at the limit
2. append `[TRUNCATED BY HARNESS — output exceeded budget]`
3. log the truncation event
4. record in working memory

This mirrors volition's GUPPI output machete. The advisory output budget in the prompt (phase 5) should prevent most truncations — the machete is a safety net.

## phase 8: envelope parsing and validation

The harness extracts JSON from the (possibly macheted) response text (plain or fenced in ```json```).

Validation is strict and fail-closed:

- envelope must be a JSON object with an `actions` array
- each action must match a known type with correct required fields
- unknown fields, unknown action types, and malformed values all reject the entire envelope
- no actions execute if any action is invalid

## phase 9: action dispatch

Valid actions are executed in order. Each action is journaled with phases (`planned`, `started`, `completed`, `failed`).

| action | behavior |
|---|---|
| `reply` | send message to original sender on original layer via agent-mail |
| `noop` | no effect, recorded in journal |
| `note` | recorded in tier-1 working memory |
| `sleep_until` | update runtime state, sleep until deadline, then resume wake loop |
| `queue_task` | queue an internal job via agent-jobs (optionally to another agent, with priority and scheduled time) |
| `escalate` | send message to `operator` on `private` or `urgent` |
| `scratchpad` | mutate the agent's persistent scratchpad |

After dispatch:

- bump governor turn counter
- record assistant response in tier-1 working memory
- record episodic entry for the turn
- fire async memory refresh
- reinforce recalled memory artifacts asynchronously
- update runtime state (idle or cooldown depending on governor)

### interrupted-turn replay policy

Turn recovery is action-aware.

- stale started turns with no started side-effect actions are auto-replayed
- replay policy is taken from action-journal replay metadata
- `noop` and `note` are treated as safe
- started/completed `reply`, `queue_task`, `escalate`, `scratchpad`, and `sleep_until` are held for manual review
- turns without strong checkpoint state (`prompt_built|validated|completed|rate_limited`) are also held for manual review

Manual recovery surfaces:

- `agent-state list-turns <agent> [limit]`
- `agent-state list-checkpoints <agent> [limit]`
- `agent-state review-turns <agent>`
- `agent-state resolve-turn <agent> <turn_key> <replay|discard>`

## phase 10: loop

Return to phase 1.
