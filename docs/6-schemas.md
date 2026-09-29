# §Schemas

## τEvent
Harness-owned wake record.
```json
{
  "id": "evt-001",
  "type": "AgentHarnessEvent",
  "agent": "replicant-id",
  "datetime": "2026-05-01T12:00:00+02:00",
  "event_type": "NewInboxMessage | SocialDigest | TaskCompleted | OperatorSignal",
  "source": "mail | chat | todo | worker | harness",
  "content": {}
}
```

## τIdentity
Stored: `fleet_agent_identity`. Injected: identity ctx.
```json
{
  "canonical_id": "replicant-uuid",
  "agent_name": "technical-name",
  "friendly_name": "optional-genesis-name",
  "role": "replicant | worker | muscle",
  "class": "devops-replicant | code-replicant | personal-assistant",
  "profile": "light | full | max",
  "mission": "...",
  "personality_profile": { "temperature": 0.7, "top_k": 40 }
}
```

## τTurnLog
Two-phase durable intent/outcome.
```json
{
  "id": "turn-001",
  "type": "ReplicantTurn",
  "agent": "replicant-id",
  "parent_event_id": "evt-001",
  "datetime_intent": "2026-05-01T12:00:00+02:00",
  "datetime_outcome": "2026-05-01T12:00:02+02:00",
  "status": "pending | completed | rejected | failed",
  "summary": "...",
  "action": {},
  "result": {}
}
```

## ∂SharedToolEnvelope
Shared result envelope.
```json
{
  "req_id": "harness-minted-id",
  "status": "accepted | completed | rejected | failed",
  "detail": "optional-submode",
  "content": {}
}
```
- **status**: routing only.
- **detail**: compact typed submode: `input_invalid|anchor_invalid|unsupported_type|timeout|denied`.
- **content**: result/evidence/diagnostic text; markdown allowed.
- **batch**: JSONL only; each object independent req/res.

## ∂ToonEdge
Harness/model edge uses TOON for flat tool reqs; harness decodes to JSON then validates.
```toon
file.read[1]{path|after|limit}:
  "README.md"||2000
```
```toon
web.search[3]{query|limit|after|before}:
  "mini-volition TOON context"|5||
  "prompt caching LLM harness"|5|2026-01-01|
  "hashline edit format"|10||
```
- **shape**: `<family>.<verb>[n]{field|field}:`.
- **row**: one row = one request.
- **single**: use `[1]`.
- **optional**: blank cell.
- **rows**: flat top-level fields; one object maps cleanly to one row.
- **decode**: TOON → flat JSON object(s).
- **validate**: same schema/fail-closed path as JSON.
- **persist**: canonical JSON/JSONL.

## τDatetimeWrapper
Read/search/history/list result wrapper for timestamped result content.
```json
{
  "datetime": "2026-05-01T12:00:00+02:00",
  "entries": []
}
```

## τCurrentDatetimeCtx
Injected every turn.
```json
{
  "datetime": "2026-05-01T12:00:00+02:00"
}
```

## τClipboard
Storage: `replicant_clipboards`; current term: clipboard.
```toon
clipboard[2]{index|content}:
  1|"Use [NOW]/[CLIP]/[TODO] short ctx labels"
  2|"Harness decodes TOON to JSON then validates schema"
```
- **ctx_label**: `[CLIP]`.
- **alias**: `[ACTIVE_CLIPBOARD]`.
- **injection**: every ordinary turn; full current state; even empty.
- **empty**: `{ "entries": [] }`.
- **warning**: inside JSON only; present only near capacity.

## τTodo
Injected due todos + `todo list` entry shape.
```toon
todo[1]{id|content|due}:
  task-001|"review prompt cache plan"|"2026-05-01T15:00:00+02:00"
```
- **ctx_label**: `[TODO]`.
- **alias**: `[CURRENTLY_DUE_TODOS]`.
- **injection**: due-now/overdue only.
- **empty**: `{ "entries": [] }`.
- **cap**: 10 injected entries; use `truncated` and optional `remaining` when more exist.

## τBurstCtx
Current wake event/message batch.
```toon
[2]{datetime,source,sender,layer,content}:
  "2026-05-01T12:00:00+02:00",mail,operator,private,"message text"
  "2026-05-01T12:00:01+02:00",chat,peer,public,"message text"
```
- **ctx_label**: `[BURST]`.
- **priority**: primary interpretation target.
- **format**: TOON-style rows preferred for multi-message bursts.

## τReminderCtx
Terse turn constraints.
```text
[REM] budget=8000 reply→private→operator envelope=json
```
- **purpose**: cheap operational reminder only.
- **style**: behavioral prose lives in system prompt/docs.

## τMemoryRecall
`memory recall` → compact text entries; rank/confidence stay harness-internal.
```json
{
  "datetime": "2026-05-01T12:00:00+02:00",
  "entries": [
    {
      "type": "semantic | episodic | procedural | artifact | mail | chat | file",
      "title": "short label",
      "content": "excerpt or compact record",
      "source_ref": "path/mail/chat/artifact/ref",
      "datetime": "2026-05-01T11:00:00+02:00"
    }
  ],
  "unapplied": []
}
```

## τFileRead
Replicant-facing file read exposes anchors.
```json
{
  "datetime": "2026-05-01T12:00:00+02:00",
  "path": "/abs/path",
  "lines": [
    { "anchor": "a1b2", "text": "line text" }
  ],
  "truncated": false
}
```

## τShellResult
Shell output = execution evidence.
```json
{
  "stdout": "...",
  "stderr": "...",
  "exit_code": 0,
  "duration_ms": 1200
}
```

## τConfig
Stored: `fleet_configs`. Mirrored: `config/fleet.toml`.
```toml
[fleet]
machete_limit = 20000
output_budget = 8000
turn_timeout_ms = 30000
```
