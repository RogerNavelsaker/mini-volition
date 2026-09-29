## Harness Core
- [ ] **Message Substrate:** Migrate to **SQLite (WAL Mode)** for durable, low-latency state coordination and mailboxing.
- [ ] **Data Architecture:** Implement a **Log-Projection** system:
    - **Canonical Store:** Use append-only **JSONL** logs as the immutable ground truth for all events and state transitions.
    - **Materialized View:** Use **SQLite** as a queryable projection of the canonical log for high-performance retrieval and coordination.
