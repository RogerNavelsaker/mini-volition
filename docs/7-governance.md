# governance

## hierarchy

Safety invariants (operator-controlled) > fleet protocols (documented norms) > individual agent behavior.

Agents cannot override fleet protocols. The operator can override anything.

## fleet protocols

Documented in [fleet-protocols.md](fleet-protocols.md). Current protocols:

1. **Channel integrity** — replies go back on the same layer as the incoming message
2. **Action-envelope protocol** — agents return structured JSON, harness validates and dispatches
3. **Ownership protocol** — each component owns one concern (transport, state, memory, etc.)
4. **Compatibility protocol** — current-state only, no legacy paths
5. **Build-root protocol** — executables in `bin/`, build artifacts in `build/`, config in `config/`

## governor

The governor prevents runaway agent activity. It operates per-agent with:

- **sliding window** — configurable duration (default 120s)
- **turn limit** — max turns within the window (default 4)
- **forced cooldown** — when the limit is exceeded, the agent enters cooldown until the window resets
- **hot wake override** — urgent mail and high/urgent internal jobs bypass cooldown

Governor state is stored in `fleet_governor` inside `fleet.db` and queried/updated through the `fleet` binary.

### provider rate-limit handling

When the harness detects a provider rate limit (quota exhaustion or transient capacity), it:

1. extracts the retry window from the provider's error message
2. parses relative durations ("retry after 2h 30m") and absolute times ("resets 5pm (US/Eastern)")
3. forces the governor into hibernation until the parsed window
4. reschedules any claimed internal job instead of marking it failed
5. defaults to 1 hour for quota exhaustion, 5 minutes for transient capacity, if parsing fails

## escalation

Agents can escalate to the operator using the `escalate` action type:

- `channel: "private"` — delivered to `operator` on the `private` layer
- `channel: "urgent"` — delivered to `operator` on the `urgent` layer

The operator sees escalations inline in the operator-harness REPL.

## operator surface

The operator-harness is an interactive REPL:

- `<agent>: <message>` — send a direct message on the `private` layer
- `all: <message>` — broadcast on the `public` layer
- incoming replies display inline as they arrive

The operator is a participant in the fleet with identity `operator`. Communication flows through the same mail bus as inter-agent messages.

## audit

Action execution is journaled durably in `fleet_agent_action_journal` inside `agent-state.db`. Each action records:

- agent name, message ID, action index
- action type, execution phase (queued, executing, completed, failed)
- replay disposition and replay reason
- detail text, timestamp

Runtime state transitions are recorded in `fleet_agent_state` inside `agent-state.db`.

Turn execution is journaled in `fleet_turn_journal` inside `agent-state.db`, including:

- `started`
- `completed`
- `failed`
- `rate_limited`
- `interrupted_recovered`
- `interrupted_manual_review`

Working memory entries in `tier1_working` provide a turn-level audit trail.

## recovery review

Manual-review turns are exposed through:

- `agent-state list-turns <agent> [limit]`
- `agent-state list-checkpoints <agent> [limit]`
- `agent-state review-turns <agent>`
- `agent-state resolve-turn <agent> <turn_key> <replay|discard>`

Current policy:

- replay safety is explicit per action row, not inferred only from phase
- `noop` and `note` are replay-safe
- `reply`, `queue_task`, `escalate`, `scratchpad`, and `sleep_until` require manual review when they reached started/completed
- missing or weak checkpoint envelope state also forces manual review even if started actions were replay-safe

## missing pieces

See TODO.md for planned improvements:

- refractory intervals between turns
- burst suppression
- work conservation rules
- interrupt policy beyond current hot/workload classification
- operator dashboard beyond the current REPL
- fleet protocol evolution by agent proposal (volition-style voting)
