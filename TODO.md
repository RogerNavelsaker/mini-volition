# Active Development Targets

## Tier 1: Highest Leverage

### Extend the queue-backed dispatcher
Build on the validated execution contract. The harness should extend the typed dispatcher action-by-action, record execution results in working memory, build replay/resume behavior on top of the existing durable action journal, and stay fail-closed on malformed envelopes. One shared turn-execution path across wake classes.

### Richer job semantics
Evolve `agent-jobs` toward fuller agent-local work state. Base blocked/waiting/cancelled states exist. Next: dependencies between jobs, unblock policy, richer wait metadata, operator/debug views over non-runnable jobs, queue cancellation and rescheduling actions.

### Split-brain per-profile retry/timeout
Deterministic and local-model-assisted turn profile selection exists. Light-to-full re-run exists. Next: clearer per-profile retry and timeout policy so `light` turns have shorter deadman timeouts and `max` turns get more headroom.

## Tier 2: Wake & Governor

### Refractory scheduler
Per-source cooldown groups instead of just global governor cooldown. Volition groups wake sources into always-hot (streams, internal queue) and refractory (inbox, alarms) with random 10-30s cooldown per group. Fleet has governor-level cooldown but no per-source groups.

### Multi-source wake orchestration
Current wake sources: internal jobs and agent-mail. Need a unified wake model adding: alarms, reminders, local subprocess completions, internal wake events. The blocking wait currently falls back to mail listen when no source is ready.

### Stronger governor
Current governor covers cooldown and provider rate limits only. Need: refractory intervals, urgent override rules, interrupt policy, burst suppression, work conservation rules, resume behavior after provider hibernation.

## Tier 3: Memory Evolution

### Entity description merging
When the same entity appears across compaction cycles, merge descriptions into a canonical entity record. Currently facts from different source items with the same subject coexist without consolidation. Lower priority at current volume.

### Raw-mode memory option
All memory goes through summarization before storage. Raw verbatim fragments for recent tiers with compaction only on promotion to archival would hedge against lossy summarization. Especially relevant for entity extraction quality.

### Graph-aware retrieval with token budgets
Move budget awareness into the retrieval step. Stop entity/relation/chunk expansion once respective budgets are exhausted instead of applying budgets after retrieval. Push `budgetSection()` down into `agent-memory lookup`.

### Proactive context loading
Pre-fetch memory artifacts based on agent's `current_task` from state before the burst arrives. If the current task mentions specific entities, pre-fetch all facts and links involving those entities.

## Tier 4: Topology & Protocol

### Dynamic channel subscriptions
Agents subscribe/unsubscribe to project-specific channels. Currently all agents see all layers.

### Focus protocol
Unsubscribe from noise channels during deep work with auto-resubscribe reminder after a deadline.

### Fleet protocol evolution
Agents propose and vote on protocol changes. Currently protocols are operator-authored only.

### Self-repair and dynamic topology
Harness detects repeated failures on a task, reassigns work to a different agent, requests operator approval to add capacity. Extension of existing escalation and job-reschedule paths.

## Tier 5: Housekeeping

### Soft-delete with GC
Add a GC phase to the librarian's maintenance loop that drops artifacts with `status = 'compacted'` older than a configurable retention period and cleans up orphaned FTS5 entries and search index rows.

### Hierarchical context propagation
Attach project/task/subtask context to memory artifacts so retrieval can filter or boost by ancestry, not just content similarity.

### Contradiction detection (model + deterministic)
Model proposes likely conflicts, exact invalidation rules confirm or reject. Currently only manual `agent-memory invalidate` exists.

### Escalation severity/routing (model + policy)
Model suggests channel/urgency, deterministic policy enforces floor/ceiling. Currently escalation always routes to `operator` on `private` or `urgent`.

## Design Principles

When optional intelligence is useful, prefer: local model first, weaker optional fallback second, deterministic last-resort fallback.

Good candidates for "smart when it can, deterministic when it must":
- Contradiction detection
- Escalation severity/routing
- Wake classification
- Compaction promotion gating
