# §Schemas

## §AgentHarnessEvent
```json
{
  "id": "evt-001",
  "type": "AgentHarnessEvent",
  "event_type": "NewInboxMessage | SocialDigest | TaskCompleted",
  "source": "inbox:agent | volition:social_digests | AgentHarness",
  "content": "..."
}
```

## §IdentitySchema
Stored in `fleet_agent_identity`. Injected as §IDENTITY.
```json
{
  "agent_name": "...",
  "role": "Thinker | Scribe | Muscle",
  "mission": "...",
  "personality_profile": { "temperature": 0.7, "top_k": 40 }
}
```

## §ScratchpadSchema
Stored in `agent_scratchpads`.
```json
{
  "agent_name": "...",
  "content": "...",
  "updated_at": "..."
}
```

## §ConfigSchema
Stored in `fleet_configs`.
```toml
[fleet]
machete_limit = 20000
output_budget = 8000
turn_timeout_ms = 30000
```
