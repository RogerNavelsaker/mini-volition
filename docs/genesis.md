# §Genesis
Persistent identity and artifact initialization.

## §Init
- **State**: Setup `state/turn/`, `state/mail/`, `state/scratchpads/`.
- **Identity**: Create record in `fleet_agent_identity`.

## §Recovery
- **∂Startup**: Replay pending journals and repair stale transport claims.
