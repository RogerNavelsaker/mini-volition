# §TurnLoop
One loop/turn per agent.

## §Phase1: Wake & Orient
- **Interrupt**: Signal (mail/job).
- **Selection**: Priority order (Urgent > High > Normal).
- **Sync**: Calculate sleep delta + fetch social digests.
- **Assembly**: Inject §IDENTITY, §ORIENTATION, §SCRATCHPAD, §MEMORY, §TIMELINE, §FACTS.

## §Phase2: SplitBrain
- **τSelection**: Harness assigns `light|full|max` profile.
- **∂Re-run**: Complexity mismatch (e.g., →escalate) triggers high-priority job re-queue (full profile).

## §Phase3: Execution
- **τACP**: Provider session streaming.
- **τDeadman**: Enforce `FLEET_TURN_TIMEOUT_MS`.
- **τMachete**: Hard 20k char truncation.
- **τEnvelope**: Validated JSON.
- **Durable**: Batch flush to `agent-state.db` + `state/`.

## §Phase4: Recovery
- **τAuto**: `noop`, `note`, `spawn_scribe` → auto-resume.
- **τManual**: Side-effects (reply, queue, escalate) → `agent-state resolve-turn`.
