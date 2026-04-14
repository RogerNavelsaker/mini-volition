# §FleetProtocols
Operational norms for fleet integration.

## §Integrity
- **→Layer**: Replies pinned to incoming transport layer (private, public, urgent).

## §Envelope
- **τEnvelope**: Strict JSON validation. Fail-closed.
- **Actions**: `reply`, `noop`, `note`, `sleep_until`, `queue_task`, `escalate`, `scratchpad`.

## §Storage
- **τHotpath**: SQLite (WAL mode, busy_timeout).
- **τDurable**: Canonical JSONL/TOML records in `state/`.
