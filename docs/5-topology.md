# §Topology
Static runtime services with dynamic replicant expansion.

## §Roster
- **τReplicant**: Persistent cloud-backed actor selected by harness profile.
- **τWorker**: Temporary offload actor. Reports back and exits.
- **τScribe**: Current `spawn_scribe` path; current surface folds into `worker invoke`.
- **τMuscle**: Local inference workers for embed, rerank, light, and medium workloads.
- **τInfra**: `mail`, `scheduler`, `memory`, `state`, `conversation-reporter`, `replicant-dreaming`.
- **τConversationReporter**: Shared service that consolidates gossip/conversation into prepared digest/report/summary records.
- **τDreaming**: Background memory upkeep analogous to Claude Code `/dream`: extraction, repair, compaction, clean-index, and consolidation.
- **τOperator**: Human control surface and escalation target.

## §WorkerInvoke
- **Surface**: Current surface uses `worker invoke`.
- **Types**: `scribe`, `roamer`, and `ami`.
- **AMI Tasksets**: `reviewer`, `planner`, `researcher`, `validator`.
- **Boundary**: Worker authority is invocation-scoped and expires with the invocation.
- **Result**: Worker outputs return through ordinary messaging/result flow with `req_id`.

## §ReplicantLifecycle
- **Spawn**: `replicant spawn` creates a persistent clone from genesis lineage.
- **Mandate**: Parent supplies inline free-form directions; harness assembles genesis package.
- **CarryDefault**: Spawn carries memory/doctrine by default; working state starts fresh.
- **FriendlyName**: New replicant chooses friendly/display name only during genesis/early boot.
- **Respawn**: `replicant respawn` requests re-grounding or restoration; operator `regenesis` performs privileged doctrine/protocol replacement.
- **Despawn**: `replicant despawn` requests retirement or removal; operator `degenesis` performs privileged identity termination.

## §Territory
- **Default**: Spawn into same territory/runtime ctx by default; explicit override selects another territory.
- **CrossTerritory**: Allowed when policy grants it; devops-replicant owns broad cross-territory authority.
- **Migration**: Modeled as clone-to-new-territory plus `replicant despawn` request for the old instance; privileged termination remains `degenesis`.
- **Reassignment**: Jobs/mail can be reclaimed or rescheduled on hibernation, failure, or migration.
