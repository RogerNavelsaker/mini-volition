# §TurnLoop
One loop/turn per replicant.

## §Wake
- **τHotSenses**: urgent mail/direct mention/worker res/local wake/operator signal → bypass cooldown.
- **τRefractoryWorkload**: inbox backlog/due todo → only when cool.
- **∆Cooldown**: ordinary workload done → governor refractory window.
- **Priority**: urgent > high > normal; current trigger preserved in ctx.

## §CtxAssembly
- **[NOW]**: authoritative runtime datetime every turn.
- **[ORIENT]**: sleep delta + last conscious state + digest/catch-up ctx when useful.
- **[CLIP]**: TOON preferred; full clipboard every turn, even empty.
- **[TODO]**: TOON preferred; due-now/overdue only; broader inspection → `todo list`.
- **[MEM]**: selected working/LTM; deliberate lookup → `memory recall`.
- **[BURST]**: current event/message batch; primary interpretation target; TOON/compact rows preferred for multi-message bursts.
- **τMachete**: tool/model output → bounded ctx; truncation marked.
- **[REM]**: terse budget/reply/envelope line.

## §CtxTDD
- **Rule**: assembled turn ctx uses bounded TDD because replicants read it every turn.
- **Blocks**: labeled blocks first, payload second.
- **ShortLabels**: use `[NOW]`, `[ORIENT]`, `[CLIP]`, `[TODO]`, `[MEM]`, `[BURST]`, `[WM]`, `[REM]` in assembled ctx.
- **CacheStability**: keep static prefix/docs stable; put volatile turn blocks after cached doctrine so provider prompt caches hit.
- **StateBlocks**: clipboard/todos/burst use TOON tables when flat; datetime uses a tiny JSON/object line.
- **RowBlocks**: burst, working memory, traces, and history-like sections use TOON-style rows when repeated.
- **EmptyState**: explicit empty payloads (`entries: []`) beat prose such as `(empty)` when shape matters.
- **Warnings**: warning fields live inside the relevant JSON block.
- **CurrentImpl**: `§SCRATCHPAD` remains acceptable while runtime action/storage still says scratchpad; preferred label is `[CLIP]`.

## §Model
- **τProfile**: harness assigns `light|full|max`.
- **∆Rerun**: light mismatch/privileged need/complex work/escalation → fuller profile queue.
- **τTimeout**: `INFERENCE_TURN_TIMEOUT_MS` default; per-profile overrides allowed.

## §Exec
- **∂Envelope**: strict JSON action envelope; malformed/unknown → fail closed.
- **IntentLog**: durable turn intent before dispatch.
- **Dispatch**: side effects, async queues, result normalization.
- **OutcomeLog**: durable outcome patch.
- **SelfWake**: async completion → local wake with `req_id`/event.

## §Continuity
- **Evidence**: truncated/partial/rejected/failed/stale surfaced honestly.
- **SleepHibernate**: pending work → complete | queue | snooze | clipboard/todo.
- **GhostRecovery**: pending intent → visible recovery event.
