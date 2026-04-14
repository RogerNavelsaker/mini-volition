# §Philosophy

Mini-Volition: local-first, autonomous, multi-agent runtime.

## §Principles
- **Local-First**: Host-node execution. SQLite transport/state. Socket-based inference workers.
- **Peers**: Harness-managed agents; memory/job queues are agent-local.
- **Harness-Authority**: Body (harness) owns transport/wake/validation; Mind (agent) owns reasoning.
- **Current-State**: Projection-based; durable JSONL append-first records; SQLite hotpath acceleration.
- **Lossy-Persistence**: Tiered compaction; promote archival lessons, decay unused memory.

## §SplitBrain
- **τProfile**: Harness-assigned `light|full|max` per turn.
- **τOffload**: Dedicated CPU-bound socket workers (`fleet-embed`, `fleet-rerank`, `fleet-light`, `fleet-heavy`).
- **τScribe**: Fire-and-forget sub-task delegation.

## §Orientation
- **→Target**: Inject §IDENTITY, §ORIENTATION, §SCRATCHPAD, §MEMORY, §TIMELINE on wake.
- **τScratchpad**: Persistent agent-managed state in `runtime/scratchpads/`.
- **τSubscriptions**: Dynamic transport channel monitoring.
